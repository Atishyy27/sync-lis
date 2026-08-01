// Co-watching features: wait-for-me holds, presence, chat, reactions,
// ready-check countdown, host lock. Plus the jam's access toggle.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const WebSocket = require("ws");

const HOST = "localhost:7777";
const results = [];
const check = (n, c) => { results.push(`${c ? "PASS" : "FAIL"}  ${n}`); if (!c) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(`wss://${HOST}`, { rejectUnauthorized: false });
  const c = { name, ws, msgs: [], joined: null, room: null };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "syncJoined") c.joined = m;
    if (m.type === "syncState") c.room = m;
    if (m.type === "state") c.jam = m;
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.got = (t) => c.msgs.filter((m) => m.type === t);
  c.me = () => c.room.members.find((m) => m.id === c.joined.meId);
  c.other = () => c.room.members.find((m) => m.id !== c.joined.meId);
  return new Promise((res) => ws.on("open", () => res(c)));
}

process.on("exit", () => {
  if (process.exitCode) console.log("(if the jam is stuck link-only, restart the server)");
});

(async () => {
  const her = await client("her");
  her.send({ type: "syncCreate", name: "her" });
  await sleep(400);
  const code = her.joined.code;
  check("creator becomes host", her.room.hostId === her.joined.meId);

  const him = await client("him");
  him.send({ type: "syncJoin", code, name: "him" });
  await sleep(400);
  check("both present with names", him.room.members.length === 2);
  check("join is announced as an action", him.room.lastAction && him.room.lastAction.action === "joined");
  check("guest is not host", him.room.hostId !== him.joined.meId);

  // start playing, then he buffers -> room must hold, then auto-resume
  her.send({ type: "syncCmd", action: "play", time: 10 });
  await sleep(300);
  check("play recorded with who did it", her.room.lastAction.name === "her" && her.room.lastAction.action === "pressed play");
  check("room is playing", her.room.state.paused === false);

  him.send({ type: "syncHold", holding: true });
  await sleep(300);
  check("his buffering pauses the room for everyone", her.room.state.paused === true);
  check("she can see he is the one buffering", her.room.members.find((m) => m.id === him.joined.meId).holding === true);

  const heldTime = her.room.state.time;
  await sleep(1200);
  check("held timeline does not advance", her.room.state.time === heldTime);

  him.send({ type: "syncHold", holding: false });
  await sleep(300);
  check("room resumes by itself once he recovers", her.room.state.paused === false);
  check("resume is announced", her.room.lastAction.action === "back in sync");

  // a deliberate pause during a hold must not be undone by auto-resume
  him.send({ type: "syncHold", holding: true });
  await sleep(200);
  her.send({ type: "syncCmd", action: "pause", time: 20 });
  await sleep(200);
  him.send({ type: "syncHold", holding: false });
  await sleep(300);
  check("manual pause survives the hold clearing", her.room.state.paused === true);

  // position reports feed the drift meter
  him.send({ type: "syncPos", time: 42.4 });
  await sleep(2400);
  check("positions reach the other side", her.room.members.find((m) => m.id === him.joined.meId).pos === 42.4);

  // chat + reactions
  him.send({ type: "syncChat", text: "this scene is unreal" });
  await sleep(300);
  const chat = her.got("syncChat")[0];
  check("chat arrives with sender", chat && chat.from === "him" && chat.text === "this scene is unreal");
  check("chat is stamped to the video time", chat && typeof chat.videoTime === "number");
  him.send({ type: "syncReact", emoji: "ðŸ”¥" });
  await sleep(300);
  check("reaction arrives", her.got("syncReact").some((r) => r.emoji === "ðŸ”¥"));

  // host lock
  him.send({ type: "syncHostLock", locked: true });
  await sleep(300);
  check("guest cannot lock", her.room.locked === false && him.got("syncNote").length === 1);
  her.send({ type: "syncHostLock", locked: true });
  await sleep(300);
  check("host can lock", him.room.locked === true);
  him.send({ type: "syncCmd", action: "play", time: 99 });
  await sleep(300);
  check("locked out guest cannot drive", her.room.state.time !== 99);
  check("guest is told why", him.got("syncNote").length === 2);
  her.send({ type: "syncCmd", action: "play", time: 99 });
  await sleep(300);
  check("host can still drive while locked", her.room.state.time === 99);
  her.send({ type: "syncHostLock", locked: false });
  await sleep(300);

  // ready check -> countdown -> play together
  her.send({ type: "syncCmd", action: "pause", time: 0 });
  await sleep(200);
  her.send({ type: "syncReady", ready: true });
  await sleep(300);
  check("one ready is not enough", her.room.state.paused === true && !her.room.countdownAt);
  him.send({ type: "syncReady", ready: true });
  await sleep(300);
  check("everyone ready schedules a countdown", him.room.countdownAt > Date.now());
  check("play is scheduled, not immediate", him.room.state.paused === false && him.room.state.at === him.room.countdownAt);
  check("ready flags reset after firing", him.room.members.every((m) => !m.ready));

  // the jam: a shared running order that plays itself
  her.send({ type: "syncQueueAdd", url: "https://www.youtube.com/watch?v=aaa", key: "yt:aaa", title: "her pick one", kind: "youtube" });
  await sleep(300);
  check("a queued link starts playing when nothing is on", her.room.content && her.room.content.key === "yt:aaa");
  him.send({ type: "syncQueueAdd", url: "https://www.youtube.com/watch?v=bbb", key: "yt:bbb", title: "his pick", kind: "youtube" });
  her.send({ type: "syncQueueAdd", url: "https://www.youtube.com/watch?v=ccc", key: "yt:ccc", title: "her pick two", kind: "youtube" });
  await sleep(400);
  check("both people's picks sit in one order", him.room.queue.length === 2 && him.room.queue[0].byName === "him");
  check("everyone sees who added what", him.room.queue[0].title === "his pick");

  // reaching the end moves it along by itself
  him.send({ type: "syncEnded", key: "yt:aaa" });
  await sleep(400);
  check("finishing a track plays the next one", her.room.content.key === "yt:bbb");
  check("the played entry leaves the queue", her.room.queue.length === 1);
  check("a new track starts held at zero", her.room.state.time === 0 && her.room.state.paused === true);

  // one advance per ending, not one per person
  her.send({ type: "syncEnded", key: "yt:bbb" });
  him.send({ type: "syncEnded", key: "yt:bbb" });
  await sleep(400);
  check("two people finishing does not skip two tracks", her.room.content.key === "yt:ccc");

  // skipping, and removing your own pick
  her.send({ type: "syncQueueAdd", url: "https://www.youtube.com/watch?v=ddd", key: "yt:ddd", title: "spare", kind: "youtube" });
  await sleep(300);
  const spare = her.room.queue.find((x) => x.title === "spare");
  him.send({ type: "syncQueueRemove", id: spare.id });
  await sleep(300);
  check("someone else cannot pull your pick", her.room.queue.some((x) => x.id === spare.id));
  her.send({ type: "syncQueueRemove", id: spare.id });
  await sleep(300);
  check("you can pull your own pick", !her.room.queue.some((x) => x.id === spare.id));

  // The queue only knows a link. The player knows the page calls itself
  // something else entirely (yt:<id>). If those two are treated as different
  // things, nobody is ever "arrived", the room holds, and playback pauses on
  // a loop — which is exactly what solo playback looked like.
  her.send({ type: "syncQueueNext" }); // clear whatever is on
  await sleep(300);
  her.send({ type: "syncQueueAdd", url: "https://www.youtube.com/watch?v=zzz" });
  await sleep(400);
  check("a link queued with no key still starts", her.room.content && her.room.content.url.includes("v=zzz"));

  // now the player arrives and calls it by the adapter's name. Adopting that
  // name must NOT look like someone switching to something new, or the
  // timeline resets and everyone gets paused again.
  const switchesBefore = her.got("syncNarrate").length;
  him.send({
    type: "syncContent", key: "yt:zzz",
    url: "https://www.youtube.com/watch?v=zzz", title: "Real Title", kind: "youtube", time: 0,
  });
  await sleep(400);
  check("the room adopts the player's name for it", her.room.content.key === "yt:zzz");
  check("adopting a name is not announced as a switch",
    her.got("syncNarrate").length === switchesBefore);
  check("and counts that person as arrived", her.room.members.find((m) => m.id === him.joined.meId).arrived === true);
  check("the real title replaces the guess", her.room.content.title === "Real Title");

  // the other side arrives on the same thing and nothing resets
  her.send({
    type: "syncContent", key: "yt:zzz",
    url: "https://www.youtube.com/watch?v=zzz", title: "Real Title", kind: "youtube", time: 0,
  });
  await sleep(400);
  check("everyone arrived, so nothing is holding", her.room.members.every((m) => m.arrived));

  // and finishing it advances, because the keys finally agree
  her.send({ type: "syncQueueAdd", url: "https://www.youtube.com/watch?v=yyy" });
  await sleep(300);
  him.send({ type: "syncEnded", key: "yt:zzz" });
  await sleep(400);
  check("finishing advances now that names agree", her.room.content.url.includes("v=yyy"));

  // identity is changeable after joining: link-joiners arrive unnamed
  him.send({ type: "syncIdentity", name: "Aditi", avatar: "🍿" });
  await sleep(300);
  const named = her.room.members.find((m) => m.id === him.joined.meId);
  check("a joiner can name themselves later", named && named.name === "Aditi");
  check("and pick a face", named && named.avatar === "🍿");

  // party pieces reach the room
  him.send({ type: "syncSting", kind: "drumroll" });
  await sleep(250);
  check("a sting reaches the room", her.got("syncSting").some((m) => m.kind === "drumroll"));
  him.send({ type: "syncBig", emoji: "🔥" });
  await sleep(250);
  check("a big reaction reaches the room", her.got("syncBig").some((m) => m.emoji === "🔥"));
  him.send({ type: "syncSecret", text: "dekh peeche" });
  await sleep(250);
  check("a secret reaches the room", her.got("syncSecret").some((m) => m.text === "dekh peeche"));

  // speed is shared: one person changing it changes it for the room
  her.send({ type: "syncCmd", action: "rate", rate: 1.5, time: 10 });
  await sleep(300);
  check("speed change reaches the other side", him.room.state.rate === 1.5);
  const t0 = him.room.state.time;
  await sleep(1000);
  him.send({ type: "syncCmd", action: "pause", time: 99 });
  await sleep(300);
  check("speed survives a pause", him.room.state.rate === 1.5);
  her.send({ type: "syncCmd", action: "rate", rate: 9, time: 10 });
  await sleep(300);
  check("a silly speed is refused", him.room.state.rate === 1.5);
  her.send({ type: "syncCmd", action: "rate", rate: 1, time: 10 });
  await sleep(300);

  // away presence
  him.send({ type: "syncAway", away: true });
  await sleep(300);
  check("away shows to the other side", her.room.members.find((m) => m.id === him.joined.meId).away === true);
  him.send({ type: "syncAway", away: false });
  await sleep(300);
  check("coming back clears away", her.room.members.find((m) => m.id === him.joined.meId).away === false);

  // typing indicator
  him.send({ type: "syncTyping" });
  await sleep(300);
  check("typing reaches the other side", her.got("syncTyping").some((m) => m.fromId === him.joined.meId));

  // voice: the server carries only the handshake, never audio
  him.send({ type: "syncVoice", on: true });
  await sleep(300);
  check("voice flag is visible to the room", her.room.members.find((m) => m.id === him.joined.meId).voice === true);
  him.send({ type: "syncSignal", to: her.joined.meId, data: { sdp: { type: "offer", sdp: "x" } } });
  await sleep(300);
  const sig = her.got("syncSignal")[0];
  check("handshake is relayed with the sender's id", sig && sig.from === him.joined.meId && sig.data.sdp.type === "offer");
  him.send({ type: "syncVoice", on: false });
  await sleep(300);
  check("leaving voice clears the flag", her.room.members.find((m) => m.id === him.joined.meId).voice === false);

  // host leaving hands over and unlocks
  her.send({ type: "syncHostLock", locked: true });
  await sleep(200);
  her.ws.close();
  await sleep(500);
  check("host handover on leave", him.room.hostId === him.joined.meId);
  check("room never stays stuck locked", him.room.locked === false);
  him.ws.close();

  // ---- jam access toggle ----
  const a = await client("a");
  a.send({ type: "join", room: "acc", name: "a" });
  await sleep(300);
  check("open mode lets anyone walk in", a.jam && a.jam.access.mode === "open");

  a.send({ type: "setAccess", mode: "link" });
  await sleep(300);
  const key = a.jam.access.key;
  check("switched to link-only with a key", a.jam.access.mode === "link" && !!key);

  const stranger = await client("stranger");
  stranger.send({ type: "join", room: "acc", name: "stranger" });
  await sleep(400);
  check("stranger without the key is denied", stranger.got("denied").length === 1);

  const invited = await client("invited");
  invited.send({ type: "join", room: "acc", name: "invited", key });
  await sleep(400);
  check("invited with the key gets in", !!invited.jam && invited.jam.members.length === 2);

  // re-locking mints a new key so old links die
  a.send({ type: "setAccess", mode: "open" });
  await sleep(200);
  a.send({ type: "setAccess", mode: "link" });
  await sleep(300);
  check("re-locking rotates the key", a.jam.access.key !== key);

  const stale = await client("stale");
  stale.send({ type: "join", room: "acc", name: "stale", key });
  await sleep(400);
  check("old link no longer works", stale.got("denied").length === 1);

  // always hand the server back the way we found it: leaving it link-only
  // would lock every later suite out of the jam
  a.send({ type: "setAccess", mode: "open" });
  await sleep(300);

  console.log(results.join("\n"));
  [a, invited].forEach((c) => c.ws.close());
  process.exit(process.exitCode || 0);
})();



