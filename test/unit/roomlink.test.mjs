// Change 3: what counts as a room link, and joining an invite tab that was
// already open when the extension was installed.
// Real extension/sw.js and extension/joinlink.js on a fake chrome; the
// end-to-end case fetches the invite page from the mock relay.
import test from "node:test";
import assert from "node:assert/strict";
import { startMockRelay, waitFor } from "../mock/relay-server.mjs";
import { makeChrome, loadSw, runJoinlink } from "../mock/chrome.mjs";

const DEFAULT = "https://sync-lis-relay.sync-lis-relay.workers.dev";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a WebSocket that records where it was pointed and never connects
function spySocket() {
  const urls = [];
  class Spy {
    constructor(url) { urls.push(url); this.readyState = 0; }
    close() {} send() {}
  }
  return { Spy, urls };
}

test("sw: a reddit /r/funny page does not make the extension open a connection", async () => {
  const { Spy, urls } = spySocket();
  const fake = makeChrome();
  loadSw({ fake, WebSocketImpl: Spy });
  await fake.fireUpdated(5, "https://www.reddit.com/r/funny");
  await fake.fireUpdated(5, "https://www.reddit.com/r/music/");
  assert.deepEqual(urls, []);
});

test("sw: the default relay's room link still joins from the address bar", async () => {
  const { Spy, urls } = spySocket();
  const fake = makeChrome();
  loadSw({ fake, WebSocketImpl: Spy });
  await fake.fireUpdated(5, `${DEFAULT}/r/ABCDE`);
  assert.deepEqual(urls, [`${DEFAULT.replace("https", "wss")}`]);
});

test("sw: another host's room link is left to joinlink.js, which can see the page", async () => {
  const { Spy, urls } = spySocket();
  const fake = makeChrome();
  loadSw({ fake, WebSocketImpl: Spy });
  await fake.fireUpdated(5, "http://192.168.1.7:7777/r/ABCDE");
  assert.deepEqual(urls, []);
});

test("a person in a room is not dropped from it by a reddit /r/ link in the same tab", async (t) => {
  const relay = await startMockRelay();
  const fake = makeChrome();
  const sw = loadSw({ fake });
  t.after(async () => { await fake.send({ target: "sync", type: "leave", tabId: 3 }); await relay.close(); });
  const made = await fake.send({ target: "sync", type: "create", tabId: 3, server: relay.url, name: "host", avatar: "" });
  assert.ok(made.code);
  const mine = sw.sessions().get(3);
  await fake.fireUpdated(3, "https://www.reddit.com/r/funny");
  await sleep(100);
  assert.equal(sw.sessions().get(3), mine, "same live session");
  assert.equal(mine.ws.readyState, 1);
});

test("joinlink: default relay page joins and swaps the install pitch", () => {
  const { sent, els } = runJoinlink({ href: `${DEFAULT}/r/abcde` });
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { target: "sync", type: "linkJoin", origin: DEFAULT, code: "ABCDE" });
  assert.equal(els.need.style.display, "none");
  assert.equal(els.have.style.display, "block");
});

test("joinlink: reddit /r/funny does nothing, page untouched", () => {
  const { sent, els } = runJoinlink({ href: "https://www.reddit.com/r/funny" });
  assert.deepEqual(sent, []);
  assert.equal(els.need.style.display, undefined);
});

test("joinlink: a self-hosted relay is recognised by the marker on its own page", () => {
  const { sent } = runJoinlink({ href: "http://192.168.1.7:7777/r/ABCDE", meta: "ABCDE" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].origin, "http://192.168.1.7:7777");
});

test("joinlink: a marker for a different code does not count", () => {
  const { sent } = runJoinlink({ href: "http://192.168.1.7:7777/r/ABCDE", meta: "ZZZZZ" });
  assert.deepEqual(sent, []);
});

test("joinlink: a second injection into the same page does not throw", () => {
  assert.doesNotThrow(() => {
    // same world twice, as when the extension is installed into a tab that already ran it
    const sent = [];
    runJoinlink({ href: `${DEFAULT}/r/ABCDE`, sent });
    runJoinlink({ href: `${DEFAULT}/r/ABCDE`, sent });
  });
});

test("install: tabs shaped like a room link get joinlink.js, the script itself decides", async () => {
  const fake = makeChrome();
  loadSw({ fake });
  fake.setQuery([
    { id: 11, url: `${DEFAULT}/r/ABCDE` },
    { id: 12, url: "http://192.168.1.7:7777/r/QWERT" },
    { id: 13, url: "https://www.reddit.com/r/funny" },              // same shape; joinlink.js declines it
    { id: 14, url: "https://www.reddit.com/r/funny/comments/x" },   // not the shape
    { id: 15, url: "https://example.com/r/" },
  ]);
  await fake.fireInstalled("install");
  await sleep(20);
  const injected = fake.calls.executeScript.map((c) => [c.target.tabId, c.files.join()]);
  assert.deepEqual(injected, [[11, "joinlink.js"], [12, "joinlink.js"], [13, "joinlink.js"]]);
});

test("end to end: invite page from the mock relay -> joinlink -> service worker -> same room", async (t) => {
  const relay = await startMockRelay();
  const host = makeChrome();
  const guest = makeChrome({ name: "guest" });
  loadSw({ fake: host });
  const gsw = loadSw({ fake: guest });
  t.after(async () => {
    await host.send({ target: "sync", type: "leave", tabId: 1 });
    await guest.send({ target: "sync", type: "leave", tabId: 2 });
    await relay.close();
  });

  const made = await host.send({ target: "sync", type: "create", tabId: 1, server: relay.url, name: "host", avatar: "" });
  const html = await (await fetch(`${relay.url}/r/${made.code}`)).text();
  const meta = /<meta name="sync-lis-room" content="([A-Z0-9]{5})">/.exec(html);
  assert.ok(meta, "the invite page carries the marker");

  // the guest's tab opens the link; the content script runs on the page the relay served
  const sent = [];
  runJoinlink({ href: `${relay.url}/r/${made.code}`, meta: meta[1], sent });
  assert.equal(sent.length, 1);
  await guest.send(sent[0], { tab: { id: 2 } });

  const s = await waitFor(() => { const x = gsw.sessions().get(2); return x && x.code === made.code && x.ws.readyState === 1 ? x : null; });
  assert.ok(s, "guest is in the host's room");
  const inRoom = await waitFor(() => relay.liveSockets() === 2);
  assert.ok(inRoom, "two sockets in the room");
});
