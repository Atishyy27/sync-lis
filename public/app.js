// Mehfil jukebox client.
// The server owns playback (what's playing, since when); this client streams
// the file and keeps its <audio> clock aligned to the server's.

"use strict";

const $ = (id) => document.getElementById(id);
const audio = $("jamAudio");

let ws = null;
let myId = null;
let state = null;

// ---- server clock offset (median of recent ping samples) ----
const offsets = [];
function clockOffset() {
  if (!offsets.length) return 0;
  const s = [...offsets].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function ping() {
  send({ type: "ping", t: Date.now() });
}
function serverNow() {
  return Date.now() + clockOffset();
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 4000);
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// ---- join ----

let myName = null;
let retryDelay = 1000;
let pingTimer = null;

function connect() {
  ws = new WebSocket(`wss://${location.host}`);
  ws.onopen = () => {
    retryDelay = 1000;
    document.body.classList.remove("disconnected");
    send({
      type: "join",
      room: decodeURIComponent(location.hash.slice(1)) || "jam",
      name: myName,
      avatar: myFace,
      key: new URLSearchParams(location.search).get("k") || "",
    });
    clearInterval(pingTimer);
    pingTimer = setInterval(ping, 10000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "welcome") {
      myId = msg.id;
      offsets.length = 0; // fresh connection, fresh clock samples
      offsets.push(msg.now - Date.now());
      ping();
      $("chatLog").innerHTML = "";
      for (const h of msg.history || []) {
        if (h.type === "chat") chatLine(`<b>${escapeHtml(h.from)}</b> ${escapeHtml(h.text)}`);
        else chatLine(escapeHtml(h.text), "csys");
      }
    } else if (msg.type === "chat") {
      chatLine(`<b>${escapeHtml(msg.from)}</b> ${escapeHtml(msg.text)}`);
    } else if (msg.type === "said") {
      chatLine(escapeHtml(msg.text), "csys");
    } else if (msg.type === "react") {
      floatEmoji(msg.emoji);
    } else if (msg.type === "pong") {
      const rtt = Date.now() - msg.t;
      offsets.push(msg.now - (msg.t + rtt / 2));
      if (offsets.length > 7) offsets.shift();
    } else if (msg.type === "state") {
      state = msg;
      offsets.push(msg.now - Date.now()); // coarse sample; pings refine it
      if (offsets.length > 7) offsets.shift();
      render();
      syncPlayback();
    } else if (msg.type === "toast") {
      toast(msg.text);
    } else if (msg.type === "denied") {
      myName = null; // stop the reconnect loop; this isn't a network problem
      $("joinScreen").classList.remove("hidden");
      $("room").classList.add("hidden");
      toast(msg.text);
    }
  };
  // wifi blip ≠ leaving the jam: reconnect with backoff, rejoin as the same name
  ws.onclose = () => {
    if (!myName) return;
    document.body.classList.add("disconnected");
    toast("Connection lost — reconnecting…");
    clearInterval(pingTimer);
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10000);
  };
}

$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("nameInput").value.trim();
  if (!name) return $("nameInput").focus();
  myName = name;
  connect();
  $("joinScreen").classList.add("hidden");
  $("room").classList.remove("hidden");
});

// ---- synced playback ----

function targetTime() {
  if (!state || !state.current) return 0;
  const cur = state.current;
  const anchor = cur.pausedAt || serverNow();
  return (anchor - cur.startedAt) / 1000;
}

