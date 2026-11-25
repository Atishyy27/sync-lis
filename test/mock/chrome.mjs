// A fake `chrome` for running the real extension/sw.js and extension/joinlink.js
// under Node (vm). Records what the extension does; no browser involved.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const EXT = path.join(import.meta.dirname, "..", "..", "extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

const listener = () => {
  const list = [];
  return { list, addListener: (f) => list.push(f) };
};

export function makeChrome({ tabs = {}, name = "tester" } = {}) {
  const calls = { executeScript: [], tabsUpdate: [], created: [], platformInfo: 0 };
  const flags = { failInject: false };
  const ev = { onMessage: listener(), onConnect: listener(), onUpdated: listener(), onRemoved: listener(), onInstalled: listener() };
  let queryResult = [];
  const chrome = {
    runtime: {
      setUninstallURL() {},
      getURL: (p) => `chrome-extension://test/${p}`,
      getPlatformInfo: () => { calls.platformInfo++; return Promise.resolve({}); },
      sendMessage: () => Promise.resolve(null),
      onMessage: ev.onMessage, onConnect: ev.onConnect, onInstalled: ev.onInstalled,
    },
    tabs: {
      onUpdated: ev.onUpdated, onRemoved: ev.onRemoved,
      get: async (id) => tabs[id] || { id, url: "https://www.youtube.com/watch?v=abc" },
      update: async (id, props) => { calls.tabsUpdate.push({ id, ...props }); },
      create: async (p) => { calls.created.push(p); },
      query: async () => queryResult,
    },
    scripting: { executeScript: async (a) => { if (flags.failInject) throw new Error("cannot script this tab"); calls.executeScript.push(a); } },
    storage: { local: { get: async (d) => ({ ...d, name }), set: async () => {} } },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
  };

  const send = (msg, sender = {}) => new Promise((resolve) => {
    let answered = false, wait = false;
    const respond = (v) => { answered = true; resolve(v); };
    for (const l of ev.onMessage.list) { if (l(msg, sender, respond) === true) wait = true; }
    if (!wait && !answered) resolve(undefined);
  });

  // an agent (content.js) attaching to the service worker
  const connectAgent = (tabId) => {
    const port = {
      name: "sync-lis", sender: { tab: { id: tabId } }, got: [],
      postMessage(m) { this.got.push(m); },
      onMessage: { addListener(f) { port.handle = f; } },
      onDisconnect: { addListener(f) { port.disconnect = f; } },
    };
    for (const l of ev.onConnect.list) l(port);
    return port;
  };

  return {
    chrome, calls, flags, send, connectAgent,
    setQuery: (r) => { queryResult = r; },
    fireUpdated: (tabId, url) => Promise.all(ev.onUpdated.list.map((l) => l(tabId, { status: "complete" }, { id: tabId, url }))),
    fireInstalled: (reason) => Promise.all(ev.onInstalled.list.map((l) => l({ reason }))),
  };
}

// Run extension/sw.js in a context with this fake chrome. `scale` shrinks every
// timer so a 30 s retry wait takes a fraction of a second. `WebSocketImpl`
// defaults to Node's own WebSocket client, pointed at the mock relay.
export function loadSw({ fake, WebSocketImpl = globalThis.WebSocket, scale = 1 } = {}) {
  const sandbox = {
    chrome: fake.chrome, WebSocket: WebSocketImpl, URL, console,
    setTimeout: (fn, ms, ...a) => setTimeout(fn, Math.max(1, (ms || 0) / scale), ...a),
    setInterval: (fn, ms, ...a) => setInterval(fn, Math.max(1, (ms || 0) / scale), ...a),
    clearTimeout, clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(read("sw.js"), sandbox, { filename: "sw.js" });
  return { ctx: sandbox, sessions: () => vm.runInContext("sessions", sandbox) };
}

// Run extension/joinlink.js as the content script on a page.
export function runJoinlink({ href, meta = null, sent = [] }) {
  const els = { need: { style: {} }, have: { style: {} } };
  const sandbox = {
    chrome: { runtime: { sendMessage: (m) => { sent.push(m); } } },
    location: { href },
    document: {
      readyState: "complete",
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === 'meta[name="sync-lis-room"]' && meta ? { content: meta } : null),
      addEventListener() {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(read("joinlink.js"), sandbox, { filename: "joinlink.js" });
  return { sent, els };
}
