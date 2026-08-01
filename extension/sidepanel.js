// sync-lis side panel.
//
// The panel answers one question — are we together right now — and everything
// else is secondary. So the state line and the sync track are computed every
// frame-ish, and the rest is rendered only when it changes.

"use strict";

const $ = (id) => document.getElementById(id);
const RELAY = "https://desktop-ch7a7q7.tail5847e5.ts.net";

let tabId = null;
let port = null;
let snap = null;
let voiceOn = false;
let myFace = "";

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function tint(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 46%)`;
}

const FACES = ["🎧", "🍿", "👾", "🐙", "🌙", "🔥", "🦊", "🫠", "💀", "🧃", "🪩", "🐈", "🌵", "🧊", "🎃", "👻"];
const EMOJI = ("😂 🤣 😭 😍 🥺 😳 😱 🤯 🫠 💀 👀 🙄 😴 🤡 🫡 🔥 ❤️ 💔 ✨ 🎉 🙌 👏 🤝 👍 " +
  "👎 🍿 🎬 🎧 🕺 💃 🤌 🧠 💯 ⚡ 🐐 🚩").split(" ");
const STINGS = [["drumroll", "drum roll"], ["airhorn", "airhorn"], ["rimshot", "ba dum tss"], ["sad", "sad trombone"]];

const sw = (msg) => chrome.runtime.sendMessage({ target: "sync", ...msg }).catch(() => null);
const tell = (msg) => { try { if (port) port.postMessage(msg); } catch {} };

// ---------- connection ----------

function connect() {
  if (port) { try { port.disconnect(); } catch {} }
  port = chrome.runtime.connect({ name: `sync-lis-panel:${tabId}` });
  port.onMessage.addListener((m) => {
    switch (m.type) {
      case "state": snap = m; render(); break;
      case "history":
        $("stream").innerHTML = "";
        for (const h of m.items) {
          if (h.type === "syncChat") said(h.from, h.text, h.videoTime);
          else did(h.text, h.type === "syncNarrate");
        }
        break;
      case "chat": said(m.from, m.text, m.videoTime); break;
      case "narrate": did(m.text, true); break;
      case "note": did(m.text); break;
      case "secret": said(m.from, m.text, 0); break;
      case "sting": did(`${m.from} played a ${m.kind}`); break;
      case "react": did(`${m.from} ${m.emoji}`); break;
      case "big": did(`${m.from} sent ${m.emoji}`); break;
      case "typing":
        $("typing").textContent = `${m.from} is typing`;
        clearTimeout(window._t);
        window._t = setTimeout(() => { $("typing").textContent = ""; }, 3000);
        break;
      case "voiceState":
        voiceOn = m.on;
        $("voiceBtn").classList.toggle("on", m.on);
        $("voiceBtn").textContent = m.on ? "Voice on" : "Voice";
        $("muteBtn").classList.toggle("hidden", !m.on);
        if (m.error === "mic") did("allow the microphone in the tab that opened, then try again");
        else if (m.error) did(`voice didn't start: ${m.error}`);
        break;
      case "ended": snap = null; render(); break;
    }
  });
  port.onDisconnect.addListener(() => { port = null; });
}

function atBottom() {
  const s = $("stream");
  return s.scrollHeight - s.scrollTop - s.clientHeight < 40;
}
function push(el) {
  const stick = atBottom();
  $("stream").appendChild(el);
  while ($("stream").children.length > 200) $("stream").firstChild.remove();
  if (stick) $("stream").scrollTop = $("stream").scrollHeight;
}

function said(from, text, at) {
  const d = document.createElement("div");
  d.className = "said";
  const img = /(https?:\/\/\S+\.(?:gif|png|jpe?g|webp))/i.exec(text || "");
  d.innerHTML = `<div><span class="from">${esc(from)}</span><span class="at">${fmt(at)}</span></div>` +
    `<div class="body">${esc(text)}</div>` +
    (img ? `<img src="${encodeURI(img[0])}" alt="">` : "");
  push(d);
}

function did(text, isSwitch) {
  const d = document.createElement("div");
  d.className = "did" + (isSwitch ? " switch" : "");
  d.textContent = text;
  push(d);
}

// ---------- render ----------