function syncPlayback() {
  const cur = state && state.current;
  if (!cur) {
    audio.pause();
    audio.removeAttribute("src");
    delete audio.dataset.entry;
    return;
  }
  if (audio.dataset.entry !== String(cur.id)) {
    audio.dataset.entry = String(cur.id);
    audio.src = cur.mediaUrl;
    audio.addEventListener("loadedmetadata", () => { audio.currentTime = Math.max(0, targetTime()); }, { once: true });
  }
  if (cur.pausedAt) {
    audio.pause();
    // Only correct if actually off — this used to seek unconditionally on
    // EVERY state broadcast (member pos updates, chat, anything), even when
    // nothing had moved. Setting currentTime to the value it's already at
    // can still fire a 'waiting' event on some browsers, which set holding
    // true, which re-broadcast this same paused state, which seeked again —
    // a self-sustaining loop that looked exactly like nonstop buffering.
    if (audio.duration && Math.abs(audio.currentTime - targetTime()) > 0.3) {
      audio.currentTime = targetTime();
    }
  } else if (audio.paused) {
    // Same unconditional-seek bug as the paused branch, plus this one also
    // called .play() on every single broadcast — which, while a PREVIOUS
    // .play() is still buffering, restarts that buildup right as it was
    // making progress, and the seek right before it makes that worse.
    // Every hold toggle triggers its own broadcast, so this branch could
    // re-fire within milliseconds of itself: seek, play, (still not ready
    // so) waiting, hold, broadcast, seek, play, waiting, hold... a real,
    // observed loop settling in single-digit milliseconds, far faster than
    // any actual network recovery — proof it was never really the network.
    if (audio.duration && Math.abs(audio.currentTime - targetTime()) > 0.3) {
      audio.currentTime = targetTime();
    }
    // A first attempt at a time-based cooldown here (skip re-calling play()
    // for 1.5s) traded the loop for a worse bug: a hold that clears within
    // that window calls audio.pause() while the earlier play() is still
    // pending, which the spec aborts with AbortError — and with the cooldown
    // in place, and nothing else scheduled to call syncPlayback() again,
    // that abort just sat there paused forever. An in-flight guard avoids
    // stacking play() calls (the original problem) without blocking a real
    // retry: AbortError specifically means something else interrupted us,
    // not that anything is actually wrong, so it retries itself.
    if (!playInFlight) {
      playInFlight = true;
      audio.play().then(() => {
        playInFlight = false;
        $("unmuteBtn").classList.add("hidden");
      }).catch((e) => {
        playInFlight = false;
        if (e && e.name === "AbortError") setTimeout(syncPlayback, 50);
        else $("unmuteBtn").classList.remove("hidden");
      });
    }
  }
}
let playInFlight = false;

// drift correction: seek when far off, nudge playbackRate when close
setInterval(() => {
  if (!state || !state.current || state.current.pausedAt || audio.paused || !audio.duration) return;
  // Nobody else in the room: correcting drift against your own network-
  // lagged echo of yourself just adds unnecessary seeks and rate wobble to
  // a solo listen — the same "heavy while alone" bug found and fixed in
  // sync-lis's extension (content.js's reconcile()).
  if (!state.members || state.members.length <= 1) { audio.playbackRate = 1; return; }
  const d = audio.currentTime - targetTime();
  if (Math.abs(d) > 0.4) {
    audio.currentTime = targetTime();
    audio.playbackRate = 1;
  } else if (d > 0.06) {
    audio.playbackRate = 0.97;
  } else if (d < -0.06) {
    audio.playbackRate = 1.03;
  } else {
    audio.playbackRate = 1;
  }
}, 2000);

$("unmuteBtn").addEventListener("click", () => {
  audio.currentTime = targetTime();
  audio.play().then(() => $("unmuteBtn").classList.add("hidden")).catch(() => {});
});

// progress bar
setInterval(() => {
  const cur = state && state.current;
  if (!cur || !cur.duration) return;
  const t = Math.min(targetTime(), cur.duration);
  $("progressBar").style.width = `${(t / cur.duration) * 100}%`;
  $("tCur").textContent = fmt(t);
  $("tDur").textContent = fmt(cur.duration);
}, 500);

// ---- queue actions ----

$("addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("linkInput").value.trim();
  if (!url) return;
  send({ type: "queueAdd", url });
  $("linkInput").value = "";
});

// paste a link anywhere on the page -> queued
document.addEventListener("paste", (e) => {
  if (e.target === $("linkInput") || e.target === $("nameInput")) return;
  if (!myId) return;
  const text = (e.clipboardData.getData("text") || "").trim();
  if (/^(https?:\/\/|spotify:)/.test(text)) {
    send({ type: "queueAdd", url: text });
    toast("Queued from clipboard");
  }
});

