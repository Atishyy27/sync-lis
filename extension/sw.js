// sync-lis service worker — session manager.
// Holds one WebSocket per synced tab (page CSP can't touch it here), injects
// the agent, follows the room's content by navigating the tab, and re-injects
// after every navigation.

const sessions = new Map(); // tabId -> session
// A tab can be told to join by two paths (the room-link content script and
// tabs.onUpdated). startSession only lands in `sessions` once the server
// answers, so without a synchronous claim both paths would open a socket and
// the room would show the same person twice.
const joining = new Set();

async function joinTabOnce(tabId, origin, code) {
  if (joining.has(tabId)) return;
  const open = sessions.get(tabId);
  if (open) {
    if (open.code === code) return;      // already here
    // opening a different room link moves you into that room, rather than
    // silently doing nothing until you remember to press Leave
    sessions.delete(tabId);
    open.retries = 99;
    try { open.ws.close(); } catch {}
  }
  joining.add(tabId);
  try {
    const { name } = await chrome.storage.local.get({ name: "" });
    await startSession(tabId, origin, name || "friend", {
      type: "syncJoin", code, name: name || "friend",
    });
  } finally {
    joining.delete(tabId);
  }
}

const NETFLIX_RE = /^https?:\/\/([^/]*\.)?netflix\.com\//;
const ROOM_LINK_RE = /^(https?:\/\/[^/]+)\/r\/([A-Z0-9]{5})\/?$/i;

function pushToPorts(s) {
  const msg = {
    type: "state", state: s.state, content: s.content, offset: s.offset,
    room: {
      code: s.code, server: s.server, meId: s.meId, members: s.members,
      hostId: s.hostId, locked: s.locked, countdownAt: s.countdownAt,
      lastAction: s.lastAction, queue: s.queue || [],
    },
  };
  for (const port of s.ports) {
    try { port.postMessage(msg); } catch {}
  }
}

function relayToPorts(s, msg) {
  for (const port of s.ports) {
    try { port.postMessage(msg); } catch {}
  }
}

function endPorts(s) {
  for (const port of s.ports) {
    try { port.postMessage({ type: "ended" }); } catch {}
  }
}

async function injectAgent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["ui.js", "content.js"] });
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && NETFLIX_RE.test(tab.url)) {
    // Netflix ignores currentTime writes; its own player API lives in MAIN world
    await chrome.scripting.executeScript({ target: { tabId }, files: ["netflix-page.js"], world: "MAIN" });
  }
}

// The room's content changed (or we just joined): put this tab on it.
// A navigation can quietly fail to take — most often when it races the load of
// the page the user just opened — so an in-flight attempt expires and is
// retried rather than being trusted forever.
const NAV_RETRY_MS = 5000;

const sameUrl = (a, b) => {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
  } catch { return false; }
};

async function followContent(tabId, s) {
  if (!s.content || !s.content.url) return;
  if (s.content.key === s.agentKey) return;  // already watching it
  // Rejoining a room you never really left should not reload your tab. The
  // agent has not reported yet at this point, so the URL is what we have.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url && sameUrl(tab.url, s.content.url)) return;
  } catch {}
  if (s.navigatingTo === s.content.key && Date.now() - (s.navAt || 0) < NAV_RETRY_MS) return;
  s.navigatingTo = s.content.key;
  s.navAt = Date.now();
  try {
    await chrome.tabs.update(tabId, { url: s.content.url });
  } catch {
    s.navigatingTo = null;
  }
}

