// Mehfil â€” LAN jukebox server.
// Paste a link (or drop a file) -> the server fetches the audio -> everyone's
// browser streams it from here, clock-synced. Nobody captures anything.

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const selfsigned = require("selfsigned");
const QRCode = require("qrcode");
const { MEDIA_DIR, resolveMeta, download, probeDuration } = require("./jukebox");

// A jam server dies mid-party over nothing: log loudly, keep playing.
process.on("uncaughtException", (err) => console.error("[server] uncaught exception:", err));
process.on("unhandledRejection", (err) => console.error("[server] unhandled rejection:", err));

const PORT = process.env.PORT || 7777;
const PUBLIC_DIR = path.join(__dirname, "public");
const CERT_DIR = path.join(__dirname, ".cert");
const MAX_UPLOAD = 200 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".m4a": "audio/mp4",
};

// getDisplayMedia-era leftover that still matters: media APIs and clean audio
// playback want a secure origin, so everything stays on HTTPS (self-signed).
async function loadCert() {
  const keyPath = path.join(CERT_DIR, "key.pem");
  const certPath = path.join(CERT_DIR, "cert.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const pems = await selfsigned.generate([{ name: "commonName", value: "mehfil" }], {
    days: 3650,
    keySize: 2048,
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

// ---------- rooms ----------

let nextId = 1;

// so a run of [jukebox] lines actually shows spacing/periodicity, not just order
const ts = () => new Date().toISOString().slice(11, 23);
const jlog = (...args) => console.log(`[${ts()}]`, ...args);
let nextEntryId = 1;
const rooms = new Map();

// How the jam can be reached:
//   open â€” anyone who can reach this address walks in (the office wifi case)
//   link â€” a key from the share link is required, for when the server is
//          exposed to the internet and strangers shouldn't land in the queue
const access = { mode: "open", key: crypto.randomBytes(6).toString("base64url") };

class Room {
  constructor(name) {
    this.name = name;
    this.members = new Map(); // id -> { id, name, ws }
    this.queue = []; // [{ id, ownerId, ownerName, status, title, artist, duration, thumb, error, file, target }]
    this.current = null; // { entry, startedAt }
    this.skipVotes = new Set();
    this.advanceTimer = null;
    this.heldPlaying = false;
    this.history = []; // chat and announcements, so latecomers see the room
  }

  skipThreshold() {
    if (!this.current) return 0;
    return Math.floor(this.members.size / 2) + 1;
  }

  publicState() {
    return {
      type: "state",
      now: Date.now(),
      members: [...this.members.values()].map((m) => ({
        id: m.id, name: m.name, avatar: m.avatar, holding: m.holding,
      })),
      access: { mode: access.mode, key: access.key },
      queue: this.queue.map(entryView),
      current: this.current
        ? {
            ...entryView(this.current.entry),
            startedAt: this.current.startedAt,
            pausedAt: this.current.pausedAt,
            mediaUrl: `/media/${this.current.entry.id}.m4a`,
          }
        : null,
      skipVotes: this.skipVotes.size,
      skipNeeded: this.skipThreshold(),
    };
  }

  // ---- shared transport controls: anyone in the jam moves everyone ----

  armAdvance() {
    clearTimeout(this.advanceTimer);
    if (!this.current || this.current.pausedAt) return;
    const dur = (this.current.entry.duration || 0) * 1000;
    const remaining = dur > 0 ? dur - (Date.now() - this.current.startedAt) : 15 * 60 * 1000;
    this.advanceTimer = setTimeout(() => this.advance(), Math.max(remaining, 0) + 700);
  }

  pause() {
    if (!this.current || this.current.pausedAt) return;
    this.current.pausedAt = Date.now();
    this.heldPlaying = false; // a deliberate pause outranks any waiting
    clearTimeout(this.advanceTimer);
    this.broadcastState();
  }

  // Same "wait for me" the extension has: if one person's audio stalls, the
  // room pauses and picks up again by itself. On a phone over patchy wifi this
  // is the difference between listening together and drifting apart.
  applyHolds() {
    const holders = [...this.members.values()].filter((m) => m.holding);
    if (!this.current) return;
    if (holders.length && !this.current.pausedAt) {
      this.current.pausedAt = Date.now();
      this.heldPlaying = true;
      clearTimeout(this.advanceTimer);
      jlog(`[jukebox] room "${this.name}" held for buffering: ${holders.map((m) => m.name).join(", ")}`);
      this.broadcastState();
    } else if (!holders.length && this.heldPlaying && this.current.pausedAt) {
      const heldMs = Date.now() - this.current.pausedAt;
      this.current.startedAt += heldMs;
      this.current.pausedAt = null;
      this.heldPlaying = false;
      this.armAdvance();
      jlog(`[jukebox] room "${this.name}" resumed after ${heldMs}ms held`);
      this.broadcastState();
    }
  }

  say(text) {
    const msg = { type: "said", text, at: Date.now() };
    this.history.push(msg);
    if (this.history.length > 60) this.history.shift();
    this.broadcast(msg);
  }

  resume() {
    if (!this.current || !this.current.pausedAt) return;
    this.current.startedAt += Date.now() - this.current.pausedAt;
    this.current.pausedAt = null;
    this.armAdvance();
    this.broadcastState();
  }

  seek(positionSec) {
    if (!this.current) return;
    const dur = this.current.entry.duration || 0;
    const pos = Math.min(Math.max(0, positionSec), dur > 0 ? dur - 0.5 : positionSec);
    const anchor = this.current.pausedAt || Date.now();
    this.current.startedAt = anchor - pos * 1000;
    this.armAdvance();
    this.broadcastState();
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m.ws.readyState === 1) m.ws.send(s);
    }
  }

  broadcastState() {
    this.broadcast(this.publicState());
  }

  // Play the first non-errored entry once it's ready. Errored entries stay
  // visible in the queue (with their reason) until expireError removes them â€”
  // they must never vanish silently.
  poke() {
    if (!this.current) {
      const idx = this.queue.findIndex((e) => e.status !== "error");
      if (idx !== -1 && this.queue[idx].status === "ready") {
        const [head] = this.queue.splice(idx, 1);
        this.current = { entry: head, startedAt: Date.now(), pausedAt: null };
        this.skipVotes = new Set();
        this.armAdvance();
      }
    }
    this.broadcastState();
    // a room everyone abandoned finishes its last track, then evaporates
    if (this.members.size === 0 && !this.current) rooms.delete(this.name);
  }

  // Announce a failed fetch loudly, keep the card around for a minute.
  failEntry(entry, err, context) {
    entry.status = "error";
    entry.error = String(err.message || err).slice(0, 200);
    jlog(`[jukebox] ${context} failed: ${entry.error}`);
    this.broadcast({ type: "toast", text: `Couldn't fetch "${entry.title}" â€” ${entry.error}` });
    setTimeout(() => {
      const i = this.queue.indexOf(entry);
      if (i !== -1) {
        this.queue.splice(i, 1);
        this.broadcastState();
      }
    }, 60000);
  }

  advance() {
    clearTimeout(this.advanceTimer);
    this.heldPlaying = false;
    if (this.current) {
      const f = path.join(MEDIA_DIR, `${this.current.entry.id}.m4a`);
      fs.unlink(f, () => {}); // played tracks don't need to stay on disk
    }
    this.current = null;
    this.skipVotes = new Set();
    this.poke();
  }
}