function render() {
  const inRoom = !!(snap && snap.room);
  $("door").classList.toggle("hidden", inRoom);
  $("live").classList.toggle("hidden", !inRoom);
  if (!inRoom) { $("sheet").classList.add("hidden"); return; }

  const r = snap.room;
  const st = snap.state || { paused: true, time: 0, at: Date.now(), rate: 1 };
  const content = snap.content;
  const members = r.members || [];
  const me = members.find((m) => m.id === r.meId);
  const rate = st.rate || 1;
  const now = st.paused ? st.time : st.time + ((Date.now() + (snap.offset || 0) - st.at) / 1000) * rate;

  $("linkBox").value = `${r.server || RELAY}/r/${r.code}`;
  $("title").textContent = content ? (content.title || content.url) : "nothing yet";
  $("title").classList.toggle("empty", !content);
  $("tNow").textContent = fmt(now);
  $("tRate").textContent = rate === 1 ? (st.paused ? "paused" : "playing") : `${rate}x`;

  // --- the state line: the one thing worth reading ---
  const behind = members.filter((m) => !m.arrived || m.holding);
  const counting = r.countdownAt && r.countdownAt > Date.now();
  const notReady = members.some((m) => m.ready) ? members.filter((m) => !m.ready) : [];
  let line, why = "";

  if (counting) {
    line = `starting in <em>${Math.ceil((r.countdownAt - Date.now()) / 1000)}</em>`;
    why = "everyone said ready";
  } else if (behind.length) {
    const names = behind.map((m) => (m.id === r.meId ? "you" : m.name));
    line = `waiting for <em>${esc(names.join(" and "))}</em>`;
    why = behind.some((m) => !m.arrived) ? "still getting there" : "buffering";
  } else if (notReady.length) {
    line = notReady.some((m) => m.id === r.meId)
      ? "they're ready, <em>waiting on you</em>"
      : `waiting for <em>${esc(notReady.map((m) => m.name).join(" and "))}</em> to be ready`;
    why = "";
  } else if (!content) {
    line = members.length < 2 ? "open something and press play" : "nobody has started anything";
    why = members.length < 2 ? "then send them the link" : "";
  } else if (st.paused) {
    line = "paused";
    why = r.lastAction ? `${r.lastAction.name} ${r.lastAction.action}` : "";
  } else {
    line = "<em>in sync</em>";
    why = members.length > 1 ? `${members.length} watching` : "just you so far";
  }
  $("stateLine").innerHTML = line;
  $("stateWhy").textContent = why;

  // --- the track: one mark per person, spread by how far apart they are ---
  const track = $("track");
  const span = Math.max(2, ...members.map((m) => Math.abs((m.pos || 0) - now)));
  track.innerHTML = "";
  for (const m of members) {
    const drift = (m.pos || 0) - now;
    const mark = document.createElement("span");
    mark.className = "mark" + (Math.abs(drift) > 1.5 ? " lag" : "") + (m.id === r.meId ? " me" : "");
    mark.style.left = `calc(${(50 + (drift / span) * 42).toFixed(1)}% - 1px)`;
    mark.title = `${m.name} ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}s`;
    track.appendChild(mark);
  }

  // --- people ---
  const box = $("people");
  box.innerHTML = "";
  for (const m of members) {
    const drift = (m.pos || 0) - now;
    const lag = Math.abs(drift) > 1.5 && m.arrived && !m.holding;
    const el = document.createElement("span");
    el.className = "who" + (lag ? " lag" : "") + (m.away ? " away" : "");
    el.innerHTML = `<span class="face"></span><span class="nm"></span>` +
      (m.voice ? `<span class="mic"></span>` : "") + `<span class="st"></span>`;
    const f = el.querySelector(".face");
    f.textContent = m.avatar || (m.name || "?").trim().charAt(0).toUpperCase();
    f.style.background = tint(m.name || "");
    el.querySelector(".nm").textContent = m.name + (m.id === r.meId ? "" : "");
    el.querySelector(".st").textContent =
      m.away ? "away"
      : !m.arrived ? "loading"
      : m.holding ? "buffering"
      : m.ready ? "ready"
      : lag ? `${drift > 0 ? "+" : ""}${drift.toFixed(1)}s`
      : "";
    box.appendChild(el);
  }

  // --- the running order ---
  const q = r.queue || [];
  $("roomCode").textContent = r.code || "·····";
  $("qempty").classList.toggle("hidden", q.length > 0);
  const ql = $("qlist");
  ql.innerHTML = "";
  q.forEach((item, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="qn"></span><span class="qt"></span><span class="qby"></span>` +
      (item.byId === r.meId || r.hostId === r.meId ? `<button class="qx" title="remove">×</button>` : "");
    li.querySelector(".qn").textContent = String(i + 1).padStart(2, "0");
    li.querySelector(".qt").textContent = item.title;
    li.querySelector(".qby").textContent = item.byId === r.meId ? "you" : item.byName;
    const x = li.querySelector(".qx");
    if (x) x.onclick = () => tell({ type: "queueRemove", id: item.id });
    ql.appendChild(li);
  });

  $("readyBtn").classList.toggle("on", !!(me && me.ready));
  $("lockBtn").classList.toggle("on", !!r.locked);
  $("lockBtn").textContent = r.locked ? "Controls locked" : "Lock controls";
  if (me && document.activeElement !== $("meName")) $("meName").value = me.name || "";
  if (me && !myFace && me.avatar) myFace = me.avatar;
}

setInterval(() => { if (snap && snap.room) render(); }, 400);

// ---------- the drawer ----------

let drawerKind = null;
function drawer(kind, build) {
  const d = $("drawer");
  if (drawerKind === kind && !d.classList.contains("hidden")) {
    d.classList.add("hidden");
    drawerKind = null;
    return;
  }
  drawerKind = kind;
  d.innerHTML = "";
  build(d);
  d.classList.remove("hidden");
}

function menu(d) {
  const row = document.createElement("div");
  row.className = "drawer-row";
  const items = [
    ["emoji", "Emoji", () => drawer("emoji", emojiPane)],
    ["image", "Image", () => drawer("image", imagePane)],
    ["sound", "Sound", () => drawer("sound", soundPane)],
    ["big", "Send big", () => drawer("big", bigPane)],
    ["secret", "Secret", () => drawer("secret", secretPane)],
    ["room", "Room", () => { $("sheet").classList.remove("hidden"); d.classList.add("hidden"); drawerKind = null; }],
  ];
  for (const [, label, fn] of items) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = label;
    b.onclick = fn;
    row.appendChild(b);
  }
  d.appendChild(row);
}

function grid(d, values, onPick, words) {
  const g = document.createElement("div");
  g.className = "grid" + (words ? " words" : "");
  for (const v of values) {
    const b = document.createElement("button");
    b.textContent = Array.isArray(v) ? v[1] : v;
    b.onclick = () => onPick(Array.isArray(v) ? v[0] : v);
    g.appendChild(b);
  }
  d.appendChild(g);
}

const emojiPane = (d) => {
  menu(d);
  grid(d, EMOJI, (e) => { $("msg").value += e; $("msg").focus(); });
};
const bigPane = (d) => {
  menu(d);
  grid(d, EMOJI.slice(0, 24), (e) => { tell({ type: "big", emoji: e }); d.classList.add("hidden"); drawerKind = null; });
};
const soundPane = (d) => {
  menu(d);
  grid(d, STINGS, (kind) => tell({ type: "sting", kind }), true);
};
const imagePane = (d) => {
  menu(d);
  const row = document.createElement("div");
  row.className = "mini";
  const i = document.createElement("input");
  i.placeholder = "paste an image or gif link";
  const b = document.createElement("button");
  b.textContent = "Send";
  const go = () => {
    const v = i.value.trim();
    if (/^https?:\/\/\S+$/.test(v)) { tell({ type: "chat", text: v }); i.value = ""; }
  };
  b.onclick = go;
  i.onkeydown = (e) => { if (e.key === "Enter") go(); };
  row.append(i, b);
  d.appendChild(row);
  i.focus();
};
const secretPane = (d) => {
  menu(d);
  const row = document.createElement("div");
  row.className = "mini";
  const i = document.createElement("input");
  i.maxLength = 200;
  i.placeholder = "bursts onto their screen";
  const b = document.createElement("button");
  b.textContent = "Drop";
  const go = () => {
    const v = i.value.trim();
    if (v) { tell({ type: "secret", text: v }); i.value = ""; d.classList.add("hidden"); drawerKind = null; }
  };
  b.onclick = go;
  i.onkeydown = (e) => { if (e.key === "Enter") go(); };
  row.append(i, b);
  d.appendChild(row);
  i.focus();
};

$("more").addEventListener("click", () => drawer("menu", menu));

// One tap throws it on the screen. That is what a reaction is for, and making
// the tap type into the message box instead was a straight regression: it
// removed the only one-gesture way to say something during a film.
const QUICK = ["😂", "❤️", "🔥", "😭", "💀", "👀", "🎉", "🫠"];
(() => {
  const box = $("quick");
  for (const e of QUICK) {
    const b = document.createElement("button");
    b.textContent = e;
    b.title = "throw it on screen — hold for a big one";
    let timer = null, big = false;
    b.addEventListener("pointerdown", () => {
      big = false;
      timer = setTimeout(() => { big = true; tell({ type: "big", emoji: e }); b.classList.add("sent"); }, 450);
    });
    b.addEventListener("pointerup", () => {
      clearTimeout(timer);
      if (!big) { tell({ type: "react", emoji: e }); b.classList.add("sent"); }
      setTimeout(() => b.classList.remove("sent"), 220);
    });
    b.addEventListener("pointerleave", () => clearTimeout(timer));
    box.appendChild(b);
  }
})();

// the jam
const addLink = () => {
  const url = $("qUrl").value.trim();
  if (!/^https?:\/\/\S+$/.test(url)) return;
  tell({ type: "queueAdd", url });
  $("qUrl").value = "";
};
$("qAdd").addEventListener("click", addLink);
$("qUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") addLink(); });
$("nextBtn").addEventListener("click", () => tell({ type: "queueNext" }));
$("linkBtn").addEventListener("click", () => {
  const r = snap && snap.room;
  if (r) navigator.clipboard.writeText(`${r.server || RELAY}/r/${r.code}`).then(() => did("link copied"));
});
$("cogBtn").addEventListener("click", () => $("sheet").classList.remove("hidden"));

// ---------- actions ----------

const sendMsg = () => {
  const text = $("msg").value.trim();
  if (!text) return;
  tell({ type: "chat", text });
  $("msg").value = "";
};
$("send").addEventListener("click", sendMsg);
let lastTyped = 0;
$("msg").addEventListener("keydown", (e) => { if (e.key === "Enter") sendMsg(); });
$("msg").addEventListener("input", () => {
  const t = Date.now();
  if (t - lastTyped > 2000) { lastTyped = t; tell({ type: "typing" }); }
});

$("createBtn").addEventListener("click", async () => {
  const name = $("nameInput").value.trim();
  if (name) await chrome.storage.local.set({ name });
  $("doorErr").classList.add("hidden");
  const res = await sw({ type: "create", tabId, server: RELAY, name: name || "me", avatar: myFace });
  if (!res || res.error) {
    $("doorErr").textContent = (res && res.error) || "could not start the room";
    return $("doorErr").classList.remove("hidden");
  }
  connect();
});

$("joinBtn").addEventListener("click", async () => {
  const raw = $("codeInput").value.trim();
  const link = raw.match(/^(https?:\/\/[^/]+)\/r\/([A-Za-z0-9]{5})/);
  const server = link ? link[1] : RELAY;
  const code = (link ? link[2] : raw).toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) {
    $("doorErr").textContent = "paste the room link they sent you";
    return $("doorErr").classList.remove("hidden");
  }
  const name = $("nameInput").value.trim();
  if (name) await chrome.storage.local.set({ name });
  const res = await sw({ type: "join", tabId, server, name: name || "me", code, avatar: myFace });
  if (!res || res.error) {
    $("doorErr").textContent = (res && res.error) || "could not join";
    return $("doorErr").classList.remove("hidden");
  }
  connect();
});

$("sheetClose").addEventListener("click", () => $("sheet").classList.add("hidden"));
$("copyBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($("linkBox").value).then(() => did("link copied"));
});
$("leaveBtn").addEventListener("click", async () => {
  await sw({ type: "leave", tabId });
  snap = null;
  $("sheet").classList.add("hidden");
  render();
});
$("readyBtn").addEventListener("click", () => tell({ type: "ready", ready: !$("readyBtn").classList.contains("on") }));
$("lockBtn").addEventListener("click", () => tell({ type: "hostLock", locked: !$("lockBtn").classList.contains("on") }));
$("voiceBtn").addEventListener("click", () => tell({ type: "voice", on: !voiceOn }));
$("muteBtn").addEventListener("click", () => {
  const m = $("muteBtn").classList.toggle("on");
  $("muteBtn").textContent = m ? "Muted" : "Mute";
  tell({ type: "mute", muted: m });
});
$("saveMe").addEventListener("click", async () => {
  const name = $("meName").value.trim();
  if (name) await chrome.storage.local.set({ name });
  tell({ type: "identity", name, avatar: myFace });
});

function paintFaces() {
  const box = $("faces");
  box.innerHTML = "";
  for (const f of FACES) {
    const b = document.createElement("button");
    b.className = f === myFace ? "on" : "";
    b.textContent = f;
    b.onclick = async () => {
      myFace = f;
      await chrome.storage.local.set({ avatar: f });
      tell({ type: "identity", name: $("meName").value.trim(), avatar: f });
      paintFaces();
    };
    box.appendChild(b);
  }
}

// ---------- follow the active tab ----------

async function bindActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = tab && tab.id;
  if (!id || id === tabId) return;
  tabId = id;
  snap = null;
  const status = await sw({ type: "status", tabId });
  if (status) connect();
  else if (port) { try { port.disconnect(); } catch {} port = null; }
  render();
}

chrome.tabs.onActivated.addListener(bindActiveTab);
chrome.windows.onFocusChanged.addListener(bindActiveTab);
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === tabId && info.status === "complete") {
    sw({ type: "status", tabId }).then((s) => { if (s && !port) connect(); });
  }
});

(async () => {
  const cfg = await chrome.storage.local.get({ name: "", avatar: "" });
  $("nameInput").value = cfg.name;
  $("meName").value = cfg.name;
  myFace = cfg.avatar || "";
  paintFaces();
  await bindActiveTab();
})();
