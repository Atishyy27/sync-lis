// Fallback public relay, for when Tailscale isn't an option.
//
// The permanent address is a Tailscale Funnel (see README) and needs nothing
// running here. This script is the escape hatch: it opens a Cloudflare quick
// tunnel, which needs no account but mints a NEW URL every time — so it also
// rewrites the constant in the extension and tells you to reload it.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const POPUP = path.join(__dirname, "extension", "popup.js");
const CANDIDATES = [
  "cloudflared",
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
];

const exe = CANDIDATES.find((p) => p === "cloudflared" || fs.existsSync(p));

console.log("opening a temporary public relay…");
console.log("(the permanent one is `tailscale funnel` — see the README)\n");
const proc = spawn(exe, ["tunnel", "--url", "https://localhost:7777", "--no-tls-verify"], { windowsHide: true });

let done = false;
function onOutput(chunk) {
  const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!m || done) return;
  done = true;
  const url = m[0];
  const src = fs.readFileSync(POPUP, "utf8");
  const next = src.replace(/const RELAY = "[^"]*";/, `const RELAY = "${url}";`);
  if (next === src) {
    console.log(`relay is up: ${url}`);
    console.log("(couldn't find the RELAY constant in extension/popup.js — set it by hand)");
    return;
  }
  fs.writeFileSync(POPUP, next);
  console.log(`  relay:  ${url}`);
  console.log(`\n  Baked into the extension. Now:`);
  console.log(`   1. chrome://extensions -> reload sync-lis`);
  console.log(`   2. Start a room, send the link\n`);
  console.log(`  Keep this window open — closing it kills the public link.\n`);
}

proc.stdout.on("data", onOutput);
proc.stderr.on("data", onOutput); // cloudflared prints the URL on stderr
proc.on("close", (code) => console.log(`relay closed (${code})`));