function entryView(e) {
  return {
    id: e.id,
    ownerId: e.ownerId,
    ownerName: e.ownerName,
    status: e.status,
    title: e.title,
    artist: e.artist,
    duration: e.duration,
    thumb: e.thumb,
    error: e.error,
  };
}

function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    room = new Room(name);
    rooms.set(name, room);
  }
  return room;
}

// Link entry: card appears instantly as "fetching", fills in as it resolves.
async function ingestLink(room, entry, url) {
  try {
    const meta = await resolveMeta(url);
    Object.assign(entry, meta, { target: meta.target });
    room.broadcastState();
    await download(entry.target, entry.id);
    entry.status = "ready";
  } catch (err) {
    room.failEntry(entry, err, url);
  }
  room.broadcastState();
  room.poke();
}

// ---------- http ----------

const handler = (req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (req.method === "POST" && urlPath === "/upload") return handleUpload(req, res);
  if (urlPath.startsWith("/media/")) return serveMedia(req, res, urlPath.slice(7));
  if (urlPath.startsWith("/r/")) return serveRoomLink(req, res, urlPath.slice(3));
  if (urlPath === "/qr") return serveQr(req, res);

  const file = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = path.join(PUBLIC_DIR, path.normalize(file));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("nope");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
};

// The room link. The extension watches for this URL and joins silently, so a
// user with sync-lis installed barely sees this page; without it, this is the
// install prompt.
function serveRoomLink(req, res, code) {
  code = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 5);
  const room = syncRooms.get(code);
  const body = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sync-lis room ${code}</title>
