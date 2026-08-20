// How much does the relay actually take before it degrades?
//
// Everything else in the suite proves correctness with two or three people.
// This asks a different question: at the scale of a launch, does one Durable
// Object holding every room stay responsive, or does fan-out latency creep up
// until the room feels like the thing it was built to replace?
//
// Deliberately modest by default (40 rooms x 3 people = 120 sockets). A
// WebSocket upgrade counts as one request against Cloudflare's free 100k/day,
// and ongoing messages are free, so a run costs ~120 requests. Raise it with
// --rooms / --peers when you actually want to find the ceiling.
//
// Usage: node test/load-relay.js [--rooms 40] [--peers 3] [wss://...]

const WebSocket = require("ws");

const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};
const ROOMS = argOf("--rooms", 40);
const PEERS = argOf("--peers", 3);
const URL_BASE = process.argv.find((a) => a.startsWith("wss://")) ||
  "wss://sync-lis-relay.sync-lis-relay.workers.dev";

const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c || !extra ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

function open() {
  const ws = new WebSocket(URL_BASE);
  ws.on("error", () => {});
  ws.ready = new Promise((res) => { ws.on("open", () => res(true)); ws.on("error", () => res(false)); });
  ws.send_ = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
  return ws;
}

function once(ws, pred, ms) {
  return new Promise((res) => {
    const t = setTimeout(() => { ws.off("message", h); res(null); }, ms);
    function h(raw) {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!pred(m)) return;
      clearTimeout(t); ws.off("message", h); res(m);
    }
    ws.on("message", h);
  });
}

(async () => {
  const sockets = [];
  try {
    console.log(`opening ${ROOMS} rooms x ${PEERS} people = ${ROOMS * PEERS} sockets against ${URL_BASE}`);

    // ---- create every room concurrently, not in a queue ----
    const t0 = Date.now();
    const hosts = await Promise.all(Array.from({ length: ROOMS }, async () => {
      const ws = open();
      sockets.push(ws);
      if (!(await ws.ready)) return null;
      const started = Date.now();
      ws.send_({ type: "syncCreate", name: "host" });
      const j = await once(ws, (m) => m.type === "syncJoined", 20000);
      return j ? { ws, code: j.code, ms: Date.now() - started } : null;
    }));
    const made = hosts.filter(Boolean);
    const createMs = made.map((h) => h.ms);
    console.log(`  created ${made.length}/${ROOMS} in ${Date.now() - t0}ms  ` +
      `(p50 ${pct(createMs, 50)}ms, p95 ${pct(createMs, 95)}ms)`);

    check("every room was created under concurrent load", made.length === ROOMS, `${made.length}/${ROOMS}`);
    check("room codes are unique across concurrent creates",
      new Set(made.map((h) => h.code)).size === made.length,
      `${new Set(made.map((h) => h.code)).size} unique of ${made.length}`);
    check("room creation p95 stays under 3s", pct(createMs, 95) < 3000, `p95=${pct(createMs, 95)}ms`);

    // ---- fill each room ----
    const t1 = Date.now();
    const joins = await Promise.all(made.flatMap((h) =>
      Array.from({ length: PEERS - 1 }, async () => {
        const ws = open();
        sockets.push(ws);
        if (!(await ws.ready)) return null;
        const started = Date.now();
        ws.send_({ type: "syncJoin", code: h.code, name: "peer" });
        const j = await once(ws, (m) => m.type === "syncJoined" || m.type === "syncError", 20000);
        return j && j.type === "syncJoined" ? { ws, room: h.code, ms: Date.now() - started } : null;
      })
    ));
    const joined = joins.filter(Boolean);
    const joinMs = joined.map((j) => j.ms);
    const wanted = made.length * (PEERS - 1);
    console.log(`  joined  ${joined.length}/${wanted} in ${Date.now() - t1}ms  ` +
      `(p50 ${pct(joinMs, 50)}ms, p95 ${pct(joinMs, 95)}ms)`);

    check("every join succeeded under concurrent load", joined.length === wanted, `${joined.length}/${wanted}`);
    check("join p95 stays under 3s", pct(joinMs, 95) < 3000, `p95=${pct(joinMs, 95)}ms`);

    await sleep(1500);

    // ---- the number that actually matters: how long a play takes to land ----
    // Measured on a real peer in the same room while every other room is also
    // busy, because fan-out cost is shared across the whole Durable Object.
    const sample = made.slice(0, Math.min(20, made.length));
    const lat = [];
    await Promise.all(sample.map(async (h) => {
      const peer = joined.find((j) => j.room === h.code);
      if (!peer) return;
      const started = Date.now();
      // syncCmd is the real transport message (there is no "syncPlay"); it
      // carries a time and the content key it was measured against
      const heard = once(peer.ws, (m) => m.type === "syncState" || m.state, 15000);
      h.ws.send_({ type: "syncCmd", action: "play", time: 1 });
      if (await heard) lat.push(Date.now() - started);
    }));
    console.log(`  transport fan-out: n=${lat.length}  p50 ${pct(lat, 50)}ms  p95 ${pct(lat, 95)}ms  max ${Math.max(...lat)}ms`);

    check("a play command reaches other people in the room", lat.length > 0, `${lat.length} of ${sample.length}`);
    check("fan-out p95 stays under 1s with every room busy", pct(lat, 95) < 1000, `p95=${pct(lat, 95)}ms`);

    // ---- and is the relay still honest about itself afterwards? ----
    const statsUrl = URL_BASE.replace(/^ws/, "http") + "/stats";
    const stats = await fetch(statsUrl).then((r) => r.json()).catch(() => null);
    console.log(`  /stats reports ${stats && stats.activeUsers} users in ${stats && stats.activeRooms} rooms`);
    check("/stats still responds while loaded", !!stats, JSON.stringify(stats));
    check("/stats counts at least the rooms we just opened",
      !!stats && stats.activeRooms >= made.length, JSON.stringify(stats));

    // ---- everyone leaves at once ----
    const t2 = Date.now();
    sockets.forEach((ws) => { try { ws.close(); } catch {} });
    await sleep(4000);
    const after = await fetch(statsUrl).then((r) => r.json()).catch(() => null);
    console.log(`  after mass disconnect (${Date.now() - t2}ms): ${after && after.activeUsers} users, ${after && after.activeRooms} rooms`);
    check("the relay survives everyone disconnecting at once", !!after, JSON.stringify(after));
    check("presence counts drop back down, not leak",
      !!after && after.activeUsers < (stats ? stats.activeUsers : Infinity),
      `${stats && stats.activeUsers} -> ${after && after.activeUsers}`);
  } catch (e) {
    check(`harness crashed: ${e && e.message}`, false);
  } finally {
    sockets.forEach((ws) => { try { ws.close(); } catch {} });
    console.log("\n" + results.join("\n"));
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(process.exitCode || 0);
  }
})();
