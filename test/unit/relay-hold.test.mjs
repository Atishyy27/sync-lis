// Change 1: an empty room is held for a while instead of deleted at once.
// Runs the real worker/src/SyncRelay.js on a fake Durable Object runtime, with
// the clock under test control. No network, no wrangler.
import test from "node:test";
import assert from "node:assert/strict";
import { createRelay, FakeSocket } from "../mock/do-runtime.mjs";

const TTL = 10 * 60 * 1000;

async function setup(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_700_000_000_000 });
  t.mock.method(console, "log", () => {});   // the relay logs one JSON line per event
  const env = await createRelay();
  const client = () => {
    const sock = new FakeSocket();
    env.state.acceptWebSocket(sock);
    return {
      sock,
      say: (m) => env.relay.webSocketMessage(sock, JSON.stringify(m)),
      drop: async () => { sock.closed = true; await env.relay.webSocketClose(sock, 1006, "", false); },
      msgs: () => sock.sent.map((s) => JSON.parse(s)),
      last: (type) => sock.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type).at(-1),
    };
  };
  return { ...env, client };
}

async function openRoom(env, name = "host") {
  const host = env.client();
  await host.say({ type: "syncCreate", name });
  return { host, code: host.last("syncJoined").code };
}

test("a room whose last member drops can be rejoined by code", async (t) => {
  const env = await setup(t);
  const { host, code } = await openRoom(env);
  await host.say({ type: "syncChat", text: "hello before the blip" });
  await host.drop();

  const back = env.client();
  await back.say({ type: "syncJoin", code, name: "host" });
  assert.equal(back.last("syncError"), undefined, "rejoin must not be refused");
  const joined = back.last("syncJoined");
  assert.equal(joined.code, code);
  assert.ok(joined.history.some((h) => h.text === "hello before the blip"), "the conversation is still there");
});

test("the first person back becomes host, and the room is not stuck locked", async (t) => {
  const env = await setup(t);
  const { host, code } = await openRoom(env);
  await host.say({ type: "syncHostLock", locked: true });
  await host.drop();

  const back = env.client();
  await back.say({ type: "syncJoin", code, name: "again" });
  const state = back.last("syncState");
  assert.equal(state.locked, false);
  assert.equal(state.hostId, back.last("syncJoined").meId);
});

test("playback does not run on while nobody is in the room", async (t) => {
  const env = await setup(t);
  const { host, code } = await openRoom(env);
  await host.say({ type: "syncContent", key: "yt:abc", url: "https://www.youtube.com/watch?v=abc", title: "t", kind: "youtube", time: 0 });
  await host.say({ type: "syncCmd", action: "play", time: 100, key: "yt:abc" });
  t.mock.timers.tick(5000);
  await host.drop();
  t.mock.timers.tick(4 * 60 * 1000);

  const back = env.client();
  await back.say({ type: "syncJoin", code, name: "host" });
  const state = back.last("syncJoined").state;
  assert.equal(state.paused, true);
  assert.ok(state.time >= 104 && state.time < 106, `frozen near where it was left, got ${state.time}`);
});

test("an empty room is deleted once the hold has run out", async (t) => {
  const env = await setup(t);
  const { host, code } = await openRoom(env);
  await host.drop();
  assert.ok(env.state.storage.alarm != null, "an alarm is set");
  assert.ok(env.state.storage.alarm - Date.now() <= TTL);

  t.mock.timers.tick(TTL - 1000);
  assert.equal(await env.fireAlarmIfDue(), false, "not due yet");
  assert.ok(await env.relay.getRoom(code), "still held just before the end");

  t.mock.timers.tick(2000);
  assert.equal(await env.fireAlarmIfDue(), true);
  assert.equal(await env.relay.getRoom(code), null, "gone after the hold");

  const late = env.client();
  await late.say({ type: "syncJoin", code, name: "late" });
  assert.equal(late.last("syncError").text, "No session with that code.");
});

test("the hold counts from the last time the room emptied", async (t) => {
  const env = await setup(t);
  const { host, code } = await openRoom(env);
  await host.drop();
  t.mock.timers.tick(TTL - 60_000);
  const back = env.client();
  await back.say({ type: "syncJoin", code, name: "host" });
  await back.drop();
  t.mock.timers.tick(TTL - 60_000);   // well past the FIRST emptying
  await env.fireAlarmIfDue();
  assert.ok(await env.relay.getRoom(code), "second emptying restarts the hold");
  t.mock.timers.tick(120_000);
  await env.fireAlarmIfDue();
  assert.equal(await env.relay.getRoom(code), null);
});

test("the alarm never deletes a room that has people in it", async (t) => {
  const env = await setup(t);
  const a = await openRoom(env, "a");
  const b = await openRoom(env, "b");
  await a.host.drop();                       // room A empties, alarm armed
  t.mock.timers.tick(TTL + 1000);
  await env.fireAlarmIfDue();
  assert.equal(await env.relay.getRoom(a.code), null);
  assert.ok(await env.relay.getRoom(b.code), "room B still has its host");
  assert.equal(b.host.sock.closed, false);
});

test("the alarm is re-armed for a room that empties later", async (t) => {
  const env = await setup(t);
  const a = await openRoom(env, "a");
  const b = await openRoom(env, "b");
  await a.host.drop();
  t.mock.timers.tick(5 * 60 * 1000);
  await b.host.drop();                       // empties 5 minutes after A
  t.mock.timers.tick(5 * 60 * 1000 + 1000);
  await env.fireAlarmIfDue();                // A is due, B is not
  assert.equal(await env.relay.getRoom(a.code), null);
  assert.ok(await env.relay.getRoom(b.code), "B is still inside its own hold");
  assert.ok(env.state.storage.alarm != null, "alarm re-armed for B");
  t.mock.timers.tick(5 * 60 * 1000);
  await env.fireAlarmIfDue();
  assert.equal(await env.relay.getRoom(b.code), null);
});

test("a room that still has someone in it is unchanged: host passes on", async (t) => {
  const env = await setup(t);
  const { host, code } = await openRoom(env, "a");
  const b = env.client();
  await b.say({ type: "syncJoin", code, name: "b" });
  await host.drop();
  assert.equal(env.state.storage.alarm, null, "no hold, nobody left the room empty");
  assert.equal(b.last("syncState").hostId, b.last("syncJoined").meId);
});

test("the invite page of a held room says nobody is in it, and carries the room marker", async (t) => {
  const env = await setup(t);
  const { host, code } = await openRoom(env);
  await host.drop();
  const html = await (await env.relay.fetch(new Request(`https://relay.test/r/${code}`))).text();
  assert.match(html, /<meta name="sync-lis-room" content="[A-Z0-9]{5}">/);
  assert.match(html, /nobody inside right now/i);
  assert.doesNotMatch(html, /Room is live/);
});

test("the invite page of a live room still says it is live, and a dead code says so", async (t) => {
  const env = await setup(t);
  const { code } = await openRoom(env);
  const live = await (await env.relay.fetch(new Request(`https://relay.test/r/${code}`))).text();
  assert.match(live, /Room is live/);
  const dead = await (await env.relay.fetch(new Request("https://relay.test/r/ZZZZZ"))).text();
  assert.match(dead, /isn't live right now/);
});

test("/stats counts only live sockets, a held room adds nothing", async (t) => {
  const env = await setup(t);
  const { host } = await openRoom(env);
  await host.drop();
  const r = await env.relay.fetch(new Request("https://relay.test/stats"));
  const j = await r.json();
  assert.equal(j.activeUsers, 0);
  assert.equal(j.activeRooms, 0);
});
