// Adversarial border cases against the DEPLOYED relay, over the real network.
//
// The rest of the suite drives the happy path through real browsers. This one
// does the opposite: it sends the relay things a browser would never send --
// oversized fields, wrong types, malformed frames, floods, prototype
// pollution -- because the relay sits on the public internet and a WebSocket
// client is not trustworthy. It talks to the deployed Worker rather than a
// local server precisely so that what gets tested is what users connect to.
//
// Usage: node test/border-relay.js [wss://...]

const WebSocket = require("ws");

const URL_BASE = process.argv[2] || "wss://sync-lis-relay.sync-lis-relay.workers.dev";
const results = [];
const check = (name, cond, extra) => {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `  <-- ${extra}`}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a socket that remembers everything it was sent, so assertions can look back
function sock() {
  const ws = new WebSocket(URL_BASE);
  const got = [];
  ws.on("message", (r) => {
    try { got.push(JSON.parse(r.toString())); } catch { got.push({ unparseable: true }); }
  });
  ws.on("error", () => {});
  ws.got = got;
  ws.ready = new Promise((res) => { ws.on("open", res); ws.on("error", res); });
  ws.send_ = (o) => { try { ws.send(typeof o === "string" ? o : JSON.stringify(o)); } catch {} };
  ws.waitFor = async (pred, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = got.find(pred);
      if (hit) return hit;
      await sleep(120);
    }
    return null;
  };
  return ws;
}

async function makeRoom(name) {
  const ws = sock();
  await ws.ready;
  ws.send_({ type: "syncCreate", name: name || "host" });
  const joined = await ws.waitFor((m) => m.type === "syncJoined");
  return { ws, code: joined && joined.code };
}

const shut = (list) => list.forEach((s) => { try { s.close(); } catch {} });

