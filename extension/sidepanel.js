// sync-lis side panel: the room, beside the page instead of on top of it.
// It speaks the same language as the page agent, so it sends and receives
// exactly what the agent does.

"use strict";

const $ = (id) => document.getElementById(id);
const RELAY = "https://desktop-ch7a7q7.tail5847e5.ts.net";

let tabId = null;
let port = null;
let snap = null;
let voiceOn = false;
let view = "Now";
let unread = 0;

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function tint(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 42%)`;
}

const FACES = ["🎧", "🍿", "👾", "🐙", "🌙", "🔥", "🦊", "🫠", "💀", "🧃", "🪩", "🐈", "🌵", "🧊", "🎃", "👻"];
const EMOJI = ("😂 🤣 😭 😍 🥺 😳 😱 🤯 🥵 🫠 💀 👀 🙄 😴 🤡 🫡 🔥 ❤️ 💔 ✨ 🎉 🙌 👏 🤝 " +
  "👍 👎 🍿 🎬 🎧 🕺 💃 🤌 🧠 💯 ⚡ 🌈 🐐 🚩 ⏭ ⏸").split(" ");
const STINGS = [
  ["drumroll", "drum roll"],
  ["airhorn", "airhorn"],
  ["rimshot", "ba dum tss"],
  ["sad", "sad trombone"],
];

function sw(msg) {
  return chrome.runtime.sendMessage({ target: "sync", ...msg }).catch(() => null);
}
function tell(msg) {
  try { if (port) port.postMessage(msg); } catch {}
}

// ---------- the room ----------

function connect() {
  if (port) { try { port.disconnect(); } catch {} }
  port = chrome.runtime.connect({ name: `sync-lis-panel:${tabId}` });
  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "state": snap = msg; render(); break;
      case "history":
        $("log").innerHTML = "";
        $("activity").innerHTML = "";
        for (const h of msg.items) {
          if (h.type === "syncChat") chat(h.from, h.text, h.videoTime);
          else if (h.type === "syncNarrate") act(h.text, true);
          else act(h.text);
        }
        break;
      case "chat": chat(msg.from, msg.text, msg.videoTime); break;
      case "narrate": act(msg.text, true); break;
      case "note": act(msg.text); break;
      case "typing":
        $("typing").textContent = `${msg.from} is typing…`;
        clearTimeout(window._tt);
        window._tt = setTimeout(() => { $("typing").textContent = ""; }, 3000);
        break;
      case "sting": act(`${msg.from} played a ${msg.kind}`); break;
      case "big": act(`${msg.from} sent ${msg.emoji}`); break;
      case "secret": chat(msg.from, `🤫 ${msg.text}`, 0); break;
      case "voiceState":
        voiceOn = msg.on;
        $("voiceBtn").classList.toggle("on", msg.on);
        $("voiceBtn").textContent = msg.on ? "live" : "voice";
        $("muteBtn").classList.toggle("hidden", !msg.on);
        if (msg.error === "mic") act("allow the microphone in the tab that opened, then try again");
        else if (msg.error) act(`voice didn't start: ${msg.error}`);
        break;
      case "ended": snap = null; render(); break;
    }
  });
  port.onDisconnect.addListener(() => { port = null; });
}

// chat is what people said; activity is what people did. Keeping transport
// noise out of the conversation was the whole point of splitting them.
function chat(from, text, at) {
  const d = document.createElement("div");
  d.className = "msg";
  const img = /(https?:\/\/\S+\.(?:gif|png|jpe?g|webp))(\?\S*)?$/i.exec(text || "");
  d.innerHTML = `<span class="who">${esc(from)}</span> <span class="ts">${fmt(at)}</span><br>${esc(text)}` +
    (img ? `<img class="chat-img" src="${encodeURI(img[0])}" alt="">` : "");
  $("log").appendChild(d);
  while ($("log").children.length > 200) $("log").firstChild.remove();
  $("log").scrollTop = $("log").scrollHeight;
  if (view !== "Chat") {
    unread++;
    $("unread").classList.remove("hidden");
  }
}

