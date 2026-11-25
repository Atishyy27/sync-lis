// Change 2: after a dropped connection the service worker keeps trying to get
// back into the room instead of giving up after one failed attempt.
// Runs the real extension/sw.js (fake chrome) against the mock relay on
// 127.0.0.1. Timers are scaled down 50x so the 110 s retry ladder takes ~2 s.
import test from "node:test";
import assert from "node:assert/strict";
import { startMockRelay, waitFor } from "../mock/relay-server.mjs";
import { makeChrome, loadSw } from "../mock/chrome.mjs";

const SCALE = 50;
const TAB = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = (agent) => agent.got.filter((m) => m.type === "note").map((m) => m.text);

async function start(t, { relayOpts } = {}) {
  const relay = await startMockRelay(relayOpts);
  const fake = makeChrome();
  const sw = loadSw({ fake, scale: SCALE });
  t.after(async () => {
    await fake.send({ target: "sync", type: "leave", tabId: TAB });
    await relay.close();
  });
  const made = await fake.send({ target: "sync", type: "create", tabId: TAB, server: relay.url, name: "host", avatar: "" });
  assert.ok(made && made.code, `room created: ${JSON.stringify(made)}`);
  const agent = fake.connectAgent(TAB);
  return { relay, fake, sw, agent, code: made.code };
}

test("a network drop shorter than the retry ladder does not end the session", async (t) => {
  const { relay, sw, agent, code } = await start(t);
  const first = sw.sessions().get(TAB);
  relay.ctl.refusing = true;
  relay.dropAll();
  await sleep(250);                    // network is down for a while: 3 attempts fail
  relay.ctl.refusing = false;
  const back = await waitFor(() => {
    const s = sw.sessions().get(TAB);
    return s && s !== first && s.code === code && s.ws.readyState === 1 ? s : null;
  }, 3000);
  assert.ok(back, "session is back in the same room");
  assert.ok(relay.ctl.refused >= 2, `it really had to retry, refused=${relay.ctl.refused}`);
  assert.equal(agent.got.some((m) => m.type === "ended"), false, "panel never told the room ended");
  const said = notes(agent).join(" | ");
  assert.match(said, /reconnecting/i);
  assert.match(said, /back in the room/i);
});

test("the room the relay no longer has ends the session at once, with one attempt", async (t) => {
  const { relay, agent } = await start(t);
  const before = relay.ctl.upgrades;
  relay.dropAll();
  relay.wipe();
  const ended = await waitFor(() => agent.got.some((m) => m.type === "ended"), 3000);
  assert.ok(ended, "panel is told the room ended");
  assert.equal(relay.ctl.upgrades - before, 1, "no pointless retries for a room that is gone");
});

test("gives up after the last wait of the ladder, not before", async (t) => {
  const { relay, sw, agent } = await start(t);
  const before = relay.ctl.upgrades;
  relay.ctl.refusing = true;
  relay.dropAll();
  await sleep(1500);
  assert.equal(agent.got.some((m) => m.type === "ended"), false, "still trying after about 75 s of real time");
  const ended = await waitFor(() => agent.got.some((m) => m.type === "ended"), 4000);
  assert.ok(ended, "ends after the ladder");
  assert.equal(relay.ctl.upgrades - before, 8, "eight attempts");
  assert.equal(sw.sessions().get(TAB), undefined);
});

test("leaving while it is still reconnecting stops the attempts", async (t) => {
  const { relay, fake, sw } = await start(t);
  relay.ctl.refusing = true;
  relay.dropAll();
  await waitFor(() => relay.ctl.refused >= 1, 2000);
  await fake.send({ target: "sync", type: "leave", tabId: TAB });
  const n = relay.ctl.upgrades;
  await sleep(600);
  assert.equal(relay.ctl.upgrades, n, "no more attempts after leaving");
  assert.equal(sw.sessions().get(TAB), undefined);
});

test("the panel's own leave button works while it is reconnecting", async (t) => {
  const { relay, sw, agent } = await start(t);
  relay.ctl.refusing = true;
  relay.dropAll();
  await waitFor(() => relay.ctl.refused >= 1, 2000);
  agent.handle({ type: "leave" });
  const n = relay.ctl.upgrades;
  await sleep(600);
  assert.equal(relay.ctl.upgrades, n);
  assert.equal(sw.sessions().get(TAB), undefined);
});

test("leaving while an attempt is in flight does not bring the room back", async (t) => {
  const { relay, fake, sw } = await start(t);
  relay.ctl.upgradeDelayMs = 120;      // the relay is slow to answer
  const before = relay.ctl.upgrades;
  relay.dropAll();
  await waitFor(() => relay.ctl.upgrades > before, 2000);
  await fake.send({ target: "sync", type: "leave", tabId: TAB });
  await sleep(500);
  assert.equal(sw.sessions().get(TAB), undefined, "no session came back");
  assert.equal(relay.liveSockets(), 0, "and no socket is left open");
});

test("a relay that accepts the connection but never answers does not stall the retries", async (t) => {
  const { relay, sw, code } = await start(t);
  const first = sw.sessions().get(TAB);
  relay.ctl.upgradeDelayMs = 700;      // longer than one attempt is allowed to take
  relay.dropAll();
  await sleep(60);
  relay.ctl.upgradeDelayMs = 0;        // the next attempt gets through
  const back = await waitFor(() => {
    const s = sw.sessions().get(TAB);
    return s && s !== first && s.code === code && s.ws.readyState === 1 ? s : null;
  }, 3000);
  assert.ok(back, "recovered although the first attempt hung");
});

test("QA: the relay answering 503 on first contact reports it, no session is left", async (t) => {
  const relay = await startMockRelay();
  const fake = makeChrome();
  loadSw({ fake, scale: SCALE });
  t.after(() => relay.close());
  relay.ctl.refusing = true;
  const res = await fake.send({ target: "sync", type: "create", tabId: 7, server: relay.url, name: "x", avatar: "" });
  assert.match(res.error, /Couldn't reach/);
});

test("QA: joining a code the relay does not know says so", async (t) => {
  const relay = await startMockRelay();
  const fake = makeChrome();
  loadSw({ fake, scale: SCALE });
  t.after(() => relay.close());
  const res = await fake.send({ target: "sync", type: "join", tabId: 8, server: relay.url, name: "x", code: "ZZZZZ", avatar: "" });
  assert.equal(res.error, "No session with that code.");
});

test("while reconnecting it keeps the service worker awake, and stops once back", async (t) => {
  const { relay, fake, sw, code } = await start(t);
  const first = sw.sessions().get(TAB);
  relay.ctl.refusing = true;
  relay.dropAll();
  const n0 = fake.calls.platformInfo;
  await sleep(1000);                   // 50 s of real time at this scale: two 20 s beats
  assert.ok(fake.calls.platformInfo - n0 >= 2, `an extension API was called, got ${fake.calls.platformInfo - n0}`);
  relay.ctl.refusing = false;
  await waitFor(() => { const s = sw.sessions().get(TAB); return s && s !== first && s.ws.readyState === 1; }, 4000);
  const n1 = fake.calls.platformInfo;
  await sleep(500);
  assert.equal(fake.calls.platformInfo, n1, "no more calls once it is back");
});

test("a rejoin whose agent cannot be injected tells the panel the room ended", async (t) => {
  const { relay, fake, agent } = await start(t);
  fake.flags.failInject = true;
  relay.dropAll();
  const ended = await waitFor(() => agent.got.some((m) => m.type === "ended"), 3000);
  assert.ok(ended, "the panel is not left saying reconnecting");
});