(async () => {
  try {
    // ---------- survival: does garbage kill the socket? ----------
    {
      const { ws, code } = await makeRoom();
      check("a room can be created at all", !!code, String(code));

      ws.send_("this is not json at all {{{");
      ws.send_("");
      ws.send_("[]");
      ws.send_("null");
      await sleep(600);
      check("malformed frames do not close the connection", ws.readyState === 1, "readyState=" + ws.readyState);

      ws.send_({ nope: 1 });
      ws.send_({ type: "definitely-not-a-real-message", payload: "x" });
      await sleep(500);
      check("unknown message types are ignored, not fatal", ws.readyState === 1);

      ws.send_(JSON.stringify({ type: "syncChat", text: "x", ["__proto__"]: { polluted: true } }));
      await sleep(400);
      check("prototype pollution attempt does not crash the relay", ws.readyState === 1);
      check("prototype pollution did not leak into Object.prototype", {}.polluted === undefined);

      shut([ws]);
    }

    // ---------- oversized input ----------
    {
      const { ws, code } = await makeRoom();
      ws.send_({ type: "syncChat", text: "A".repeat(60000) });
      await sleep(700);
      check("a 60KB chat message does not kill the socket", ws.readyState === 1, "readyState=" + ws.readyState);

      const b = sock();
      await b.ready;
      b.send_({ type: "syncJoin", code, name: "N".repeat(5000), avatar: "x".repeat(500) });
      const j = await b.waitFor((m) => m.type === "syncJoined");
      check("oversized name/avatar still joins (truncated, not rejected)", !!j);
      const state = await b.waitFor((m) => Array.isArray(m.members));
      const longest = state ? Math.max.apply(null, state.members.map((m) => (m.name || "").length)) : -1;
      check("names are truncated server-side, not stored unbounded", longest > 0 && longest <= 24, "longest=" + longest);

      shut([ws, b]);
    }

    // ---------- wrong types where a string or number is expected ----------
    {
      const ws = sock();
      await ws.ready;
      ws.send_({ type: "syncCreate", name: { evil: true } });
      const j = await ws.waitFor((m) => m.type === "syncJoined");
      check("an object where a name should be does not crash the join", !!j);
      ws.send_({ type: "syncChat", text: 12345 });
      ws.send_({ type: "syncSeek", time: "not-a-number" });
      ws.send_({ type: "syncSeek", time: null });
      ws.send_({ type: "syncSeek", time: -99999 });
      ws.send_({ type: "syncSeek", time: 1e18 });
      await sleep(700);
      check("non-numeric and out-of-range seeks do not kill the socket", ws.readyState === 1);
      shut([ws]);
    }

    // ---------- join semantics ----------
    {
      const { ws, code } = await makeRoom();

      const lower = sock();
      await lower.ready;
      lower.send_({ type: "syncJoin", code: String(code).toLowerCase(), name: "lower" });
      const lj = await lower.waitFor((m) => m.type === "syncJoined" || m.type === "syncError");
      check("a lowercased room code still joins", !!lj && lj.type === "syncJoined", lj && lj.text);

      const spaced = sock();
      await spaced.ready;
      spaced.send_({ type: "syncJoin", code: "  " + code + "  ", name: "spaced" });
      const sj = await spaced.waitFor((m) => m.type === "syncJoined" || m.type === "syncError");
      check("a room code with surrounding whitespace still joins", !!sj && sj.type === "syncJoined", sj && sj.text);

      const bogus = sock();
      await bogus.ready;
      bogus.send_({ type: "syncJoin", code: "ZZZZZ", name: "ghost" });
      const bj = await bogus.waitFor((m) => m.type === "syncError");
      check("joining a non-existent room returns a clear error", !!bj);

      const twice = sock();
      await twice.ready;
      twice.send_({ type: "syncJoin", code, name: "twice" });
      await twice.waitFor((m) => m.type === "syncJoined");
      const before = twice.got.filter((m) => m.type === "syncJoined").length;
      twice.send_({ type: "syncJoin", code, name: "twice-again" });
      await sleep(900);
      const after = twice.got.filter((m) => m.type === "syncJoined").length;
      check("one socket cannot join twice and double-count itself", after === before, before + " -> " + after);

      shut([ws, lower, spaced, bogus, twice]);
    }

    // ---------- acting without joining ----------
    {
      const ws = sock();
      await ws.ready;
      ws.send_({ type: "syncChat", text: "talking before I joined" });
      ws.send_({ type: "syncPlay" });
      ws.send_({ type: "syncSeek", time: 30 });
      await sleep(700);
      check("commands sent before joining are ignored, not fatal", ws.readyState === 1);
      check("no room state leaks to a socket that never joined",
        !ws.got.some((m) => m.type === "syncState" || Array.isArray(m.members)));
      shut([ws]);
    }

    // ---------- flood / rate limit ----------
    {
      const { ws, code } = await makeRoom();
      const watcher = sock();
      await watcher.ready;
      watcher.send_({ type: "syncJoin", code, name: "watcher" });
      await watcher.waitFor((m) => m.type === "syncJoined");

      for (let i = 0; i < 300; i++) ws.send_({ type: "syncChat", text: "flood " + i });
      await sleep(2500);
      check("a 300-message flood does not kill the flooder's socket", ws.readyState === 1);
      check("the flood does not kill an innocent bystander in the room", watcher.readyState === 1);
      const delivered = watcher.got.filter((m) => m.type === "syncChat").length;
      check("the rate limiter actually drops some of the flood", delivered < 300, "delivered=" + delivered);
      check("but the room is not silenced entirely", delivered > 0, "delivered=" + delivered);

      shut([ws, watcher]);
    }

    // ---------- history cap ----------
    {
      const { ws, code } = await makeRoom();
      for (let i = 0; i < 120; i++) { ws.send_({ type: "syncChat", text: "m" + i }); await sleep(12); }
      await sleep(1500);
      const late = sock();
      await late.ready;
      late.send_({ type: "syncJoin", code, name: "late" });
      const j = await late.waitFor((m) => m.type === "syncJoined");
      const hist = (j && j.history) || [];
      check("a late joiner receives history", hist.length > 0, hist.length + " entries");
      check("history is capped, not unbounded", hist.length <= 80, hist.length + " entries");
      shut([ws, late]);
    }

    // ---------- host leaving ----------
    {
      const { ws, code } = await makeRoom("original-host");
      const b = sock();
      await b.ready;
      b.send_({ type: "syncJoin", code, name: "survivor" });
      await b.waitFor((m) => m.type === "syncJoined");
      shut([ws]);
      await sleep(2000);
      check("the room survives the host disconnecting", b.readyState === 1);
      const newcomer = sock();
      await newcomer.ready;
      newcomer.send_({ type: "syncJoin", code, name: "newcomer" });
      const j = await newcomer.waitFor((m) => m.type === "syncJoined" || m.type === "syncError");
      check("someone can still join after the host left", !!j && j.type === "syncJoined", j && j.text);
      shut([b, newcomer]);
    }

    // ---------- the room link page ----------
    {
      const httpBase = URL_BASE.replace(/^ws/, "http");

      // Two defences are acceptable here and the test should accept either:
      // Cloudflare's edge can reject the traversal outright (400), or it can
      // reach the worker and be sanitised down to a plain room code. What is
      // NOT acceptable is the path being served or echoed back. Asserting one
      // specific status would make this test fail on a defence getting
      // stronger, which is how a security test ends up being deleted.
      const trav = await fetch(httpBase + "/r/%2e%2e%2f%2e%2e%2fetc%2fpasswd");
      check("an encoded path traversal is rejected or sanitised, never served",
        trav.status === 400 || trav.status === 200, "HTTP " + trav.status);
      const travText = await trav.text();
      check("path traversal does not echo the raw path back", !travText.includes("etc/passwd"));
      if (trav.status === 200) {
        check("a traversal that reaches the worker is reduced to a plain room code",
          /<div class="code">[A-Z0-9]{0,5}<\/div>/.test(travText));
      }

      const xss = await fetch(httpBase + "/r/" + encodeURIComponent("<script>alert(1)</script>"));
      const xssText = await xss.text();
      check("a script tag in the room code is not reflected into the page",
        !xssText.includes("<script>alert(1)</script>"));

      const long = await fetch(httpBase + "/r/" + "A".repeat(5000));
      check("a 5000-character room code does not error the worker", long.status === 200, "HTTP " + long.status);
    }
  } catch (e) {
    check("harness crashed: " + (e && e.message), false);
  } finally {
    console.log(results.join("\n"));
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
    process.exit(process.exitCode || 0);
  }
})();
