// Headless smoke test for the mehfil jukebox: uploads a generated tone file
// (no YouTube dependency), verifies the fetch->ready->playing->advance machine,
// range serving, clock pings, skip votes, and owner instant-skip.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const WebSocket = require("ws");
const fs = require("fs");

const HOST = "localhost:7777";
const ROOM = "smoketest";
const TONE = process.argv[2]; // path to generated m4a

const results = [];
const check = (name, cond) => {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(`wss://${HOST}`, { rejectUnauthorized: false });
  const c = { name, ws, id: null, msgs: [], state: null };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "welcome") c.id = m.id;
    if (m.type === "state") c.state = m;
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "join", room: ROOM, name })));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.got = (t) => c.msgs.filter((m) => m.type === t);
  return c;
}

async function upload(c, filePath, fileName) {
  const body = fs.readFileSync(filePath);
  const q = new URLSearchParams({ room: ROOM, member: c.id, name: fileName });
  const res = await fetch(`https://${HOST}/upload?${q}`, { method: "POST", body });
  return res.json();
}

async function waitFor(cond, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(150);
  }
  return false;
}

(async () => {
  const a = client("aman"), b = client("bunty"), d = client("dolly");
  await sleep(500);
  check("three joined (member count = 3)", a.state && a.state.members.length === 3);

  // clock ping
  a.send({ type: "ping", t: Date.now() });
  await sleep(300);
  const pong = a.got("pong")[0];
  check("pong carries echo + server clock", pong && typeof pong.now === "number" && typeof pong.t === "number");

  // bad link rejected with a toast
  a.send({ type: "queueAdd", url: "hello" });
  await sleep(300);
  check("garbage input rejected with toast", a.got("toast").length === 1);

  // upload tone -> fetching card -> ready -> auto-plays
  const up = await upload(a, TONE, "test tone.m4a");
  check("upload accepted", up.ok === true);
  const played = await waitFor(() => b.state && b.state.current && b.state.current.title === "test tone");
  check("uploaded track auto-plays for everyone", played);
  const cur = b.state.current;
  check("current has startedAt + mediaUrl", cur && typeof cur.startedAt === "number" && /^\/media\/\d+\.m4a$/.test(cur.mediaUrl));
  check("ffprobe filled duration (~3s)", cur && cur.duration >= 2 && cur.duration <= 4);

  // range request
  const r = await fetch(`https://${HOST}${cur.mediaUrl}`, { headers: { Range: "bytes=0-99" } });
  check("media serves 206 partial content", r.status === 206 && r.headers.get("content-range") !== null);

  // majority skip (threshold floor(3/2)+1 = 2): b then d
  b.send({ type: "voteSkip" });
  await sleep(250);
  check("one vote not enough", b.state.current && b.state.skipVotes === 1);
  d.send({ type: "voteSkip" });
  await sleep(400);
  check("majority skip clears playback", b.state.current === null);

  // owner instant skip
  await upload(a, TONE, "tone two.m4a");
  await waitFor(() => a.state && a.state.current && a.state.current.title === "tone two");
  a.send({ type: "voteSkip" });
  await sleep(400);
  check("owner skips own track instantly", a.state.current === null);

  // the room feel: chat, reactions, and waiting for a stalled listener
  b.send({ type: "chat", text: "ye gaana tez kar" });
  await sleep(300);
  check("chat reaches the room", d.got("chat").some((m) => m.text === "ye gaana tez kar" && m.from === "bunty"));
  b.send({ type: "react", emoji: "🔥" });
  await sleep(300);
  check("reaction reaches the room", d.got("react").some((m) => m.emoji === "🔥"));
  check("joins are announced", d.got("said").some((m) => /joined/.test(m.text)));

  await upload(a, TONE, "hold check.m4a");
  await waitFor(() => a.state && a.state.current && a.state.current.title === "hold check");
  d.send({ type: "hold", holding: true });
  await sleep(400);
  check("a stalled listener pauses the jam", a.state.current && a.state.current.pausedAt !== null);
  check("everyone sees who is buffering", a.state.members.find((m) => m.name === "dolly").holding === true);
  d.send({ type: "hold", holding: false });
  await sleep(400);
  check("jam resumes once they catch up", a.state.current && a.state.current.pausedAt === null);
  a.send({ type: "voteSkip" });
  await sleep(400);

  // shared transport: pause freezes for everyone, resume continues, seek moves the clock
  await upload(a, TONE, "tone t.m4a");
  await waitFor(() => a.state && a.state.current && a.state.current.title === "tone t");
  b.send({ type: "pause" });
  await sleep(300);
  check("anyone can pause (pausedAt set for all)", d.state.current && typeof d.state.current.pausedAt === "number");
  const frozenStart = d.state.current.startedAt;
  await sleep(3500); // longer than the track â€” must NOT auto-advance while paused
  check("paused track does not auto-advance", d.state.current !== null);
  d.send({ type: "seek", position: 1 });
  await sleep(300);
  check("seek while paused shifts startedAt", d.state.current.startedAt !== frozenStart);
  b.send({ type: "resume" });
  await sleep(300);
  check("resume clears pausedAt", d.state.current && d.state.current.pausedAt === null);
  const ended0 = await waitFor(() => a.state.current === null, 8000);
  check("resumed track finishes and advances", ended0);

  // auto-advance at end of a ~3s track
  await upload(a, TONE, "tone three.m4a");
  await waitFor(() => a.state && a.state.current && a.state.current.title === "tone three");
  const ended = await waitFor(() => a.state.current === null, 8000);
  check("track auto-advances at its end", ended);

  console.log(results.join("\n"));
  [a, b, d].forEach((c) => c.ws.close());
  process.exit(process.exitCode || 0);
})();