function act(text, isSwitch) {
  const d = document.createElement("div");
  d.className = "act" + (isSwitch ? " switch" : "");
  d.textContent = text;
  $("activity").appendChild(d);
  while ($("activity").children.length > 80) $("activity").firstChild.remove();
  $("activity").scrollTop = $("activity").scrollHeight;
}

// ---------- rendering ----------

function render() {
  const inRoom = !!(snap && snap.room);
  $("idle").classList.toggle("hidden", inRoom);
  $("room").classList.toggle("hidden", !inRoom);
  if (!inRoom) {
    $("counter").textContent = "--:--";
    $("rec").classList.remove("live");
    return;
  }

  const r = snap.room;
  const state = snap.state || { paused: true, time: 0, at: Date.now(), rate: 1 };
  const content = snap.content;
  $("linkBox").value = `${r.server || RELAY}/r/${r.code}`;

  const alone = (r.members || []).length < 2;
  $("nowTitle").textContent = content
    ? (content.title || content.url)
    : alone ? "open something and press play" : "nobody has started anything yet";
  $("nowTitle").classList.toggle("waiting", !content);

  const rate = state.rate || 1;
  const t = state.paused
    ? state.time
    : state.time + ((Date.now() + (snap.offset || 0) - state.at) / 1000) * rate;
  const dur = Math.max(...(r.members || []).map((m) => m.pos || 0), t, 1);
  $("nowBar").style.width = `${Math.min(100, (t / dur) * 100)}%`;
  $("stampTime").textContent = fmt(t);
  $("stampRate").textContent = rate === 1 ? (state.paused ? "paused" : "playing") : `${rate}x`;
  $("counter").textContent = fmt(t);
  $("rec").classList.toggle("live", !state.paused);

  const list = $("people");
  list.innerHTML = "";
  const waiting = [];
  for (const m of r.members || []) {
    const why = !m.arrived ? "loading" : m.holding ? "buffering" : m.away ? "away" : null;
    if (why && why !== "away") waiting.push(m.name);
    const li = document.createElement("li");
    li.className = why ? (why === "away" ? "away" : "wait") : "";
    li.innerHTML = `<span class="face"></span><span class="pname"></span>
      ${m.voice ? '<span class="tag">mic</span>' : ""}
      ${m.ready ? '<span class="tag ready">ready</span>' : ""}
      <span class="pstat"></span>`;
    const f = li.querySelector(".face");
    f.textContent = m.avatar || (m.name || "?").trim().charAt(0).toUpperCase();
    f.style.background = tint(m.name || "");
    li.querySelector(".pname").textContent =
      m.name + (m.id === r.meId ? " (you)" : "") + (m.id === r.hostId ? " · host" : "");
    li.querySelector(".pstat").textContent = why || fmt(m.pos);
    list.appendChild(li);
  }

  const counting = r.countdownAt && r.countdownAt > Date.now();
  const bar = $("statusBar");
  bar.classList.remove("count");
  const pending = readyPending(r);
  if (counting) {
    bar.classList.remove("hidden");
    bar.classList.add("count");
    $("statusText").textContent = String(Math.ceil((r.countdownAt - Date.now()) / 1000));
  } else if (waiting.length) {
    bar.classList.remove("hidden");
    $("statusText").textContent = `waiting for ${waiting.join(" and ")}`;
  } else if (pending) {
    bar.classList.remove("hidden");
    $("statusText").textContent = pending;
  } else {
    bar.classList.add("hidden");
  }

  $("lockBtn").classList.toggle("on", !!r.locked);
  $("lockBtn").textContent = r.locked ? "locked" : "lock";
  const me = (r.members || []).find((m) => m.id === r.meId);
  $("readyBtn").classList.toggle("on", !!(me && me.ready));
  if (me && document.activeElement !== $("meName")) $("meName").value = me.name || "";
  if (me && !myFace && me.avatar) myFace = me.avatar;
}

function readyPending(r) {
  const ms = r.members || [];
  if (ms.length < 2 || !ms.some((m) => m.ready)) return null;
  const notReady = ms.filter((m) => !m.ready);
  if (!notReady.length) return null;
  const me = ms.find((m) => m.id === r.meId);
  if (me && !me.ready) return "they're ready — waiting on you";
  return `waiting for ${notReady.map((m) => m.name).join(" and ")} to be ready`;
}

