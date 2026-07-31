// sync-lis side panel: the whole room UI, beside the page instead of on top of
// it. It talks to the service worker over the same port the page agent uses, so
// it sends and receives exactly what the agent does.

"use strict";

const $ = (id) => document.getElementById(id);
const RELAY = "https://desktop-ch7a7q7.tail5847e5.ts.net";

let tabId = null;
let port = null;
let snap = null;   // last room snapshot
let voiceOn = false;

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// a name always gets the same colour, so you learn who is who at a glance
function tint(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 42%)`;
}

const FACES = ["ðŸŽ§", "ðŸ¿", "ðŸ‘¾", "ðŸ™", "ðŸŒ™", "ðŸ”¥", "ðŸ¦Š", "ðŸ« ", "ðŸ’€", "ðŸ§ƒ", "ðŸª©", "ðŸˆ"];

function sw(msg) {
  return chrome.runtime.sendMessage({ target: "sync", ...msg }).catch(() => null);
}
function tell(msg) {
  try { if (port) port.postMessage(msg); } catch {}
}

// ---------- talking to the room ----------

function connect() {
  if (port) { try { port.disconnect(); } catch {} }
  port = chrome.runtime.connect({ name: `sync-lis-panel:${tabId}` });
  port.onMessage.addListener((msg) => {
    if (msg.type === "state") {
      snap = msg;
      render();
    } else if (msg.type === "history") {
      $("log").innerHTML = "";
      for (const h of msg.items) {
        if (h.type === "syncChat") {
          line(`<span class="who">${esc(h.from)}</span> <span class="ts">${fmt(h.videoTime)}</span><br>${esc(h.text)}`);
        } else if (h.type === "syncNarrate") {
          line(esc(h.text), "narrate");
        } else {
          line(esc(h.text), "sys");
        }
      }
    } else if (msg.type === "chat") {
      line(`<span class="who">${esc(msg.from)}</span> <span class="ts">${fmt(msg.videoTime)}</span><br>${esc(msg.text)}`);
    } else if (msg.type === "narrate") {
      line(esc(msg.text), "narrate");
    } else if (msg.type === "note") {
      line(esc(msg.text), "sys");
    } else if (msg.type === "typing") {
      $("typing").textContent = `${msg.from} is typingâ€¦`;
      clearTimeout(window._tt);
      window._tt = setTimeout(() => { $("typing").textContent = ""; }, 3000);
    } else if (msg.type === "voiceState") {
      voiceOn = msg.on;
      $("voiceBtn").classList.toggle("on", msg.on);
      $("voiceBtn").textContent = msg.on ? "ðŸŽ™ live" : "ðŸŽ™ voice";
      $("muteBtn").classList.toggle("hidden", !msg.on);
      if (msg.error === "mic") line("Allow the microphone in the tab that just opened, then turn voice on again.", "sys");
      else if (msg.error) line(`Voice didn't start: ${msg.error}`, "sys");
    } else if (msg.type === "ended") {
      snap = null;
      render();
    }
  });
  port.onDisconnect.addListener(() => { port = null; });
}

function line(html, cls) {
  const d = document.createElement("div");
  d.className = cls || "msg";
  d.innerHTML = html;
  $("log").appendChild(d);
  while ($("log").children.length > 150) $("log").firstChild.remove();
  $("log").scrollTop = $("log").scrollHeight;
}

// ---------- rendering ----------

