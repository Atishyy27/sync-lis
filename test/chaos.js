// Chaos harness: N fake users hammer the jukebox room AND a watch-together
// session with random noise, while every state broadcast is invariant-checked.
// Usage: node chaos.js <N>
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const WebSocket = require("ws");
const fs = require("fs");

const N = parseInt(process.argv[2] || "3");
const TONE = process.argv[3];
const HOST = "localhost:7777";
const ROOM = `chaos${N}`;
const ACTION_MS = 15000;

const violations = [];
const bug = (msg) => violations.push(msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

let lastStateAt = Date.now();

function checkJamState(s, who) {
  try {
    if (!Array.isArray(s.members) || s.members.length < 1) bug(`${who}: empty members`);
    if (s.skipVotes > s.members.length) bug(`${who}: skipVotes ${s.skipVotes} > members ${s.members.length}`);
    const ids = new Set();
    const memberIds = new Set(s.members.map((m) => m.id));
    for (const e of s.queue) {
      if (ids.has(e.id)) bug(`${who}: duplicate queue entry ${e.id}`);
      ids.add(e.id);
      if (!memberIds.has(e.ownerId)) bug(`${who}: orphan queue entry ${e.id} (owner ${e.ownerId} not in room)`);
      if (!["fetching", "ready", "error"].includes(e.status)) bug(`${who}: bad status ${e.status}`);
    }
    const c = s.current;
    if (c) {
      if (c.status !== "ready") bug(`${who}: current not ready (${c.status})`);
      if (!isFinite(c.startedAt) || c.startedAt <= 0) bug(`${who}: bad startedAt ${c.startedAt}`);
      if (c.pausedAt !== null && (!isFinite(c.pausedAt) || c.pausedAt < c.startedAt)) bug(`${who}: pausedAt ${c.pausedAt} < startedAt ${c.startedAt}`);
      if (!/^\/media\/\d+\.m4a$/.test(c.mediaUrl)) bug(`${who}: bad mediaUrl ${c.mediaUrl}`);
    }
  } catch (e) {
    bug(`${who}: invariant checker threw: ${e.message}`);
  }
}

function checkSyncState(s, who) {
  if (typeof s.state.paused !== "boolean") bug(`${who}: sync paused not bool`);
  if (!isFinite(s.state.time) || s.state.time < 0) bug(`${who}: sync time ${s.state.time}`);
  if (!isFinite(s.state.at)) bug(`${who}: sync at ${s.state.at}`);
}

function jamClient(name) {
  const c = { name, id: null, state: null, alive: true, myEntries: [] };
  c.ws = new WebSocket(`wss://${HOST}`, { rejectUnauthorized: false });
  c.ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "welcome") c.id = m.id;
    if (m.type === "state") {
      c.state = m;
      lastStateAt = Date.now();
      checkJamState(m, name);
      c.myEntries = m.queue.filter((e) => e.ownerId === c.id).map((e) => e.id);
    }
  });
  c.ws.on("open", () => c.ws.send(JSON.stringify({ type: "join", room: ROOM, name })));
  c.ws.on("error", () => {});
  c.send = (m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };
  return c;
}

function syncClient(name, code) {
  const c = { name, state: null, joined: null, alive: true };
  c.ws = new WebSocket(`wss://${HOST}`, { rejectUnauthorized: false });
  c.ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "syncJoined") c.joined = m;
    if (m.type === "syncState") { c.state = m; checkSyncState(m, name); }
  });
  c.ws.on("open", () => c.ws.send(JSON.stringify(code ? { type: "syncJoin", code, name } : { type: "syncCreate", name })));
  c.ws.on("error", () => {});
  c.send = (m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };
  return c;
}

async function uploadTone(c, label) {
  if (!c.id) return;
  const q = new URLSearchParams({ room: ROOM, member: c.id, name: `${label}.m4a` });
  await fetch(`https://${HOST}/upload?${q}`, { method: "POST", body: fs.readFileSync(TONE) }).catch(() => {});
}