// drag & drop audio files -> background transfer, appears as a card
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (!myId) return;
  dragDepth++;
  $("dropOverlay").classList.remove("hidden");
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("dropOverlay").classList.add("hidden");
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("dropOverlay").classList.add("hidden");
  if (!myId) return;
  const room = decodeURIComponent(location.hash.slice(1)) || "jam";
  for (const file of e.dataTransfer.files) {
    const q = new URLSearchParams({ room, member: myId, name: file.name });
    fetch(`/upload?${q}`, { method: "POST", body: file }).then(async (r) => {
      if (!r.ok) toast((await r.json()).error || "Upload failed");
    }).catch(() => toast("Upload failed"));
  }
});

$("skipBtn").addEventListener("click", () => send({ type: "voteSkip" }));

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  send({ type: "chat", text });
  $("chatInput").value = "";
});
document.querySelectorAll(".reacts button").forEach((b) => {
  b.addEventListener("click", () => send({ type: "react", emoji: b.dataset.e }));
});

// wait for me: tell the room when this device's audio stalls
let holding = false;
function setHold(next) {
  if (next === holding) return;
  holding = next;
  send({ type: "hold", holding });
}
// A deliberate pause (the room says pausedAt) triggers its own currentTime
// writes above, which can fire 'waiting' with nothing actually stalled —
// only trust 'waiting' as a real stall while we're actually trying to play.
audio.addEventListener("waiting", () => { if (!audio.paused) setHold(true); });
audio.addEventListener("playing", () => setHold(false));
audio.addEventListener("canplay", () => setHold(false));
audio.addEventListener("canplaythrough", () => setHold(false));
setInterval(() => {
  if (!state || !state.current) return setHold(false);
  if (!audio.paused && audio.readyState < 3) setHold(true);
  else if (audio.readyState >= 3) setHold(false);
}, 2000);

$("playPauseBtn").addEventListener("click", () => {
  if (!state || !state.current) return;
  send({ type: state.current.pausedAt ? "resume" : "pause" });
});

