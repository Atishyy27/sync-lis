// Headless smoke test for synclist watch-together sessions.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const WebSocket = require("ws");

const results = [];
const check = (name, cond) => {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket("wss://localhost:7777", { rejectUnauthorized: false });
  const c = { name, ws, msgs: [], joined: null, state: null, members: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "syncJoined") c.joined = m;
    if (m.type === "syncState") { c.state = m.state; c.members = m.members; }
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.got = (t) => c.msgs.filter((m) => m.type === t);
  return new Promise((res) => ws.on("open", () => res(c)));
}

(async () => {
  const a = await client("aman");
  a.send({ type: "syncCreate", name: "aman" });
  await sleep(300);
  check("create returns a 5-char code", a.joined && /^[A-Z2-9]{5}$/.test(a.joined.code));
  check("creator gets initial paused state", a.state && a.state.paused === true);
  const code = a.joined.code;

  // wrong code fails loudly
  const x = await client("lost");
  x.send({ type: "syncJoin", code: "ZZZZZ", name: "lost" });
  await sleep(300);
  check("bad code -> syncError", x.got("syncError").length === 1);

  // creator plays at t=100 BEFORE others join; late joiner must land mid-play
  a.send({ type: "syncCmd", action: "play", time: 100 });
  await sleep(300);
  const b = await client("bunty");
  b.send({ type: "syncJoin", code, name: "bunty" });
  await sleep(300);
  check("late joiner receives playing state", b.state && b.state.paused === false && b.state.time === 100);
  check("state carries server timestamp", typeof b.state.at === "number");
  check("member list has both", b.members.length === 2);

  // pause propagates with position
  b.send({ type: "syncCmd", action: "pause", time: 130.5 });
  await sleep(300);
  check("pause from any member reaches creator", a.state.paused === true && a.state.time === 130.5);

  // seek while paused keeps paused
  a.send({ type: "syncCmd", action: "seek", time: 42 });
  await sleep(300);
  check("seek keeps paused flag, moves time", b.state.paused === true && b.state.time === 42);

  // member leaves -> others notified
  b.ws.close();
  await sleep(400);
  check("leave shrinks member list", a.members.length === 1);

  // last member leaves -> session gone
  a.ws.close();
  await sleep(400);
  const c = await client("late");
  c.send({ type: "syncJoin", code, name: "late" });
  await sleep(300);
  check("empty session is deleted (code dead)", c.got("syncError").length === 1);

  console.log(results.join("\n"));
  [x, c].forEach((cl) => cl.ws.close());
  process.exit(process.exitCode || 0);
})();

