// The popup's one job: get you into a room, or tell you that you're already
// in one. Everything else — chat, queue, controls — lives in the on-page
// panel now, not here. This closes itself the moment it has done its job.

"use strict";

const $ = (id) => document.getElementById(id);
const FACES = ["🎧", "🍿", "👾", "🐙", "🌙", "🔥", "🦊", "🫠", "💀", "🧃", "🪩", "🐈", "🌵", "🧊", "🎃", "👻"];

let tabId = null;
let myFace = "";

const sw = (msg) => chrome.runtime.sendMessage({ target: "sync", ...msg }).catch(() => null);

function err(text) {
  $("err").textContent = text;
  $("err").classList.toggle("hidden", !text);
  // the same line doubles as the copy confirmation, so drop that styling
  // whenever it goes back to reporting a genuine problem
  $("err").classList.remove("said");
}

function paintFaces() {
  const box = $("faces");
  box.innerHTML = "";
  for (const f of FACES) {
    const b = document.createElement("button");
    b.className = f === myFace ? "on" : "";
    b.textContent = f;
    b.onclick = async () => { myFace = f; await chrome.storage.local.set({ avatar: f }); paintFaces(); };
    box.appendChild(b);
  }
}

$("createBtn").addEventListener("click", async () => {
  const name = $("nameInput").value.trim();
  if (!name) return err("give yourself a name first");
  await chrome.storage.local.set({ name });
  err(null);
  const res = await sw({ type: "create", tabId, server: RELAY, name, avatar: myFace });
  if (!res || res.error) return err((res && res.error) || "could not start the room");
  // The only thing anyone does after starting a room is send the link, so put
  // it on the clipboard here rather than making them reopen the panel to find
  // it. The popup stays up briefly so the copy is acknowledged, not silent.
  if (res.code) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(`${RELAY}/r/${res.code}`);
      copied = true;
    } catch {}
    if (copied) {
      $("err").textContent = `room ${res.code} — invite link copied`;
      $("err").classList.remove("hidden");
      $("err").classList.add("said");
      await new Promise((r) => setTimeout(r, 1100));
    } else {
      return showLink(`${RELAY}/r/${res.code}`);
    }
  }
  window.close();
});

$("joinBtn").addEventListener("click", async () => {
  const raw = $("codeInput").value.trim();
  const link = raw.match(/^(https?:\/\/[^/]+)\/r\/([A-Za-z0-9]{5})/);
  const server = link ? link[1] : RELAY;
  const code = (link ? link[2] : raw).toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) return err("paste the room link, or the 5-character code");
  const name = $("nameInput").value.trim();
  if (!name) return err("give yourself a name first");
  await chrome.storage.local.set({ name });
  err(null);
  const res = await sw({ type: "join", tabId, server, name, code, avatar: myFace });
  if (!res || res.error) return err((res && res.error) || "could not join");
  window.close();
});

// pasting a code/link then hitting Enter should join, same as clicking Join —
// there's no <form> here (Enter does nothing by default on a bare input)
$("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("joinBtn").click();
});

$("leaveBtn").addEventListener("click", async () => {
  await sw({ type: "leave", tabId });
  window.close();
});

$("showBtn").addEventListener("click", async () => {
  try { await chrome.tabs.sendMessage(tabId, { target: "sync-lis-page", type: "expand" }); } catch {}
  window.close();
});

// Report link: a one-tap page on the relay, no account needed (worker/src/bye.js,
// /feedback). Only the topic tapped and this version are recorded.
$("reportLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${RELAY}/feedback?v=${chrome.runtime.getManifest().version}` });
  window.close();
});

// Copy failed (some pages block the clipboard): show the link to copy by hand and keep
// the popup open, instead of closing with nothing to send.
function showLink(link) {
  $("linkBox").value = link;
  $("linkBox").classList.remove("hidden");
  $("linkBox").select();
  err("copy this link and send it");
}

$("copyBtn").addEventListener("click", async () => {
  const st = await sw({ type: "status", tabId });
  if (!st || !st.code) return;
  const link = `${st.server || RELAY}/r/${st.code}`;
  try {
    await navigator.clipboard.writeText(link);
    $("copyNote").textContent = "invite link copied";
    $("copyNote").classList.remove("hidden");
  } catch {
    $("copyNote").textContent = link;
    $("copyNote").classList.remove("hidden");
  }
});

document.querySelectorAll("[data-go]").forEach((b) => {
  b.addEventListener("click", async () => {
    if (tabId != null) await chrome.tabs.update(tabId, { url: b.dataset.go });
    window.close();
  });
});

// Tabs the extension can never script (browser pages, the Web Store, new tabs).
const PROTECTED = /^(chrome|edge|brave|about|chrome-extension|view-source|devtools):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

const RELAY = "https://sync-lis-relay.sync-lis-relay.workers.dev";

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  if (tab && (!tab.url || PROTECTED.test(tab.url))) {
    $("openFirst").classList.remove("hidden");
    $("createBtn").disabled = true;
  }
  const cfg = await chrome.storage.local.get({ name: "", avatar: "" });
  $("nameInput").value = cfg.name;
  myFace = cfg.avatar || "";
  paintFaces();

  const status = await sw({ type: "status", tabId });
  if (status) {
    $("door").classList.add("hidden");
    $("here").classList.remove("hidden");
    $("roomCode").textContent = status.code || "·····";
    const n = (status.members || []).length;
    $("memberLine").textContent = n <= 1 ? "waiting for someone to join" : `${n} in the room`;
  }
})();
