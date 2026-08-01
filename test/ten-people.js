// Ten in a room, all reporting positions, all adding to the queue.
// The question is not whether the server survives (chaos already covers that)
// but whether everyone genuinely sees the same room.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const WebSocket = require("ws");

const HOST = "localhost:7777";
const N = 10;
const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c || !extra ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RELAY_URL = process.env.SYNC_TEST_RELAY || `wss://${HOST}`;

function client(name) {
  const ws = new WebSocket(RELAY_URL, { rejectUnauthorized: false });
  const c = { name, ws, msgs: [], joined: null, room: null };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "syncJoined") c.joined = m;
    if (m.type === "syncState") c.room = m;
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.got = (t) => c.msgs.filter((m) => m.type === t);
  return new Promise((res) => ws.on("open", () => res(c)));
}

(async () => {
  const host = await client("p0");
  host.send({ type: "syncCreate", name: "p0", avatar: "🎧" });
  await sleep(400);
  const code = host.joined.code;

  const rest = [];
  for (let i = 1; i < N; i++) {
    const c = await client(`p${i}`);
    c.send({ type: "syncJoin", code, name: `p${i}`, avatar: "🍿" });
    rest.push(c);
    await sleep(80);
  }
  const all = [host, ...rest];
  await sleep(1200);

  check(`${N} people are all in the room`, host.room.members.length === N, `saw ${host.room.members.length}`);
  check("everyone sees the same count", all.every((c) => c.room && c.room.members.length === N));
  check("names are not collapsed", new Set(host.room.members.map((m) => m.name)).size === N);

  // everyone drops picks, like a real jam
  all.forEach((c, i) => c.send({
    type: "syncQueueAdd", url: `https://www.youtube.com/watch?v=v${i}`,
    key: `yt:v${i}`, title: `pick ${i}`, kind: "youtube",
  }));
  await sleep(1200);
  check("the first pick starts playing", host.room.content && host.room.content.key === "yt:v0");
  check("the rest queue behind it", host.room.queue.length === N - 1, `queue ${host.room.queue.length}`);
  check("everyone sees the same running order",
    all.every((c) => c.room.queue.length === N - 1 && c.room.queue[0].title === host.room.queue[0].title));

  // everyone lands on the track, the way a real agent reports arriving
  all.forEach((c) => c.send({
    type: "syncQueueAdd" === "" ? "" : "syncContent",
    key: "yt:v0", url: "https://www.youtube.com/watch?v=v0", title: "pick 0", kind: "youtube", time: 0,
  }));
  await sleep(800);
  check("everyone is marked as arrived", host.room.members.every((m) => m.arrived));

  // everyone reports a position; the drift readout must survive the traffic
  for (let round = 0; round < 3; round++) {
    all.forEach((c, i) => c.send({ type: "syncPos", time: 10 + i * 0.1 }));
    await sleep(700);
  }
  await sleep(2200);
  const positions = host.room.members.filter((m) => m.pos > 0).length;
  check("positions from all ten arrive", positions === N, `only ${positions} reported`);

  // one person stalling holds the whole room, then releases it
  host.send({ type: "syncCmd", action: "play", time: 10 });
  await sleep(300);
  rest[4].send({ type: "syncHold", holding: true });
  await sleep(400);
  check("one of ten stalling pauses everyone", all.every((c) => c.room.state.paused === true));
  rest[4].send({ type: "syncHold", holding: false });
  await sleep(500);
  check("and it resumes for everyone", all.every((c) => c.room.state.paused === false));

  // chat fans out to all ten
  rest[7].send({ type: "syncChat", text: "sab sun rahe ho?" });
  await sleep(600);
  const heard = all.filter((c) => c.got("syncChat").some((m) => m.text === "sab sun rahe ho?")).length;
  check("a message reaches all ten", heard === N, `${heard} heard it`);

  // and leaving does not corrupt the room
  rest[2].ws.close();
  await sleep(600);
  check("a leaver is removed everywhere", host.room.members.length === N - 1);

  console.log(results.join("\n"));
  all.forEach((c) => { try { c.ws.close(); } catch {} });
  process.exit(process.exitCode || 0);
})();