setInterval(() => { if (snap && snap.room) render(); }, 400);

// ---------- views ----------

document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    view = b.dataset.v;
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    for (const v of ["Now", "Chat", "Room"]) $("view" + v).classList.toggle("hidden", v !== view);
    if (view === "Chat") {
      unread = 0;
      $("unread").classList.add("hidden");
      $("log").scrollTop = $("log").scrollHeight;
    }
  });
});

// ---------- who you are ----------

let myFace = "";

function paintFaces(box, onPick) {
  box.innerHTML = "";
  for (const f of FACES) {
    const b = document.createElement("button");
    b.className = "face-pick" + (f === myFace ? " on" : "");
    b.textContent = f;
    b.onclick = () => { myFace = f; onPick(f); };
    box.appendChild(b);
  }
}

function repaintAllFaces() {
  paintFaces($("faces"), async (f) => {
    await chrome.storage.local.set({ avatar: f });
    repaintAllFaces();
  });
  paintFaces($("meFaces"), async (f) => {
    await chrome.storage.local.set({ avatar: f });
    tell({ type: "identity", name: $("meName").value.trim(), avatar: f });
    repaintAllFaces();
  });
}

$("saveMe").addEventListener("click", async () => {
  const name = $("meName").value.trim();
  if (name) await chrome.storage.local.set({ name });
  tell({ type: "identity", name, avatar: myFace });
});

// ---------- actions ----------

$("createBtn").addEventListener("click", async () => {
  const name = $("nameInput").value.trim();
  if (name) await chrome.storage.local.set({ name });
  $("idleErr").classList.add("hidden");
  const res = await sw({ type: "create", tabId, server: RELAY, name: name || "me", avatar: myFace });
  if (!res || res.error) {
    $("idleErr").textContent = (res && res.error) || "could not start the room";
    return $("idleErr").classList.remove("hidden");
  }
  connect();
});

$("joinBtn").addEventListener("click", async () => {
  const raw = $("codeInput").value.trim();
  const link = raw.match(/^(https?:\/\/[^/]+)\/r\/([A-Za-z0-9]{5})/);
  const server = link ? link[1] : RELAY;
  const code = (link ? link[2] : raw).toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) {
    $("idleErr").textContent = "paste the room link, or the 5-character code";
    return $("idleErr").classList.remove("hidden");
  }
  const name = $("nameInput").value.trim();
  if (name) await chrome.storage.local.set({ name });
  const res = await sw({ type: "join", tabId, server, name: name || "me", code, avatar: myFace });
  if (!res || res.error) {
    $("idleErr").textContent = (res && res.error) || "could not join";
    return $("idleErr").classList.remove("hidden");
  }
  connect();
});

$("copyBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($("linkBox").value).then(() => act("link copied"));
});
$("leaveBtn").addEventListener("click", async () => {
  await sw({ type: "leave", tabId });
  snap = null;
  render();
});

const send = () => {
  const text = $("chatInput").value.trim();
  if (!text) return;
  tell({ type: "chat", text });
  $("chatInput").value = "";
};
$("sendBtn").addEventListener("click", send);
let lastTyped = 0;
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
$("chatInput").addEventListener("input", () => {
  const now = Date.now();
  if (now - lastTyped > 2000) { lastTyped = now; tell({ type: "typing" }); }
});

$("voiceBtn").addEventListener("click", () => tell({ type: "voice", on: !voiceOn }));
$("muteBtn").addEventListener("click", () => {
  const m = $("muteBtn").classList.toggle("on");
  $("muteBtn").textContent = m ? "muted" : "mute";
  tell({ type: "mute", muted: m });
});
$("readyBtn").addEventListener("click", () => {
  tell({ type: "ready", ready: !$("readyBtn").classList.contains("on") });
});
$("lockBtn").addEventListener("click", () => {
  tell({ type: "hostLock", locked: !$("lockBtn").classList.contains("on") });
});

// ---------- the tray: emoji, gifs, sounds, big, secrets ----------