<style>
  body{background:#141210;color:#ece7df;font-family:"Segoe UI",system-ui,sans-serif;
       min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0}
  .c{max-width:380px;padding:24px;text-align:center}
  h1{font-size:34px;font-weight:750;letter-spacing:-1px;margin:0}
  h1::after{content:".";color:#ffb454}
  .code{font-size:40px;font-weight:750;letter-spacing:8px;color:#ffb454;margin:18px 0 6px}
  p{color:#9a9184;line-height:1.55;margin:10px 0}
  .now{color:#ece7df}
</style></head><body><div class="c">
<h1>sync-lis</h1>
<div class="code">${code}</div>
${room
  ? `<p>Room is live${room.members.size ? ` Â· ${room.members.size} inside` : ""}.</p>
     ${room.content ? `<p class="now">Playing: ${escapeHtml(room.content.title || room.content.url)}</p>` : ""}
     <p>With sync-lis installed, this tab joins automatically and jumps to what's playing. Nothing happening? Open the extension and enter the code.</p>`
  : `<p>That room isn't live right now.</p>`}
</div></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

// A phone joins by scanning this, not by typing an HTTPS IP:port by hand.
// `req.headers.host` is exactly what the requesting browser is already
// addressing this server as â€” on the host machine that's the LAN IP (the
// README has whoever runs the server open the printed wifi URL, not
// localhost), so a QR generated from that context already points a phone at
// the right address without the server having to guess between interfaces.
function serveQr(req, res) {
  const url = `https://${req.headers.host}/${access.mode === "link" ? `?k=${access.key}` : ""}`;
  QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#141210", light: "#0000" } })
    .then((svg) => {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
      res.end(svg);
    })
    .catch(() => { res.writeHead(500); res.end(); });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Range-capable media serving â€” seeking and late joins need 206s.
function serveMedia(req, res, name) {
  if (!/^[\w-]+\.m4a$/.test(name)) {
    res.writeHead(400);
    return res.end();
  }
  const file = path.join(MEDIA_DIR, name);
  fs.stat(file, (err, st) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? parseInt(range[1]) : 0;
      const end = range[2] ? Math.min(parseInt(range[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || end < start) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        "Content-Type": "audio/mp4",
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": "audio/mp4", "Accept-Ranges": "bytes", "Content-Length": st.size });
      fs.createReadStream(file).pipe(res);
    }
  });
}

// Drag-and-drop local files: raw body streamed straight to media/, no forms.
function handleUpload(req, res) {
  const q = new URL(req.url, "https://x").searchParams;
  const roomName = (q.get("room") || "jam").toLowerCase();
  const memberId = parseInt(q.get("member") || "0");
  const fileName = (q.get("name") || "track").slice(0, 120);
  const room = rooms.get(roomName);
  const member = room && room.members.get(memberId);
  if (!member) {
    res.writeHead(403);
    return res.end(JSON.stringify({ error: "join the jam first" }));
  }

  const id = nextEntryId++;
  const tmp = path.join(MEDIA_DIR, `u${id}${path.extname(fileName) || ".bin"}`);
  const out = fs.createWriteStream(tmp);
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_UPLOAD) {
      req.destroy();
      out.destroy();
      fs.unlink(tmp, () => {});
    }
  });
  req.pipe(out);
  out.on("finish", async () => {
    try {
    const entry = {
      id,
      ownerId: member.id,
      ownerName: member.name,
      status: "fetching",
      title: fileName.replace(/\.[^.]+$/, ""),
      artist: "local file",
      duration: 0,
      thumb: null,
    };
    room.queue.push(entry);
    room.broadcastState();
    try {
      // normalize anything droppable (mp3/flac/wav/m4aâ€¦) to m4a
      const final = path.join(MEDIA_DIR, `${id}.m4a`);
      const { spawn } = require("child_process");
      await new Promise((resolve, reject) => {
        const p = spawn("ffmpeg", ["-y", "-i", tmp, "-vn", "-c:a", "aac", "-b:a", "256k", final], { windowsHide: true });
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg could not read that file"))));
      });
      entry.duration = await probeDuration(final);
      entry.status = "ready";
    } catch (err) {
      room.failEntry(entry, err, `upload ${fileName}`);
    }
    fs.unlink(tmp, () => {});
    room.broadcastState();
    room.poke();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, id }));
    } catch (err) {
      // uploader may have vanished mid-transcode; never let that kill the party
      console.error("[server] upload finalize failed:", err.message);
      try { res.destroy(); } catch {}
    }
  });
  out.on("error", () => {});
  req.on("error", () => {});
}

// ---------- watch-together sync sessions (synclist) ----------
// Tiny state-authoritative relay: the server stores one transport state
// {paused, time, at} per session and re-broadcasts it on every command.
// Clients reconcile against state, never against event streams â€” that's what
// makes this survive echo loops and late joiners.

const syncRooms = new Map(); // code -> { code, members: Map, state, content }

function makeCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from(crypto.randomBytes(5), (b) => alphabet[b % alphabet.length]).join("");
  } while (syncRooms.has(code));
  return code;
}

function syncSend(sr, msg) {
  // anything worth reading later is kept, so a panel reopened an hour in still
  // shows the conversation instead of an empty box
  if (msg.type === "syncChat" || msg.type === "syncNarrate" || msg.type === "syncSaid") {
    sr.history.push(msg);
    if (sr.history.length > 80) sr.history.shift();
  }
  const s = JSON.stringify(msg);
  for (const m of sr.members.values()) {
    if (m.ws.readyState === 1) m.ws.send(s);
  }
}

// short spoken line about who did what, for the transcript
function said(sr, text) {
  syncSend(sr, { type: "syncSaid", text, at: Date.now() });
}