// click the progress bar -> everyone seeks
$("progressWrap").addEventListener("click", (e) => {
  const cur = state && state.current;
  if (!cur || !cur.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = Math.min(Math.max(0, (e.clientX - rect.left) / rect.width), 1);
  send({ type: "seek", position: frac * cur.duration });
});

// ---- render ----

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// same name, same colour, every time
function tint(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 45%)`;
}

const FACES = ["🎧", "🍿", "👾", "🐙", "🌙", "🔥", "🦊", "🫠", "💀", "🧃", "🪩", "🐈"];
let myFace = localStorage.getItem("mehfil.face") || "";

function paintFaces() {
  const box = $("faces");
  if (!box) return;
  box.innerHTML = "";
  for (const f of FACES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "face-pick" + (f === myFace ? " on" : "");
    b.textContent = f;
    b.onclick = () => {
      myFace = f;
      localStorage.setItem("mehfil.face", f);
      paintFaces();
    };
    box.appendChild(b);
  }
}
paintFaces();

function chatLine(html, cls) {
  const log = $("chatLog");
  if (!log) return;
  const d = document.createElement("div");
  d.className = cls || "cmsg";
  d.innerHTML = html;
  log.appendChild(d);
  while (log.children.length > 120) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function floatEmoji(emoji) {
  const s = document.createElement("div");
  s.className = "emoji-float";
  s.textContent = emoji;
  s.style.left = `${10 + Math.random() * 78}%`;
  document.body.appendChild(s);
  setTimeout(() => s.remove(), 2400);
}

function render() {
  if (!state) return;

  const n = state.members.length;
  $("memberCount").textContent = n === 1 ? "just you" : `${n} in the jam`;

  const cur = state.current;
  $("nowPlaying").classList.toggle("live", !!cur);
  $("npEmpty").classList.toggle("hidden", !!cur);
  $("npBody").classList.toggle("hidden", !cur);
  if (cur) {
    $("npThumb").src = cur.thumb || "";
    $("npThumb").classList.toggle("hidden", !cur.thumb);
    $("npTitle").textContent = cur.title;
    $("npArtist").textContent = cur.artist || "";
    $("npOwner").textContent = `queued by ${cur.ownerName}`;
    $("playPauseBtn").textContent = cur.pausedAt ? "Resume" : "Pause";
    document.querySelector(".live-label").textContent = cur.pausedAt ? "Paused" : "Now playing";
    document.querySelector(".eq").classList.toggle("paused", !!cur.pausedAt);
    const mine = cur.ownerId === myId;
    $("skipBtn").textContent = mine
      ? "Skip (it's yours)"
      : `Skip (${state.skipVotes}/${state.skipNeeded})`;
  }

  const queueList = $("queueList");
  queueList.innerHTML = "";
  $("queueEmpty").classList.toggle("hidden", state.queue.length > 0);
  for (const entry of state.queue) {
    const li = document.createElement("li");
    li.className = entry.status;
    const thumb = entry.thumb
      ? `<img class="q-thumb" src="${encodeURI(entry.thumb)}" alt="" />`
      : `<span class="q-thumb ph"></span>`;
    const sub =
      entry.status === "fetching" ? "fetching…"
      : entry.status === "error" ? `couldn't fetch — ${escapeHtml(entry.error || "unknown error")}`
      : [entry.artist, entry.duration ? fmt(entry.duration) : ""].filter(Boolean).join(" · ");
    li.innerHTML = `${thumb}
      <span class="q-main">
        <span class="q-title">${escapeHtml(entry.title)}</span>
        <span class="q-sub">${entry.status === "error" ? sub : escapeHtml(sub)}</span>
      </span>
      <span class="q-owner">${escapeHtml(entry.ownerName)}</span>`;
    if (entry.ownerId === myId) {
      const rm = document.createElement("button");
      rm.className = "ghost tiny";
      rm.textContent = "✕";
      rm.title = "Remove";
      rm.onclick = () => send({ type: "queueRemove", entryId: entry.id });
      li.appendChild(rm);
    }
    queueList.appendChild(li);
  }

  const ml = $("memberList");
  ml.innerHTML = "";
  for (const m of state.members) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="face"></span><span class="mname"></span><span class="mstat"></span>`;
    const f = li.querySelector(".face");
    f.textContent = m.avatar || (m.name || "?").trim().charAt(0).toUpperCase();
    f.style.background = tint(m.name || "");
    li.querySelector(".mname").textContent = m.name + (m.id === myId ? " (you)" : "");
    li.querySelector(".mstat").textContent = m.holding ? "buffering" : "";
    ml.appendChild(li);
  }

  const a = state.access || { mode: "open" };
  const linkOnly = a.mode === "link";
  $("accessBtn").textContent = linkOnly ? "Only with the link" : "Anyone on this wifi";
  $("accessHint").textContent = linkOnly
    ? "People who find this address can't get in without the link below."
    : "Anyone who can open this address walks straight in.";
  $("shareRow").classList.toggle("hidden", !linkOnly);
  if (linkOnly) {
    $("shareLink").value = `${location.origin}/?k=${encodeURIComponent(a.key)}${location.hash}`;
  }
  // re-fetched whenever mode/key changes, not on every render call
  const qrTag = `${a.mode}:${a.key || ""}`;
  if ($("qrImg").dataset.qrFor !== qrTag) {
    $("qrImg").dataset.qrFor = qrTag;
    $("qrImg").src = `/qr?v=${encodeURIComponent(qrTag)}`;
  }
}

$("accessBtn").addEventListener("click", () => {
  const linkOnly = state && state.access && state.access.mode === "link";
  send({ type: "setAccess", mode: linkOnly ? "open" : "link" });
});

$("shareCopy").addEventListener("click", () => {
  navigator.clipboard.writeText($("shareLink").value).then(() => {
    toast("Share link copied");
    const btn = $("shareCopy");
    const was = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = was; btn.classList.remove("copied"); }, 1400);
  });
});
