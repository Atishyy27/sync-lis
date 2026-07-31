// Content-following smoke test: does "what she plays" reach him, timestamped,
// over the PUBLIC relay (not localhost) â€” the real path his gf will use.
const WebSocket = require("ws");

const HOST = process.argv[2]; // public tunnel host
const results = [];
const check = (n, c) => { results.push(`${c ? "PASS" : "FAIL"}  ${n}`); if (!c) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(`wss://${HOST}`);
  const c = { name, ws, msgs: [], joined: null, state: null, content: null, members: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "syncJoined") c.joined = m;
    if (m.type === "syncState") { c.state = m.state; c.content = m.content; c.members = m.members; }
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.got = (t) => c.msgs.filter((m) => m.type === t);
  return new Promise((res) => ws.on("open", () => res(c)));
}

(async () => {
  // her: starts a room, plays a YouTube video
  const her = await client("her");
  her.send({ type: "syncCreate", name: "her" });
  await sleep(600);
  const code = her.joined && her.joined.code;
  check("room created over public relay", /^[A-Z2-9]{5}$/.test(code || ""));

  her.send({
    type: "syncContent",
    key: "yt:dQw4w9WgXcQ",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Never Gonna Give You Up",
    kind: "youtube",
    time: 0,
  });
  await sleep(400);
  check("her content is in the room", her.content && her.content.key === "yt:dQw4w9WgXcQ");
  check("new content starts held (paused)", her.state.paused === true);

  her.send({ type: "syncCmd", action: "play", time: 12 });
  await sleep(400);

  // him: joins the room link later, must land on HER video at HER timestamp
  const him = await client("him");
  him.send({ type: "syncJoin", code, name: "him" });
  await sleep(600);
  check("he gets the content on join", him.joined.content && him.joined.content.url.includes("dQw4w9WgXcQ"));
  check("he gets the timeline on join", him.joined.state && him.joined.state.paused === false && him.joined.state.time === 12);
  check("content title travels for the UI", him.content.title === "Never Gonna Give You Up");
  check("both in the room", him.members.length === 2);

  // he pauses -> she pauses
  him.send({ type: "syncCmd", action: "pause", time: 30 });
  await sleep(400);
  check("his pause reaches her", her.state.paused === true && her.state.time === 30);

  // she switches to a Spotify track -> he follows, timeline resets
  her.send({
    type: "syncContent",
    key: "sp:4nVBt6MZDDP6tRVdQTgxJg",
    url: "https://open.spotify.com/track/4nVBt6MZDDP6tRVdQTgxJg",
    title: "Story of My Life",
    kind: "spotify",
    time: 0,
  });
  await sleep(400);
  check("spotify switch reaches him", him.content && him.content.kind === "spotify" && him.content.key.startsWith("sp:"));
  check("switching content resets the timeline", him.state.time === 0 && him.state.paused === true);

  // duplicate report of the same content must not churn the room
  const before = him.content;
  her.send({ type: "syncContent", key: "sp:4nVBt6MZDDP6tRVdQTgxJg", url: "https://open.spotify.com/track/4nVBt6MZDDP6tRVdQTgxJg", title: "Story of My Life", kind: "spotify", time: 90 });
  await sleep(400);
  check("re-reporting the same content is a no-op", him.content.key === before.key && him.state.time === 0);

  // the room link page reflects the live room
  const page = await fetch(`https://${HOST}/r/${code}`).then((r) => r.text());
  check("room link page shows the code", page.includes(code));
  check("room link page names what's playing", page.includes("Story of My Life"));
  const dead = await fetch(`https://${HOST}/r/ZZZZZ`).then((r) => r.text());
  check("dead room link says so", dead.includes("isn't live"));

  console.log(results.join("\n"));
  her.ws.close(); him.ws.close();
  process.exit(process.exitCode || 0);
})();