function startSession(tabId, server, name, joinMsg) {
  return new Promise((resolve) => {
    const s = {
      code: null, server, name, ws: null,
      state: null, content: null, offset: 0, members: [],
      ports: new Set(), agentKey: null, navigatingTo: null, retries: 0, beat: null,
    };
    const ws = new WebSocket(server.replace(/^http/, "ws"));
    s.ws = ws;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "pong") {
        // round-trip halved: the same estimate the join handshake makes, but
        // refreshed, so a long session cannot drift on a stale offset
        const rtt = Date.now() - msg.t;
        s.offset = msg.now + rtt / 2 - Date.now();
        return;
      }
      if (msg.type === "syncJoined") {
        s.code = msg.code;
        s.offset = msg.now - Date.now();
        s.content = msg.content || null;
        s.state = msg.state || null;
        s.meId = msg.meId;
        s.history = msg.history || [];
        // never let two sessions share a tab; the older one loses its socket
        const prev = sessions.get(tabId);
        if (prev && prev !== s) {
          prev.retries = 99;
          try { prev.ws.close(); } catch {}
        }
        sessions.set(tabId, s);
        // An MV3 service worker is killed after 30s of inactivity, and killing
        // it takes this WebSocket -- and the whole session -- with it. Sending
        // over the socket resets that idle timer (Chrome 116+), so a quiet
        // room (paused video, nobody talking) is exactly the case that would
        // otherwise die on its own. The server already answers {type:"ping"}
        // with a live timestamp, so the same beat doubles as a clock-offset
        // refresh instead of trusting the one taken at join.
        clearInterval(s.beat);
        s.beat = setInterval(() => {
          if (s.ws.readyState !== 1) return;
          try { s.ws.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch {}
        }, 20000);
        try {
          await injectAgent(tabId);
        } catch {
          ws.close();
          sessions.delete(tabId);
          return done({ error: "Can't control this page (browser-internal or protected tab)." });
        }
        if (s.content) followContent(tabId, s);
        done({ code: s.code });
      } else if (msg.type === "syncState") {
        // Two people can turn voice on within the same broadcast window: each
        // one's "call everyone already talking" snapshot is taken before the
        // other's flag has arrived, so neither calls the other and voice
        // silently connects to nobody. Whenever this tab is already talking
        // and the room shows someone ELSE newly on voice, dial them too.
        if (voiceTabId === tabId) {
          const before = new Set((s.members || []).filter((m) => m.voice).map((m) => m.id));
          const nowIds = new Set();
          for (const m of msg.members || []) {
            if (m.id === s.meId) continue;
            if (m.voice) {
              nowIds.add(m.id);
              if (!before.has(m.id)) toVoice({ type: "call", peerId: m.id });
            }
          }
          // the mirror of the call fix above: someone turning voice off (or
          // leaving the room) never told the other side to hang up, so a
          // dead connection sat there reading "connected" until WebRTC's own
          // much slower ICE timeout eventually noticed.
          for (const id of before) {
            if (!nowIds.has(id)) toVoice({ type: "peerLeft", peerId: id });
          }
        }
        s.state = msg.state;
        s.content = msg.content;
        s.offset = msg.now - Date.now();
        s.members = msg.members;
        s.hostId = msg.hostId;
        s.locked = msg.locked;
        s.countdownAt = msg.countdownAt;
        s.lastAction = msg.lastAction;
        // this was silently dropped before — the jam queue never reached the
        // panel, even though the server tracked it correctly the whole time
        s.queue = msg.queue || [];
        followContent(tabId, s);
        pushToPorts(s);
      } else if (msg.type === "syncSignal") {
        toVoice({ type: "signal", from: msg.from, data: msg.data });
      } else if (msg.type === "syncNarrate") {
        s.history.push(msg);
        relayToPorts(s, { type: "narrate", text: msg.text });
      } else if (msg.type === "syncSaid") {
        s.history.push(msg);
        relayToPorts(s, { type: "note", text: msg.text });
      } else if (msg.type === "syncSting") {
        relayToPorts(s, { type: "sting", kind: msg.kind, from: msg.from });
      } else if (msg.type === "syncBig") {
        relayToPorts(s, { type: "big", emoji: msg.emoji, from: msg.from });
      } else if (msg.type === "syncSecret") {
        relayToPorts(s, { type: "secret", text: msg.text, from: msg.from });
      } else if (msg.type === "syncTyping") {
        if (msg.fromId !== s.meId) relayToPorts(s, { type: "typing", from: msg.from });
      } else if (msg.type === "syncChat") {
        s.history.push(msg);
        relayToPorts(s, { type: "chat", from: msg.from, text: msg.text, videoTime: msg.videoTime });
      } else if (msg.type === "syncReact") {
        // your own reaction floats on your screen too; it used to be filtered
        // out back when the page drew it locally on click
        relayToPorts(s, { type: "react", emoji: msg.emoji, from: msg.from });
      } else if (msg.type === "syncNote") {
        relayToPorts(s, { type: "note", text: msg.text });
      } else if (msg.type === "syncError") {
        done({ error: msg.text });
        ws.close();
      }
    };
    ws.onerror = () => done({ error: `Couldn't reach ${server}.` });
    ws.onclose = () => {
      clearInterval(s.beat);
      s.beat = null;
      if (sessions.get(tabId) !== s) return;
      // a network blip is not the end of the session: rejoin the same code
      if (s.code && s.retries < 3) {
        s.retries++;
        setTimeout(async () => {
          if (sessions.get(tabId) !== s) return;
          const again = await startSession(tabId, server, name, { type: "syncJoin", code: s.code, name });
          const s2 = sessions.get(tabId);
          if (again.error || !s2) {
            sessions.delete(tabId);
            endPorts(s);
          } else {
            s2.ports = s.ports;   // the agent's port outlives the socket
            s2.agentKey = s.agentKey;
            pushToPorts(s2);
          }
        }, 1500 * s.retries);
        return;
      }
      sessions.delete(tabId);
      endPorts(s);
    };
    ws.onopen = () => ws.send(JSON.stringify(joinMsg));
  });
}

