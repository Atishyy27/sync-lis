#!/usr/bin/env bash
# Everything, in one run: local suites, adversarial cases against the deployed
# relay, a concurrent-load benchmark, an idle soak, and live endpoint health.
#
# Each stage prints PASS/FAIL and the run ends with a consolidated table plus a
# non-zero exit if anything failed, so this is the single command to trust
# before shipping a build.
#
#   bash tools/smoke-all.sh            # everything
#   bash tools/smoke-all.sh --quick    # skip the slow idle soak
#
# Stages that hit the deployed Worker cost WebSocket upgrades against the free
# 100k/day quota (roughly 150 per full run). That is why they are not in
# `npm test`, which must stay runnable offline.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

RELAY_WS="wss://sync-lis-relay.sync-lis-relay.workers.dev"
RELAY_HTTP="https://sync-lis-relay.sync-lis-relay.workers.dev"
STORE="https://chromewebstore.google.com/detail/hcpjipoofgpnenpfjddkkodbobehonlb"

names=(); codes=(); notes=()
record() { names+=("$1"); codes+=("$2"); notes+=("$3"); }

hr() { printf '%.0s-' {1..64}; echo; }
say() { echo; hr; echo "  $1"; hr; }

# ---------- the local server the browser suites need ----------
say "0. local dev server"
if curl -sk -m 5 -o /dev/null -w '%{http_code}' https://localhost:7777/ | grep -q 200; then
  echo "already up"
else
  echo "starting it..."
  powershell -NoProfile -Command \
    "\$d='$(pwd -W 2>/dev/null || pwd)'; Start-Process node -ArgumentList 'server.js' -WorkingDirectory \$d -WindowStyle Hidden" \
    >/dev/null 2>&1
  for _ in $(seq 1 15); do
    curl -sk -m 3 -o /dev/null -w '%{http_code}' https://localhost:7777/ | grep -q 200 && break
    sleep 2
  done
fi
if curl -sk -m 5 -o /dev/null -w '%{http_code}' https://localhost:7777/ | grep -q 200; then
  echo "server -> up"; record "local dev server" 0 "https://localhost:7777"
else
  echo "server -> DOWN (browser suites will fail)"; record "local dev server" 1 "could not start"
fi

# ---------- live production endpoints ----------
say "1. live endpoints"
stats=$(curl -s -m 20 "$RELAY_HTTP/stats" 2>/dev/null)
echo "GET /stats        -> ${stats:-<no response>}"
echo "$stats" | grep -q activeRooms && record "relay /stats" 0 "$stats" || record "relay /stats" 1 "no response"

room_page=$(curl -s -m 20 "$RELAY_HTTP/r/ABC12" 2>/dev/null)
if echo "$room_page" | grep -q "Add sync-lis to Chrome"; then
  echo "GET /r/<code>     -> serves the join page with the install button"
  record "room link + install funnel" 0 "install CTA present"
else
  echo "GET /r/<code>     -> MISSING the install button"
  record "room link + install funnel" 1 "no install CTA"
fi

store_code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -L "$STORE")
echo "store listing     -> HTTP $store_code"
[[ "$store_code" == "200" ]] && record "chrome web store listing" 0 "HTTP 200" \
                             || record "chrome web store listing" 1 "HTTP $store_code"

# ---------- the packaged artifact, not the source tree ----------
say "2. shipping artifact"
ver=$(node -p "require('./extension/manifest.json').version" 2>/dev/null)
zip="dist/cws/sync-lis-v${ver}.zip"
echo "manifest version  -> $ver"
if [[ -f "$zip" ]]; then
  relay_in_zip=$(unzip -p "$zip" popup.js 2>/dev/null | grep -o 'https://[^"]*' | head -1)
  icons_in_zip=$(unzip -l "$zip" 2>/dev/null | grep -c 'icons/icon')
  desc_len=$(unzip -p "$zip" manifest.json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).description.length))")
  echo "packaged relay    -> $relay_in_zip"
  echo "icons in zip      -> $icons_in_zip"
  echo "description       -> $desc_len chars (Chrome caps at 132)"
  fail=0
  echo "$relay_in_zip" | grep -q 'workers.dev' || { echo "  !! zip does not point at the cloud relay"; fail=1; }
  [[ "$icons_in_zip" -ge 4 ]] || { echo "  !! missing icons"; fail=1; }
  [[ "$desc_len" -le 132 ]] || { echo "  !! description too long, store will reject"; fail=1; }
  record "packaged zip v$ver" "$fail" "$zip"
else
  echo "no zip at $zip (run: npm run pack)"
  record "packaged zip v$ver" 1 "missing"
fi

# ---------- suites ----------
say "3. full local suite (npm test)"
# Keep the whole run, then show the tail AND every failure. Piping straight to
# `tail` hid which suite failed on the first real run of this script, which is
# the one thing the operator actually needs to see.
suite_log=$(mktemp)
npm test >"$suite_log" 2>&1
suite_code=$?
tail -25 "$suite_log"
if [[ "$suite_code" != "0" ]]; then
  echo
  echo "  --- failures in this run ---"
  grep -nE "^FAIL" "$suite_log" | head -20
  echo "  --- suite that failed ---"
  awk '/^=== /{s=$0} /^FAIL/{print "  " s; exit}' "$suite_log"
  echo "  full log kept at: $suite_log"
fi
record "npm test" "$suite_code" "246 checks"

say "4. adversarial border cases vs production"
npm run test:border --silent 2>&1 | tail -8
record "npm run test:border" "${PIPESTATUS[0]}" "malformed / flood / xss / traversal"

say "5. concurrent load vs production"
npm run test:load --silent 2>&1 | tail -10
record "npm run test:load" "${PIPESTATUS[0]}" "40 rooms x 3 peers"

if [[ "$QUICK" == "0" ]]; then
  say "6. idle soak (slow: ~2 min of deliberate silence)"
  node test/idle-soak.js --idle 70 2>&1 | tail -8
  record "idle soak" "${PIPESTATUS[0]}" "70s quiet room"
else
  echo; echo "(skipping idle soak: --quick)"
fi

# ---------- verdict ----------
say "SMOKE SUMMARY"
failed=0
for i in "${!names[@]}"; do
  if [[ "${codes[$i]}" == "0" ]]; then mark="PASS"; else mark="FAIL"; failed=$((failed + 1)); fi
  printf '  %-4s  %-32s  %s\n' "$mark" "${names[$i]}" "${notes[$i]}"
done
hr
if [[ "$failed" == "0" ]]; then
  echo "  ALL ${#names[@]} STAGES GREEN"
else
  echo "  $failed of ${#names[@]} STAGES FAILED"
fi
hr
exit "$failed"