// A pasted link, named as well as we can without fetching anything. The real
// title arrives later, from whoever's player actually lands on it.
function labelFor(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").replace(/\.com$|\.be$/, "");
    const id = new URLSearchParams(u.search).get("v")
      || u.pathname.split("/").filter(Boolean).pop()
      || "";
    return `${host}${id ? ` · ${id.slice(0, 22)}` : ""}`;
  } catch {
    return url.slice(0, 40);
  }
}

// Move the room onto the next thing in the running order.
function playNext(sr, byName) {
  const next = sr.queue.shift();
  if (!next) {
    // nothing left: stop, rather than leaving the finished track sitting there
    sr.content = null;
    sr.state = { paused: true, time: 0, at: Date.now(), rate: sr.state.rate || 1 };
    sr.heldPlaying = false;
    said(sr, "that was the last one");
    return syncBroadcast(sr);
  }
  // key stays null until a player tells us what the page calls itself
  sr.content = { key: next.key || null, url: next.url, title: next.title, kind: next.kind || "generic" };
  sr.contentAt = Date.now();
  armArrivalGrace(sr);
  for (const m of sr.members.values()) m.arrivedKey = null;
  sr.state = { paused: true, time: 0, at: Date.now(), rate: sr.state.rate || 1 };
  sr.heldPlaying = true; // start together once everyone has landed on it
  syncSend(sr, {
    type: "syncNarrate",
    text: `${next.title} — ${next.byName}'s pick${byName ? `, skipped by ${byName}` : ""}`,
  });
  syncBroadcast(sr);
}

function syncBroadcast(sr) {
  clearTimeout(sr.coalesce);
  sr.coalesce = null;
  syncSend(sr, {
    type: "syncState",
    now: Date.now(),
    state: sr.state,
    content: sr.content,
    hostId: sr.hostId,
    locked: sr.locked,
    queue: sr.queue,
    lastAction: sr.lastAction,
    countdownAt: sr.countdownAt,
    members: [...sr.members.values()].map((m) => ({
      id: m.id, name: m.name, avatar: m.avatar,
      holding: m.holding, ready: m.ready, pos: m.pos,
      away: m.away, voice: m.voice,
      arrived: !sr.content || m.arrivedKey === sr.content.key,
    })),
  });
}

// position pings shouldn't cost a broadcast each; coalesce them
function syncBroadcastSoon(sr) {
  if (sr.coalesce) return;
  sr.coalesce = setTimeout(() => syncBroadcast(sr), 2000);
}

// A member holds the room if their player is buffering, or if the room has
// moved to something new and they have not landed on it yet. Treating arrival
// as just another reason to wait is what removes the "ghost seconds" where one
// side is still playing the old thing.
// Waiting for someone to land on the new track is right, but it cannot be
// unbounded: a tab we are not allowed to script never reports arriving, and
// one of those would freeze the room for everybody, forever.
const ARRIVAL_GRACE_MS = 20000;

function isHolding(m, sr) {
  if (m.holding) return true;
  if (!sr.content) return false;
  if (sr.content.key && m.arrivedKey === sr.content.key) return false;
  // A queued link has no name until a player tells us one, so until then
  // nobody counts as arrived. Either way the wait has a ceiling.
  return Date.now() - (sr.contentAt || 0) < ARRIVAL_GRACE_MS;
}

// the grace period expiring has to wake the room by itself
function armArrivalGrace(sr) {
  clearTimeout(sr.graceTimer);
  sr.graceTimer = setTimeout(() => {
    if (!syncRooms.has(sr.code)) return;
    applyHolds(sr);
    syncBroadcast(sr);
  }, ARRIVAL_GRACE_MS + 200);
}

// "Wait for me": while anyone holds, the room pauses, and it resumes by itself
// once everyone is ready again. This is what makes co-watching survive a bad
// connection.
function applyHolds(sr) {
  const holding = [...sr.members.values()].some((m) => isHolding(m, sr));
  if (holding && !sr.state.paused) {
    sr.state = { paused: true, time: transportTime(sr), at: Date.now(), rate: sr.state.rate || 1 };
    sr.heldPlaying = true;
    sr.lastAction = { name: holdingNames(sr)[0] || "someone", action: "buffering", at: Date.now() };
  } else if (!holding && sr.heldPlaying) {
    sr.state = { paused: false, time: sr.state.time, at: Date.now(), rate: sr.state.rate || 1 };
    sr.heldPlaying = false;
    sr.lastAction = { name: "everyone", action: "back in sync", at: Date.now() };
  }
}

function holdingNames(sr) {
  return [...sr.members.values()].filter((m) => isHolding(m, sr)).map((m) => m.name);
}

function transportTime(sr) {
  const s = sr.state;
  return s.paused ? s.time : s.time + ((Date.now() - s.at) / 1000) * (s.rate || 1);
}

// ---------- websocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