// ---------- voice ----------
// The offscreen document owns the microphone and the peer connections; this
// worker only introduces people to each other and carries the handshake.

let voiceTabId = null;

async function ensureVoiceDoc() {
  const has = await chrome.offscreen.hasDocument();
  if (!has) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA", "WEB_RTC"],
      justification: "Carries voice chat between people watching together.",
    });
  }
}

function toVoice(msg) {
  return chrome.runtime.sendMessage({ target: "voice", ...msg }).catch(() => null);
}

async function startVoice(tabId) {
  const s = sessions.get(tabId);
  if (!s) return { error: "not in a room" };
  await ensureVoiceDoc();
  // everyone already talking; we are the newcomer, so we place the calls
  const peers = (s.members || []).filter((m) => m.voice && m.id !== s.meId).map((m) => m.id);
  const res = await toVoice({ type: "join", peers });
  if (res && res.error) {
    if (res.error === "NotAllowedError" || res.error === "NotFoundError") {
      chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
      return { error: "mic" };
    }
    return { error: res.error };
  }
  voiceTabId = tabId;
  if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "syncVoice", on: true }));
  // voice takes two: say so rather than looking like it silently failed
  if (!peers.length) {
    relayToPorts(s, { type: "note", text: "Voice is on for you. You'll hear them once they turn theirs on too." });
  }
  return { ok: true };
}

function stopVoice(tabId) {
  const s = sessions.get(tabId);
  if (s && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "syncVoice", on: false }));
  voiceTabId = null;
  toVoice({ type: "leave" });
}

// the voice engine asking us to pass a handshake message along
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "sw-voice") return;
  const s = voiceTabId != null ? sessions.get(voiceTabId) : null;
  if (!s || s.ws.readyState !== 1) return;
  if (msg.type === "signal") {
    s.ws.send(JSON.stringify({ type: "syncSignal", to: msg.to, data: msg.data }));
  }
  // speech detection lives in the offscreen document (that is where the peer
  // audio is), but the thing to turn down is the page's player, so the verdict
  // has to travel to the content script.
  if (msg.type === "speaking") relayToPorts(s, { type: "duck", on: !!msg.on });
});

// ---------- popup API ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "sync") return;

  // a room-link page asking to be joined (see joinlink.js)
  if (msg.type === "linkJoin" && sender.tab) {
    joinTabOnce(sender.tab.id, msg.origin, msg.code);
    return;
  }

  if (msg.type === "status") {
    const s = sessions.get(msg.tabId);
    sendResponse(s ? { code: s.code, members: s.members, server: s.server, content: s.content } : null);
    return;
  }
  if (msg.type === "create") {
    startSession(msg.tabId, msg.server, msg.name, { type: "syncCreate", name: msg.name, avatar: msg.avatar }).then(sendResponse);
    return true;
  }
  if (msg.type === "join") {
    startSession(msg.tabId, msg.server, msg.name, { type: "syncJoin", code: msg.code, name: msg.name, avatar: msg.avatar }).then(sendResponse);
    return true;
  }
  if (msg.type === "leave") {
    const s = sessions.get(msg.tabId);
    sessions.delete(msg.tabId);
    if (s) { s.retries = 99; s.ws.close(); endPorts(s); }
    sendResponse(true);
  }
});