(async () => {
  console.log(`=== chaos N=${N} ===`);
  const clients = [];
  for (let i = 0; i < N; i++) clients.push(jamClient(`u${i}`));

  const syncCreator = syncClient("s0");
  await sleep(700);
  const code = syncCreator.joined && syncCreator.joined.code;
  const syncers = [syncCreator];
  if (code) for (let i = 1; i < N; i++) syncers.push(syncClient(`s${i}`, code));
  await sleep(500);

  // ---- action storm ----
  const stopAt = Date.now() + ACTION_MS;
  const loops = clients.map(async (c, i) => {
    while (Date.now() < stopAt) {
      await sleep(300 + Math.random() * 600);
      if (!c.alive) continue;
      const roll = Math.random();
      try {
        if (roll < 0.3) await uploadTone(c, `n${i}-${Date.now() % 10000}`);
        else if (roll < 0.38) c.send({ type: "queueAdd", url: `https://chaos-${i}.invalid/x` });
        else if (roll < 0.46 && c.myEntries.length) c.send({ type: "queueRemove", entryId: rand(c.myEntries) });
        else if (roll < 0.58) c.send({ type: "voteSkip" });
        else if (roll < 0.68) c.send({ type: "pause" });
        else if (roll < 0.78) c.send({ type: "resume" });
        else if (roll < 0.9) c.send({ type: "seek", position: Math.random() * 5 });
        else if (roll < 0.95 && i > 0) {
          // rage-quit and come back as someone new
          c.alive = false;
          c.ws.close();
          await sleep(500);
          const nc = jamClient(`u${i}r${Date.now() % 1000}`);
          clients.push(nc);
        } else {
          // evil range request on whatever is playing
          const cur = c.state && c.state.current;
          if (cur) {
            const r = await fetch(`https://${HOST}${cur.mediaUrl}`, { headers: { Range: "bytes=99999999999-" } }).catch(() => null);
            if (r && r.status !== 416 && r.status !== 404) bug(`evil range got ${r.status}, want 416/404`);
          }
        }
      } catch (e) {
        bug(`action threw: ${e.message}`);
      }
    }
  });

  const syncLoops = syncers.map(async (c) => {
    while (Date.now() < stopAt) {
      await sleep(200 + Math.random() * 400);
      const roll = Math.random();
      if (roll < 0.35) c.send({ type: "syncCmd", action: "play", time: Math.random() * 5000 });
      else if (roll < 0.7) c.send({ type: "syncCmd", action: "pause", time: Math.random() * 5000 });
      else if (roll < 0.95) c.send({ type: "syncCmd", action: "seek", time: Math.random() * 5000 });
      else c.send({ type: "syncCmd", action: "seek", time: NaN }); // hostile input
    }
  });

  await Promise.all([...loops, ...syncLoops]);

  // ---- quiesce: wait until jukebox state stops changing (pending fetches settle) ----
  const qDeadline = Date.now() + 30000;
  while (Date.now() < qDeadline && Date.now() - lastStateAt < 4000) await sleep(300);
  while (Date.now() < qDeadline) {
    if (Date.now() - lastStateAt >= 4000) break;
    await sleep(300);
  }

  // ---- convergence: all alive clients hold identical state (minus clock) ----
  const strip = (s) => { const { now, ...rest } = s; return JSON.stringify(rest); };
  const alive = clients.filter((c) => c.alive && c.state && c.ws.readyState === 1);
  const shapes = new Set(alive.map((c) => strip(c.state)));
  if (shapes.size > 1) bug(`jukebox states diverged: ${shapes.size} distinct shapes among ${alive.length} clients`);
  else console.log(`jukebox converged across ${alive.length} clients`);

  const aliveSync = syncers.filter((c) => c.state && c.ws.readyState === 1);
  const syncShapes = new Set(aliveSync.map((c) => JSON.stringify({ s: c.state.state, m: c.state.members.map((x) => x.id).sort() })));
  if (syncShapes.size > 1) bug(`sync states diverged: ${syncShapes.size} shapes among ${aliveSync.length}`);
  else console.log(`sync converged across ${aliveSync.length} clients`);

  // ---- fresh observer sees the same world ----
  const obs = jamClient("observer");
  await sleep(800);
  if (!obs.state) bug("fresh observer got no state within 800ms");

  // ---- server still healthy ----
  const health = await fetch(`https://${HOST}/`).catch(() => null);
  if (!health || health.status !== 200) bug("server unhealthy after chaos");

  console.log(violations.length ? `VIOLATIONS (${violations.length}):\n` + [...new Set(violations)].slice(0, 20).join("\n") : "NO VIOLATIONS");
  process.exit(violations.length ? 1 : 0);
})();