// dead-socket sweep: office wifi drops connections without closing them; ghost
// members inflate counts and skip thresholds forever unless actively culled
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("connection", (ws) => {
  let me = null;
  let room = null;
  let syncMe = null;   // membership in a watch-together session
  let syncRoom = null;

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // token-bucket rate limit: a hot-looping client gets dropped msgs, not a
  // broadcast storm amplified to the whole room
  let bucket = 25;
  const refill = setInterval(() => { bucket = 25; }, 1000);
  ws.on("close", () => clearInterval(refill));

  ws.on("message", (raw) => {
    if (--bucket < 0) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // clock ping works for jam and sync connections alike
    if (msg.type === "ping") {
      return ws.send(JSON.stringify({ type: "pong", t: msg.t, now: Date.now() }));
    }

    // ----- watch-together -----
    if (msg.type === "syncCreate" || msg.type === "syncJoin") {
      if (syncRoom) return;
      let sr;
      if (msg.type === "syncCreate") {
        sr = {
          code: makeCode(),
          members: new Map(),
          state: { paused: true, time: 0, at: Date.now(), rate: 1 },
          content: null,     // { key, url, title, kind }
          hostId: null,      // whoever opened the room
          locked: false,     // host-only control
          history: [],       // so reopening the panel doesn't lose the chat
          // The jam: everyone drops links, they play one after another on each
          // person's own account. Nothing is fetched or hosted here, so the
          // queue is just a running order.
          queue: [],
          qid: 1,
          heldPlaying: false,
          lastAction: null,
          countdownAt: null,
          coalesce: null,
        };
        syncRooms.set(sr.code, sr);
      } else {
        sr = syncRooms.get(String(msg.code || "").toUpperCase().trim());
        if (!sr) return ws.send(JSON.stringify({ type: "syncError", text: "No session with that code." }));
      }
      syncRoom = sr;
      syncMe = {
        id: nextId++,
        name: String(msg.name || "anon").slice(0, 24),
        avatar: String(msg.avatar || "").slice(0, 8),
        ws, holding: false, ready: false, pos: 0, away: false, voice: false,
        arrivedKey: null,
      };
      sr.members.set(syncMe.id, syncMe);
      if (!sr.hostId) sr.hostId = syncMe.id;
      ws.send(JSON.stringify({
        type: "syncJoined", code: sr.code, now: Date.now(),
        content: sr.content, state: sr.state, meId: syncMe.id,
        history: sr.history,
      }));
      sr.lastAction = { name: syncMe.name, action: "joined", at: Date.now() };
      said(sr, `${syncMe.name} joined`);
      syncBroadcast(sr);
      return;
    }
    // ---- co-watching extras ----
    if (syncRoom && syncMe) {
      const sr = syncRoom, me = syncMe;
      switch (msg.type) {
        case "syncHold": {
          const holding = !!msg.holding;
          if (holding === me.holding) return;
          me.holding = holding;
          applyHolds(sr);
          return syncBroadcast(sr);
        }
        case "syncPos": {
          const t = Number(msg.time);
          if (isFinite(t)) me.pos = Math.round(t * 10) / 10;
          return syncBroadcastSoon(sr);
        }
        // stepped away from the tab, so silence has an explanation
        // who you are is changeable after joining: people arrive through a
        // link before anyone has asked their name
        case "syncIdentity": {
          const name = String(msg.name || "").slice(0, 24).trim();
          const avatar = String(msg.avatar || "").slice(0, 8);
          const was = me.name;
          if (name && name !== me.name) me.name = name;
          if (avatar !== undefined) me.avatar = avatar;
          if (name && was !== name && was !== "friend") said(sr, `${was} is now ${name}`);
          return syncBroadcast(sr);
        }
        // party pieces: a sound everyone hears, a reaction the size of the
        // screen, and a message written now but revealed when you choose
        case "syncSting": {
          const kind = String(msg.kind || "").slice(0, 16);
          if (kind) syncSend(sr, { type: "syncSting", kind, from: me.name });
          return;
        }
        case "syncBig": {
          const emoji = String(msg.emoji || "").slice(0, 8);
          if (emoji) syncSend(sr, { type: "syncBig", emoji, from: me.name });
          return;
        }
        case "syncSecret": {
          const text = String(msg.text || "").slice(0, 200).trim();
          if (text) syncSend(sr, { type: "syncSecret", text, from: me.name });
          return;
        }
        // ---- the jam: a shared running order ----
        case "syncQueueAdd": {
          const url = String(msg.url || "").trim().slice(0, 500);
          if (!/^https?:\/\//.test(url)) {
            return ws.send(JSON.stringify({ type: "syncNote", text: "that doesn't look like a link" }));
          }
          if (sr.queue.length >= 100) {
            return ws.send(JSON.stringify({ type: "syncNote", text: "the queue is full" }));
          }
          const entry = {
            id: sr.qid++,
            url,
            key: String(msg.key || "").slice(0, 200) || null,
            title: String(msg.title || "").slice(0, 120) || labelFor(url),
            kind: String(msg.kind || "generic").slice(0, 16),
            byId: me.id,
            byName: me.name,
          };
          sr.queue.push(entry);
          said(sr, `${me.name} queued ${entry.title}`);
          // an empty room starts straight away rather than waiting to be told
          if (!sr.content) return playNext(sr);
          return syncBroadcast(sr);
        }
        case "syncQueueRemove": {
          const i = sr.queue.findIndex((q) => q.id === msg.id);
          if (i === -1) return;
          // your own picks are yours to pull; anyone can prune once it is theirs
          if (sr.queue[i].byId !== me.id && sr.hostId !== me.id) return;
          sr.queue.splice(i, 1);
          return syncBroadcast(sr);
        }
        case "syncQueueNext": {
          if (sr.locked && me.id !== sr.hostId) {
            ws.send(JSON.stringify({ type: "syncNote", text: "controls are locked by the host" }));
            return syncBroadcast(sr);
          }
          return playNext(sr, me.name);
        }
        // whoever's player reaches the end moves the room along
        case "syncEnded": {
          const key = String(msg.key || "");
          if (!sr.content || key !== sr.content.key) return;
          // Everyone's player finishes, so ignore repeats of the SAME track.
          // A time window would also swallow the next track's honest ending.
          if (sr.endedKey === key) return;
          sr.endedKey = key;
          return playNext(sr);
        }
        case "syncAway": {
          const away = !!msg.away;
          if (away === me.away) return;
          me.away = away;
          return syncBroadcast(sr);
        }
        case "syncTyping": {
          return syncSend(sr, { type: "syncTyping", from: me.name, fromId: me.id });
        }
        // voice: the server only carries the handshake, never the audio
        case "syncVoice": {
          me.voice = !!msg.on;
          return syncBroadcast(sr);
        }
        case "syncSignal": {
          const to = sr.members.get(msg.to);
          if (to && to.ws.readyState === 1) {
            to.ws.send(JSON.stringify({ type: "syncSignal", from: me.id, data: msg.data }));
          }
          return;
        }
        case "syncChat": {
          const text = String(msg.text || "").slice(0, 500).trim();
          if (!text) return;
          return syncSend(sr, {
            type: "syncChat", from: me.name, fromId: me.id, text,
            videoTime: transportTime(sr), at: Date.now(),
          });
        }
        case "syncReact": {
          const emoji = String(msg.emoji || "").slice(0, 8);
          if (!emoji) return;
          return syncSend(sr, { type: "syncReact", from: me.name, fromId: me.id, emoji });
        }
        case "syncHostLock": {
          if (me.id !== sr.hostId) {
            return ws.send(JSON.stringify({ type: "syncNote", text: "Only the room's host can lock controls." }));
          }
          sr.locked = !!msg.locked;
          sr.lastAction = { name: me.name, action: sr.locked ? "locked controls" : "unlocked controls", at: Date.now() };
          return syncBroadcast(sr);
        }
        // Ready check: nobody starts alone. When everyone's in, the server
        // schedules the play for a moment in the future so all sides begin
        // on the same wall-clock tick.
        case "syncReady": {
          me.ready = !!msg.ready;
          const all = [...sr.members.values()];
          if (me.ready && all.length > 1 && all.every((m) => m.ready)) {
            sr.countdownAt = Date.now() + 3000;
            sr.state = { paused: false, time: transportTime(sr), at: sr.countdownAt, rate: sr.state.rate || 1 };
            sr.lastAction = { name: "everyone", action: "ready", at: Date.now() };
            all.forEach((m) => { m.ready = false; });
            setTimeout(() => {
              if (syncRooms.get(sr.code) === sr) { sr.countdownAt = null; syncBroadcast(sr); }
            }, 3200);
          }
          return syncBroadcast(sr);
        }
      }
    }
    // whoever changes what's playing changes it for the whole room
    if (msg.type === "syncContent" && syncRoom) {
      const key = String(msg.key || "").slice(0, 200);
      const url = String(msg.url || "").slice(0, 800);
      if (!key || !/^https?:\/\//.test(url)) return;

      // A link queued from the panel only carries a URL. The player is the
      // only thing that sees the real page, so the first one to land on it
      // names it for the room. Adopting that name is NOT a content switch:
      // treating it as one reset the timeline and paused everyone on a loop,
      // which is what solo playback looked like.
      if (syncRoom.content && !syncRoom.content.key) {
        syncRoom.content.key = key;
        syncMe.arrivedKey = key;
        const real = String(msg.title || "").slice(0, 200);
        if (real && !/^https?:\/\/| · /.test(real)) syncRoom.content.title = real;
        applyHolds(syncRoom);
        return syncBroadcast(syncRoom);
      }

      // already the room's content: this is someone arriving on it
      if (syncRoom.content && syncRoom.content.key === key) {
        let changed = false;
        if (syncMe.arrivedKey !== key) {
          syncMe.arrivedKey = key;
          applyHolds(syncRoom);
          changed = true;
        }
        // a queued link only had a guess at its name; the player knows the real
        // one, so the first person to land on it fills it in for everyone
        const real = String(msg.title || "").slice(0, 200);
        if (real && real !== syncRoom.content.title && !/^https?:\/\/| · /.test(real)) {
          syncRoom.content.title = real;
          changed = true;
        }
        if (changed) syncBroadcast(syncRoom);
        return;
      }

      const title = String(msg.title || "").slice(0, 200);
      syncRoom.content = { key, url, title, kind: String(msg.kind || "generic").slice(0, 16) };
      syncRoom.contentAt = Date.now();
      armArrivalGrace(syncRoom);
      // everyone has to land on the new thing before anything plays
      for (const m of syncRoom.members.values()) m.arrivedKey = null;
      syncMe.arrivedKey = key;
      const t = Number(msg.time);
      syncRoom.state = { paused: true, time: isFinite(t) && t > 0 ? t : 0, at: Date.now(), rate: syncRoom.state.rate || 1 };
      syncRoom.heldPlaying = true; // start together once everyone has arrived
      syncSend(syncRoom, {
        type: "syncNarrate",
        text: `${syncMe.name} put on ${title || "something new"}`,
      });
      syncBroadcast(syncRoom);
      return;
    }
    if (msg.type === "syncCmd" && syncRoom) {
      const t = Number(msg.time);
      if (!isFinite(t) || t < 0) return;
      // A command names the content it was measured against. If the room has
      // already moved on (a switch is mid-flight, or this is a stale message
      // from just before one), applying its time would silently corrupt the
      // shared clock — a paused-at-3:44 sent a beat late becomes everyone's
      // position on a track that just started at 0. Drop it instead of
      // trusting a caller-supplied timestamp against content we can't verify.
      const wantKey = syncRoom.content && syncRoom.content.key;
      if (wantKey && msg.key && msg.key !== wantKey) return;
      if (syncRoom.locked && syncMe.id !== syncRoom.hostId) {
        ws.send(JSON.stringify({ type: "syncNote", text: "Controls are locked by the host." }));
        // send the truth straight back so their player snaps into line now,
        // instead of drifting for a couple of seconds before being corrected
        return syncBroadcast(syncRoom);
      }
      // someone deliberately pausing overrides an in-progress buffering hold
      if (msg.action === "pause") syncRoom.heldPlaying = false;
      const rate = syncRoom.state.rate || 1;
      if (msg.action === "play") syncRoom.state = { paused: false, time: t, at: Date.now(), rate };
      else if (msg.action === "pause") syncRoom.state = { paused: true, time: t, at: Date.now(), rate };
      else if (msg.action === "seek") syncRoom.state = { paused: syncRoom.state.paused, time: t, at: Date.now(), rate };
      else if (msg.action === "rate") {
        // one person speeding the video up speeds it up for everyone
        const r = Number(msg.rate);
        if (!isFinite(r) || r < 0.25 || r > 4) return;
        syncRoom.state = { paused: syncRoom.state.paused, time: t, at: Date.now(), rate: r };
      } else return;
      const did = {
        play: "pressed play", pause: "paused", seek: "jumped ahead",
        rate: `set the speed to ${syncRoom.state.rate}x`,
      }[msg.action];
      syncRoom.lastAction = { name: syncMe.name, action: did, at: Date.now() };
      said(syncRoom, `${syncMe.name} ${did}`);
      syncBroadcast(syncRoom);
      return;
    }

    if (msg.type === "join" && !me) {
      if (access.mode === "link" && String(msg.key || "") !== access.key) {
        ws.send(JSON.stringify({
          type: "denied",
          text: "This jam is link-only right now. Ask for the share link.",
        }));
        return ws.close();
      }
      room = getRoom(String(msg.room || "jam").slice(0, 32).toLowerCase() || "jam");
      me = {
        id: nextId++,
        name: String(msg.name || "anon").slice(0, 24),
        avatar: String(msg.avatar || "").slice(0, 8),
        holding: false, ws,
      };
      room.members.set(me.id, me);
      ws.send(JSON.stringify({ type: "welcome", id: me.id, now: Date.now(), history: room.history }));
      room.say(`${me.name} joined`);
      room.broadcastState();
      return;
    }
    if (!me) return;

    switch (msg.type) {
      case "queueAdd": {
        const url = String(msg.url || "").trim().slice(0, 500);
        if (!/^(https?:\/\/|spotify:)/.test(url)) {
          ws.send(JSON.stringify({ type: "toast", text: "That doesn't look like a link." }));
          return;
        }
        if (room.queue.length >= 50) {
          ws.send(JSON.stringify({ type: "toast", text: "Queue's full (50) â€” let it breathe." }));
          return;
        }
        const entry = {
          id: nextEntryId++,
          ownerId: me.id,
          ownerName: me.name,
          status: "fetching",
          title: url,
          artist: "",
          duration: 0,
          thumb: null,
        };
        room.queue.push(entry);
        room.broadcastState();
        ingestLink(room, entry, url);
        break;
      }
      case "queueRemove": {
        const i = room.queue.findIndex((e) => e.id === msg.entryId && e.ownerId === me.id);
        if (i !== -1) {
          const [e] = room.queue.splice(i, 1);
          fs.unlink(path.join(MEDIA_DIR, `${e.id}.m4a`), () => {});
          room.broadcastState();
        }
        break;
      }
      case "pause":
        room.pause();
        break;
      case "resume":
        room.resume();
        break;
      case "seek":
        if (typeof msg.position === "number" && isFinite(msg.position)) room.seek(msg.position);
        break;
      case "hold": {
        const h = !!msg.holding;
        if (h === me.holding) return;
        me.holding = h;
        // a monitorable trail for "why is this room stuck buffering" —
        // rapid alternating true/false from the same name is the signature
        // of a client-side hold/seek feedback loop, not a real network stall
        jlog(`[jukebox] ${me.name} holding=${h}`);
        room.applyHolds();
        room.broadcastState();
        break;
      }
      case "chat": {
        const text = String(msg.text || "").slice(0, 500).trim();
        if (!text) return;
        const out = { type: "chat", from: me.name, avatar: me.avatar, text, at: Date.now() };
        room.history.push(out);
        if (room.history.length > 60) room.history.shift();
        room.broadcast(out);
        break;
      }
      case "react": {
        const emoji = String(msg.emoji || "").slice(0, 8);
        if (emoji) room.broadcast({ type: "react", emoji, from: me.name });
        break;
      }
      case "setAccess": {
        const mode = msg.mode === "link" ? "link" : "open";
        if (mode !== access.mode) {
          access.mode = mode;
          if (mode === "link") {
            // a fresh key each time it's locked, so an old link can't let people back in
            access.key = crypto.randomBytes(6).toString("base64url");
            // printed so whoever runs the server can always recover the link â€”
            // otherwise losing it locks everyone out until a restart
            console.log(`[jam] link-only. share: /?k=${access.key}`);
          } else {
            console.log("[jam] open to anyone who can reach this address");
          }
          for (const r of rooms.values()) r.broadcastState();
        }
        break;
      }
      case "voteSkip": {
        if (!room.current) return;
        // the person who queued it can pull it instantly
        if (room.current.entry.ownerId === me.id) return room.advance();
        room.skipVotes.add(me.id);
        if (room.skipVotes.size >= room.skipThreshold()) room.advance();
        else room.broadcastState();
        break;
      }
    }
  });

  ws.on("close", () => {
    if (syncMe && syncRoom) {
      syncRoom.members.delete(syncMe.id);
      if (syncRoom.members.size === 0) {
        clearTimeout(syncRoom.coalesce);
        syncRooms.delete(syncRoom.code);
      } else {
        // host left: pass it on, and never leave the room stuck locked
        if (syncRoom.hostId === syncMe.id) {
          syncRoom.hostId = syncRoom.members.keys().next().value;
          syncRoom.locked = false;
        }
        syncRoom.lastAction = { name: syncMe.name, action: "left", at: Date.now() };
        said(syncRoom, `${syncMe.name} left`);
        applyHolds(syncRoom); // their hold leaves with them
        syncBroadcast(syncRoom);
      }
    }
    if (!me || !room) return;
    room.members.delete(me.id);
    room.skipVotes.delete(me.id);
    room.say(`${me.name} left`);
    // queued-but-unplayed entries leave with their owner; the playing one finishes
    for (let i = room.queue.length - 1; i >= 0; i--) {
      if (room.queue[i].ownerId === me.id) {
        fs.unlink(path.join(MEDIA_DIR, `${room.queue[i].id}.m4a`), () => {});
        room.queue.splice(i, 1);
      }
    }
    if (room.current && room.skipVotes.size >= room.skipThreshold()) room.advance();
    else room.broadcastState();
    if (room.members.size === 0 && !room.current) rooms.delete(room.name);
  });
});

// ---------- boot ----------

(async () => {
  // media/ holds only in-flight tracks; anything from a previous run is orphaned
  for (const f of fs.readdirSync(MEDIA_DIR)) fs.unlink(path.join(MEDIA_DIR, f), () => {});
  const { key, cert } = await loadCert();
  const server = https.createServer({ key, cert }, handler);
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  server.listen(PORT, () => {
    const lanIps = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === "IPv4" && !n.internal)
      .map((n) => n.address);
    console.log(`\n  Mehfil jukebox is on ðŸŽ¶\n`);
    console.log(`  local:   https://localhost:${PORT}`);
    for (const ip of lanIps) console.log(`  wifi:    https://${ip}:${PORT}`);
    console.log(`\n  Self-signed cert: each device clicks through the warning once.`);
    console.log(`  (Windows firewall: Allow on PRIVATE networks on first run)\n`);
  });
})();