// ---------- agent connection ----------
//
// One port per tab. There used to be a second, separate port for a Chrome
// side-panel UI; the panel now lives on the page itself (injected alongside
// the video-driving agent), so it is the same "sync-lis" connection — nothing
// distinguishes UI from agent any more, because they are the same script.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sync-lis" || !port.sender.tab) return;
  const tabId = port.sender.tab.id;
  const joined = sessions.get(tabId);
  if (!joined) {
    try { port.postMessage({ type: "ended" }); } catch {}
    return;
  }
  joined.ports.add(port);
  // A fresh connection — first join, or a reconnect after navigating between
  // synced pages — gets the conversation replayed, not an empty box.
  if (joined.history && joined.history.length) {
    try { port.postMessage({ type: "history", items: joined.history }); } catch {}
  }
  if (joined.state) pushToPorts(joined);

  const RELAY = {
    hold: (m) => ({ type: "syncHold", holding: m.holding }),
    away: (m) => ({ type: "syncAway", away: m.away }),
    typing: () => ({ type: "syncTyping" }),
    identity: (m) => ({ type: "syncIdentity", name: m.name, avatar: m.avatar }),
    sting: (m) => ({ type: "syncSting", kind: m.kind }),
    big: (m) => ({ type: "syncBig", emoji: m.emoji }),
    secret: (m) => ({ type: "syncSecret", text: m.text }),
    queueAdd: (m) => ({ type: "syncQueueAdd", url: m.url, key: m.key, title: m.title, kind: m.kind }),
    queueRemove: (m) => ({ type: "syncQueueRemove", id: m.id }),
    queueNext: () => ({ type: "syncQueueNext" }),
    ended: (m) => ({ type: "syncEnded", key: m.key }),
    pos: (m) => ({ type: "syncPos", time: m.time }),
    chat: (m) => ({ type: "syncChat", text: m.text }),
    react: (m) => ({ type: "syncReact", emoji: m.emoji }),
    ready: (m) => ({ type: "syncReady", ready: m.ready }),
    hostLock: (m) => ({ type: "syncHostLock", locked: m.locked }),
  };

  port.onMessage.addListener((m) => {
    // Resolve the CURRENT session every time. A reconnect swaps in a new
    // session object, and a handler closed over the old one would keep
    // checking a dead socket — the agent would still receive state while
    // every command it sent vanished.
    const s = sessions.get(tabId);
    if (!s || s.ws.readyState !== 1) return;
    if (RELAY[m.type]) {
      s.ws.send(JSON.stringify(RELAY[m.type](m)));
    } else if (m.type === "cmd") {
      s.ws.send(JSON.stringify({ type: "syncCmd", action: m.action, time: m.time, key: m.key }));
    } else if (m.type === "voice") {
      (m.on ? startVoice(tabId) : Promise.resolve(stopVoice(tabId)))
        .then((r) => relayToPorts(s, { type: "voiceState", on: !!(r && r.ok), error: r && r.error }));
    } else if (m.type === "mute") {
      toVoice({ type: "mute", muted: m.muted });
    } else if (m.type === "content") {
      s.agentKey = m.key;
      if (s.navigatingTo === m.key) s.navigatingTo = null;
      // tell the room what we're on (server ignores it if unchanged)
      s.ws.send(JSON.stringify({
        type: "syncContent", key: m.key, url: m.url, title: m.title, kind: m.kind, time: m.time,
      }));
    } else if (m.type === "leave") {
      // the on-page panel can leave the room directly, same as the popup does
      sessions.delete(tabId);
      s.retries = 99;
      try { s.ws.close(); } catch {}
      endPorts(s);
    }
  });
  port.onDisconnect.addListener(() => {
    joined.ports.delete(port);
    const cur = sessions.get(tabId);
    if (cur) cur.ports.delete(port);
  });
});

// ---------- navigation: re-inject, and auto-join room links ----------

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;

  // clicking a room link joins that room in that tab — the link carries the relay
  const m = ROOM_LINK_RE.exec(tab.url);
  if (m) {
    await joinTabOnce(tabId, m[1], m[2].toUpperCase());
    return;
  }

  // an existing session's tab navigated: the agent went with the old page
  const s = sessions.get(tabId);
  if (!s) return;
  try {
    await injectAgent(tabId);
  } catch {
    // some pages can't be scripted; session stays alive for the next navigation
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  s.retries = 99;
  try { s.ws.close(); } catch {}
});