function render() {
  const inRoom = !!(snap && snap.room);
  $("idle").classList.toggle("hidden", inRoom);
  $("room").classList.toggle("hidden", !inRoom);
  if (!inRoom) {
    $("roomLine").textContent = "not in a room";
    return;
  }

  const r = snap.room;
  const state = snap.state || { paused: true, time: 0, at: Date.now(), rate: 1 };
  const content = snap.content;
  $("roomLine").textContent = r.code || "";
  $("linkBox").value = `${r.server || RELAY}/r/${r.code}`;

  // what everyone is on. An empty room used to look broken, so it now says
  // whose move it is.
  const alone = (r.members || []).length < 2;
  $("nowTitle").textContent = content
    ? (content.title || content.url)
    : alone
      ? "open something and press play"
      : "nobody has started anything yet";
  $("nowTitle").classList.toggle("waiting", !content);
  const rate = state.rate || 1;
  const t = state.paused
    ? state.time
    : state.time + ((Date.now() + (snap.offset || 0) - state.at) / 1000) * rate;
  const dur = Math.max(...(r.members || []).map((m) => m.pos || 0), t, 1);
  $("nowBar").style.width = `${Math.min(100, (t / dur) * 100)}%`;
  $("stampTime").textContent = fmt(t);
  $("stampRate").textContent = rate === 1 ? (state.paused ? "paused" : "playing") : `${rate}x`;
  $("rec").classList.toggle("live", !state.paused);

  // who is here, and what each of them is doing
  const list = $("people");
  list.innerHTML = "";
  const waiting = [];
  for (const m of r.members || []) {
    const why = !m.arrived ? "loading" : m.holding ? "buffering" : m.away ? "away" : null;
    if (why && why !== "away") waiting.push(m.name);
    const li = document.createElement("li");
    li.className = why ? (why === "away" ? "away" : "wait") : "";
    li.innerHTML = `<span class="face"></span>
      <span class="pname"></span>
      ${m.voice ? '<span class="tag">mic</span>' : ""}
      ${m.ready ? '<span class="tag ready">ready</span>' : ""}
      <span class="pstat"></span>`;
    const face = li.querySelector(".face");
    face.textContent = m.avatar || (m.name || "?").trim().charAt(0).toUpperCase();
    face.style.background = tint(m.name || "");
    li.querySelector(".pname").textContent =
      m.name + (m.id === r.meId ? " (you)" : "") + (m.id === r.hostId ? " Â· host" : "");
    li.querySelector(".pstat").textContent = why || fmt(m.pos);
    list.appendChild(li);
  }

  // one status strip, in priority order
  const counting = r.countdownAt && r.countdownAt > Date.now();
  const bar = $("statusBar");
  bar.classList.remove("count");
  if (counting) {
    bar.classList.remove("hidden");
    bar.classList.add("count");
    $("statusText").textContent = String(Math.ceil((r.countdownAt - Date.now()) / 1000));
  } else if (waiting.length) {
    bar.classList.remove("hidden");
    $("statusText").textContent = `waiting for ${waiting.join(" and ")}`;
  } else if (readyPending(r)) {
    bar.classList.remove("hidden");
    $("statusText").textContent = readyPending(r);
  } else {
    bar.classList.add("hidden");
  }

  $("lockBtn").classList.toggle("on", !!r.locked);
  $("lockBtn").textContent = r.locked ? "locked" : "lock";
  const me = (r.members || []).find((m) => m.id === r.meId);
  $("readyBtn").classList.toggle("on", !!(me && me.ready));
}

// the thing he asked for: if you are the last one to press ready, say so
function readyPending(r) {
  const ms = r.members || [];
  if (ms.length < 2 || !ms.some((m) => m.ready)) return null;
  const notReady = ms.filter((m) => !m.ready);
  if (!notReady.length) return null;
  const me = ms.find((m) => m.id === r.meId);
  if (me && !me.ready) return "they're ready â€” waiting on you";
  return `waiting for ${notReady.map((m) => m.name).join(" and ")} to be ready`;
}

setInterval(() => { if (snap && snap.room) render(); }, 400);

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
  navigator.clipboard.writeText($("linkBox").value).then(() => line("link copied", "sys"));
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

document.querySelectorAll(".reacts button").forEach((b) => {
  b.addEventListener("click", () => tell({ type: "react", emoji: b.dataset.e }));
});

$("voiceBtn").addEventListener("click", () => tell({ type: "voice", on: !voiceOn }));
$("muteBtn").addEventListener("click", () => {
  const m = $("muteBtn").classList.toggle("on");
  $("muteBtn").textContent = m ? "muted" : "mute";
  tell({ type: "mute", muted: m });
});
$("readyBtn").addEventListener("click", () => {
  const on = !$("readyBtn").classList.contains("on");
  tell({ type: "ready", ready: on });
});
$("lockBtn").addEventListener("click", () => tell({ type: "hostLock", locked: !$("lockBtn").classList.contains("on") }));

// ---------- boot ----------

let myFace = "";

function paintFaces() {
  const box = $("faces");
  box.innerHTML = "";
  for (const f of FACES) {
    const b = document.createElement("button");
    b.className = "face-pick" + (f === myFace ? " on" : "");
    b.textContent = f;
    b.onclick = async () => {
      myFace = f;
      await chrome.storage.local.set({ avatar: f });
      paintFaces();
    };
    box.appendChild(b);
  }
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  const cfg = await chrome.storage.local.get({ name: "", avatar: "" });
  $("nameInput").value = cfg.name;
  myFace = cfg.avatar || "";
  paintFaces();
  const status = await sw({ type: "status", tabId });
  if (status) connect();
  else render();
})();