function tray(build) {
  const t = $("tray");
  if (!t.classList.contains("hidden") && t.dataset.kind === build.kind) {
    return t.classList.add("hidden");
  }
  t.dataset.kind = build.kind;
  t.innerHTML = "";
  build.render(t);
  t.classList.remove("hidden");
}

$("emojiBtn").addEventListener("click", () => tray({
  kind: "emoji",
  render(t) {
    const g = document.createElement("div");
    g.className = "tray-grid";
    for (const e of EMOJI) {
      const b = document.createElement("button");
      b.textContent = e;
      b.onclick = () => { $("chatInput").value += e; $("chatInput").focus(); };
      g.appendChild(b);
    }
    t.appendChild(g);
  },
}));

$("gifBtn").addEventListener("click", () => tray({
  kind: "gif",
  render(t) {
    t.innerHTML = `<div class="label">paste an image or gif link</div>`;
    const row = document.createElement("div");
    row.className = "row";
    const i = document.createElement("input");
    i.placeholder = "https://…/something.gif";
    const b = document.createElement("button");
    b.textContent = "Send";
    b.onclick = () => {
      const v = i.value.trim();
      if (/^https?:\/\/\S+$/.test(v)) { tell({ type: "chat", text: v }); i.value = ""; t.classList.add("hidden"); }
    };
    row.append(i, b);
    t.appendChild(row);
    i.focus();
  },
}));

$("stingBtn").addEventListener("click", () => tray({
  kind: "sting",
  render(t) {
    t.innerHTML = `<div class="label">everyone hears this</div>`;
    const g = document.createElement("div");
    g.className = "tray-grid";
    for (const [kind, label] of STINGS) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.fontSize = "11px";
      b.onclick = () => tell({ type: "sting", kind });
      g.appendChild(b);
    }
    t.appendChild(g);
  },
}));

$("bigBtn").addEventListener("click", () => tray({
  kind: "big",
  render(t) {
    t.innerHTML = `<div class="label">fills their whole screen</div>`;
    const g = document.createElement("div");
    g.className = "tray-grid";
    for (const e of EMOJI.slice(0, 24)) {
      const b = document.createElement("button");
      b.textContent = e;
      b.onclick = () => { tell({ type: "big", emoji: e }); t.classList.add("hidden"); };
      g.appendChild(b);
    }
    t.appendChild(g);
  },
}));

$("secretBtn").addEventListener("click", () => tray({
  kind: "secret",
  render(t) {
    t.innerHTML = `<div class="label">bursts onto their screen, right now</div>`;
    const row = document.createElement("div");
    row.className = "row";
    const i = document.createElement("input");
    i.maxLength = 200;
    i.placeholder = "psst…";
    const b = document.createElement("button");
    b.textContent = "Drop";
    const fire = () => {
      const v = i.value.trim();
      if (v) { tell({ type: "secret", text: v }); i.value = ""; t.classList.add("hidden"); }
    };
    b.onclick = fire;
    i.onkeydown = (e) => { if (e.key === "Enter") fire(); };
    row.append(i, b);
    t.appendChild(row);
    i.focus();
  },
}));

// ---------- follow the active tab ----------
// Chrome's side panel outlives the tab it was opened from, so binding once
// meant it kept describing a tab you had already left.

async function bindActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = tab && tab.id;
  if (!id || id === tabId) return;
  tabId = id;
  snap = null;
  const status = await sw({ type: "status", tabId });
  if (status) connect();
  else { if (port) { try { port.disconnect(); } catch {} port = null; } }
  render();
}

chrome.tabs.onActivated.addListener(bindActiveTab);
chrome.windows.onFocusChanged.addListener(bindActiveTab);
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === tabId && info.status === "complete") sw({ type: "status", tabId }).then((s) => { if (s && !port) connect(); });
});

(async () => {
  const cfg = await chrome.storage.local.get({ name: "", avatar: "" });
  $("nameInput").value = cfg.name;
  $("meName").value = cfg.name;
  myFace = cfg.avatar || "";
  repaintAllFaces();
  await bindActiveTab();
})();
