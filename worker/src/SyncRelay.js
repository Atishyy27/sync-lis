// Durable Object port of server.js's watch-together relay (the `sync*`
// message types only — server.js:598-1075 at the time of this port). mehfil's
// own jukebox stays on server.js; it shells out to yt-dlp/ffmpeg, which a
// Workers sandbox can't do. This can move because it never touched the
// filesystem: it was always just state-authoritative message routing.
//
// Room state lives in this.ctx.storage, not plain instance fields — fields
// don't survive Durable Object hibernation (the object being unloaded from
// memory while its WebSockets stay open, Cloudflare's own cost-saving
// mechanism for idle connections), only ctx.storage does. Per-connection
// identity (which member a given live socket belongs to) is carried on the
// socket itself via serializeAttachment/deserializeAttachment for the same
// reason: the JS-side Map linking "this ws" to "this member" is exactly the
// kind of thing a hibernation cycle discards.
//
// In practice this project's rooms are small and actively watched — a
// content.js tab reports its position every 2s while a room is open, so a
// mid-session hibernation is unlikely — but the storage-backed design means
// correctness doesn't depend on that being true.

import { DurableObject } from "cloudflare:workers";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ARRIVAL_GRACE_MS = 20000;

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

function transportTime(sr) {
  const s = sr.state;
  return s.paused ? s.time : s.time + ((Date.now() - s.at) / 1000) * (s.rate || 1);
}

// A member holds the room if their player is buffering, or if the room has
// moved to something new and they have not landed on it yet. Waiting for
// someone to land on the new track is right, but it cannot be unbounded: a
// tab that never reports arriving would freeze the room forever otherwise.
function isHolding(m, sr) {
  if (m.holding) return true;
  if (!sr.content) return false;
  if (sr.content.key && m.arrivedKey === sr.content.key) return false;
  return Date.now() - (sr.contentAt || 0) < ARRIVAL_GRACE_MS;
}

function holdingNames(sr) {
  return Object.values(sr.membersMeta).filter((m) => isHolding(m, sr)).map((m) => m.name);
}

// "Wait for me": while anyone holds, the room pauses, and it resumes by
// itself once everyone is ready again.
function applyHolds(sr) {
  const holding = Object.values(sr.membersMeta).some((m) => isHolding(m, sr));
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


// Structured, queryable operational logging. JSON on one line so the
// dashboard indexes the fields and they can be filtered on.
//
// Deliberately counts and room codes only: never a title, URL, display name,
// or chat message. The privacy policy this ships under says nothing is
// tracked outside an active room, and the Web Store disclosure says the same;
// logging what people actually watch would make both untrue. Everything here
// answers "is the relay healthy and is anyone using it", which needs no
// personal data at all.
const STORE_URL = "https://chromewebstore.google.com/detail/hcpjipoofgpnenpfjddkkodbobehonlb";

const ev = (evt, fields = {}) => {
  try { console.log(JSON.stringify({ evt, at: Date.now(), ...fields })); } catch {}
};

export class SyncRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cache = new Map();       // code -> sr, lazily loaded from storage
    this.graceTimers = new Map(); // code -> Timeout (arrival grace)
    this.coalesce = new Map();    // code -> Timeout (position-ping broadcast coalescing)
    // No setWebSocketAutoResponse here: the app-level {type:"ping",t} the
    // client sends is answered with a LIVE Date.now() for clock-offset
    // calculation (see webSocketMessage below) — auto-response only replies
    // with a fixed, pre-registered string, so it can't serve a timestamp
    // computed at reply time and doesn't fit this message.
    //
    // server.js also runs a separate, lower-level 30s ws.ping()/isAlive
    // sweep to reap dead sockets — a workaround for plain Node `ws` behind a
    // raw TCP connection, where a half-open socket can sit unnoticed.
    // Deliberately not ported: Cloudflare's own edge already tears down
    // genuinely dead connections and fires webSocketClose/webSocketError,
    // so the same failure mode this sweep exists for is handled a layer
    // lower here.
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/stats") return this.statsResponse();
    if (url.pathname.startsWith("/r/")) return this.roomLinkResponse(url.pathname.slice(3));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Live counts, not stored ones: derived straight from currently-open
  // sockets (this.ctx.getWebSockets()) rather than room storage, so a room
  // that's technically persisted but has nobody connected right now doesn't
  // inflate the numbers.
  statsResponse() {
    const rooms = new Set();
    let users = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a) continue;
      users++;
      rooms.add(a.roomCode);
    }
    return new Response(JSON.stringify({ activeUsers: users, activeRooms: rooms.size, at: Date.now() }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // The page someone lands on when they click a share link. Ported from
  // server.js's serveRoomLink: without it the relay speaks WebSocket only and
  // every room link 404s, which is the one thing that kept the extension
  // pointed at the Node server instead of here.
  async roomLinkResponse(rawCode) {
    const code = rawCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 5);
    const sr = await this.getRoom(code);
    // presence comes from live sockets, not stored membersMeta, so a room
    // nobody is currently connected to doesn't claim to have people in it
    const inside = sr ? this.socketsInRoom(code).length : 0;
    const esc = (t) => String(t).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    // Everyone who lands here without the extension is someone a friend
    // personally invited: the highest-intent visitor this product will ever
    // get. Sending them away with "install it and come back" wastes that, so
    // the install button is the page's primary action and the code is kept
    // visible for them to paste after installing. joinlink.js strips this the
    // moment it runs, so anyone who DOES have it never sees an install nag.
    const body = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sync-lis room ${esc(code)}</title>
<style>
  body{background:#141210;color:#ece7df;font-family:"Segoe UI",system-ui,sans-serif;
       min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0}
  .c{max-width:400px;padding:24px;text-align:center}
  h1{font-size:34px;font-weight:750;letter-spacing:-1px;margin:0}
  h1::after{content:".";color:#ffb454}
  .code{font-size:40px;font-weight:750;letter-spacing:8px;color:#ffb454;margin:18px 0 6px}
  p{color:#9a9184;line-height:1.55;margin:10px 0}
  .now{color:#ece7df}
  .cta{display:inline-block;margin:18px 0 8px;padding:11px 20px;border-radius:9px;
       background:#ffb454;color:#161310;font-weight:650;text-decoration:none;font-size:15px}
  .cta:hover{filter:brightness(1.06)}
  .fine{font-size:12.5px;color:#6b6357}
  #have{display:none}
</style></head><body><div class="c">
<h1>sync-lis</h1>
<div class="code">${esc(code)}</div>
${sr
  ? `<p>Room is live${inside ? ` &middot; ${inside} inside` : ""}.</p>
     ${sr.content ? `<p class="now">Playing: ${esc(sr.content.title || sr.content.url || "")}</p>` : ""}`
  : `<p>That room isn't live right now.</p>`}
<div id="need">
  <a class="cta" href="${STORE_URL}" target="_blank" rel="noopener">Add sync-lis to Chrome</a>
  <p class="fine">Free. Then reopen this link and you'll drop straight into
  whatever they're watching, at their timestamp.</p>
</div>
<div id="have">
  <p>Joining you now. If nothing happens, open sync-lis and enter the code above.</p>
</div>
</div></body></html>`;
    return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // ---------- room storage ----------

  async getRoom(code) {
    if (this.cache.has(code)) return this.cache.get(code);
    const sr = await this.ctx.storage.get(`room:${code}`);
    if (sr) this.cache.set(code, sr);
    return sr || null;
  }

  async saveRoom(sr) {
    this.cache.set(sr.code, sr);
    await this.ctx.storage.put(`room:${sr.code}`, sr);
  }

  async deleteRoom(code) {
    this.cache.delete(code);
    clearTimeout(this.graceTimers.get(code));
    clearTimeout(this.coalesce.get(code));
    this.graceTimers.delete(code);
    this.coalesce.delete(code);
    await this.ctx.storage.delete(`room:${code}`);
  }

  async makeCode() {
    let code;
    do {
      const bytes = crypto.getRandomValues(new Uint8Array(5));
      code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
    } while (await this.getRoom(code));
    return code;
  }

  // ---------- broadcast ----------

  socketsInRoom(code) {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment();
      return a && a.roomCode === code;
    });
  }

  async syncSend(sr, msg) {
    // anything worth reading later is kept, so a panel reopened later still
    // shows the conversation instead of an empty box
    if (msg.type === "syncChat" || msg.type === "syncNarrate" || msg.type === "syncSaid") {
      sr.history.push(msg);
      if (sr.history.length > 80) sr.history.shift();
      await this.saveRoom(sr);
    }
    const s = JSON.stringify(msg);
    for (const ws of this.socketsInRoom(sr.code)) {
      try { ws.send(s); } catch {}
    }
  }

  async said(sr, text) {
    await this.syncSend(sr, { type: "syncSaid", text, at: Date.now() });
  }

  async syncBroadcast(sr) {
    clearTimeout(this.coalesce.get(sr.code));
    this.coalesce.delete(sr.code);
    await this.saveRoom(sr);
    const members = Object.values(sr.membersMeta).map((m) => ({
      id: m.id, name: m.name, avatar: m.avatar,
      holding: m.holding, ready: m.ready, pos: m.pos,
      away: m.away, voice: m.voice,
      arrived: !sr.content || m.arrivedKey === sr.content.key,
    }));
    await this.syncSend(sr, {
      type: "syncState", now: Date.now(), state: sr.state, content: sr.content,
      hostId: sr.hostId, locked: sr.locked, queue: sr.queue,
      lastAction: sr.lastAction, countdownAt: sr.countdownAt, members,
    });
  }

  // position pings shouldn't cost a broadcast each; coalesce them
  syncBroadcastSoon(sr) {
    if (this.coalesce.has(sr.code)) return;
    this.coalesce.set(sr.code, setTimeout(() => { this.syncBroadcast(sr).catch(() => {}); }, 2000));
  }

  // the grace period expiring has to wake the room by itself
  armArrivalGrace(sr) {
    clearTimeout(this.graceTimers.get(sr.code));
    const code = sr.code;
    this.graceTimers.set(sr.code, setTimeout(async () => {
      const cur = await this.getRoom(code);
      if (!cur) return;
      applyHolds(cur);
      await this.syncBroadcast(cur);
    }, ARRIVAL_GRACE_MS + 200));
  }

  // Move the room onto the next thing in the running order.
  async playNext(sr, byName) {
    const next = sr.queue.shift();
    if (!next) {
      sr.content = null;
      sr.state = { paused: true, time: 0, at: Date.now(), rate: sr.state.rate || 1 };
      sr.heldPlaying = false;
      await this.said(sr, "that was the last one");
      return this.syncBroadcast(sr);
    }
    sr.content = { key: next.key || null, url: next.url, title: next.title, kind: next.kind || "generic" };
    sr.contentAt = Date.now();
    this.armArrivalGrace(sr);
    for (const m of Object.values(sr.membersMeta)) m.arrivedKey = null;
    sr.state = { paused: true, time: 0, at: Date.now(), rate: sr.state.rate || 1 };
    sr.heldPlaying = true;
    await this.syncSend(sr, {
      type: "syncNarrate",
      text: `${next.title} — ${next.byName}'s pick${byName ? `, skipped by ${byName}` : ""}`,
    });
    await this.syncBroadcast(sr);
  }

  // ---------- websocket lifecycle ----------

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "ping") {
      return ws.send(JSON.stringify({ type: "pong", t: msg.t, now: Date.now() }));
    }

    let att = ws.deserializeAttachment();

    if (msg.type === "syncCreate" || msg.type === "syncJoin") {
      if (att) return; // this socket already joined a room
      let sr;
      if (msg.type === "syncCreate") {
        sr = {
          code: await this.makeCode(),
          nextMemberId: 1,
          membersMeta: {},
          state: { paused: true, time: 0, at: Date.now(), rate: 1 },
          content: null,
          hostId: null,
          locked: false,
          history: [],
          queue: [],
          qid: 1,
          heldPlaying: false,
          lastAction: null,
          countdownAt: null,
          endedKey: null,
          contentAt: null,
        };
      } else {
        sr = await this.getRoom(String(msg.code || "").toUpperCase().trim());
        if (!sr) {
          ev("join_missed", { code: String(msg.code || "").toUpperCase().trim().slice(0, 5) });
          return ws.send(JSON.stringify({ type: "syncError", text: "No session with that code." }));
        }
      }
      const memberId = sr.nextMemberId++;
      const me = {
        id: memberId,
        name: String(msg.name || "anon").slice(0, 24),
        avatar: String(msg.avatar || "").slice(0, 8),
        holding: false, ready: false, pos: 0, away: false, voice: false,
        arrivedKey: null,
      };
      sr.membersMeta[memberId] = me;
      if (!sr.hostId) sr.hostId = memberId;
      att = { roomCode: sr.code, memberId };
      ws.serializeAttachment(att);
      await this.saveRoom(sr);
      ws.send(JSON.stringify({
        type: "syncJoined", code: sr.code, now: Date.now(),
        content: sr.content, state: sr.state, meId: memberId,
        history: sr.history,
      }));
      ev(msg.type === "syncCreate" ? "room_created" : "room_joined", {
        code: sr.code, members: Object.keys(sr.membersMeta).length,
      });
      sr.lastAction = { name: me.name, action: "joined", at: Date.now() };
      await this.said(sr, `${me.name} joined`);
      await this.syncBroadcast(sr);
      return;
    }

    if (!att) return; // everything below requires an already-joined room

    // token-bucket rate limit: a hot-looping client gets dropped messages,
    // not a broadcast storm amplified to the whole room. Computed from
    // elapsed time rather than server.js's per-connection setInterval,
    // since a per-socket JS interval wouldn't survive hibernation either.
    const now = Date.now();
    let bucket = att.bucket ?? 25;
    let bucketAt = att.bucketAt ?? now;
    if (now - bucketAt >= 1000) { bucket = 25; bucketAt = now; }
    if (--bucket < 0) {
      ws.serializeAttachment({ ...att, bucket, bucketAt });
      return;
    }
    att = { ...att, bucket, bucketAt };
    ws.serializeAttachment(att);

    const sr = await this.getRoom(att.roomCode);
    if (!sr) return;
    const me = sr.membersMeta[att.memberId];
    if (!me) return;

    switch (msg.type) {
      case "syncHold": {
        const holding = !!msg.holding;
        if (holding === me.holding) return;
        me.holding = holding;
        applyHolds(sr);
        return this.syncBroadcast(sr);
      }
      case "syncPos": {
        const t = Number(msg.time);
        if (isFinite(t)) me.pos = Math.round(t * 10) / 10;
        await this.saveRoom(sr); // deferred broadcast below must not lose this to hibernation
        return this.syncBroadcastSoon(sr);
      }
      // who you are is changeable after joining: people arrive through a
      // link before anyone has asked their name
      case "syncIdentity": {
        const name = String(msg.name || "").slice(0, 24).trim();
        const avatar = String(msg.avatar || "").slice(0, 8);
        const was = me.name;
        if (name && name !== me.name) me.name = name;
        if (avatar !== undefined) me.avatar = avatar;
        if (name && was !== name && was !== "friend") await this.said(sr, `${was} is now ${name}`);
        return this.syncBroadcast(sr);
      }
      // party pieces: a sound everyone hears, a reaction the size of the
      // screen, and a message written now but revealed when you choose
      case "syncSting": {
        const kind = String(msg.kind || "").slice(0, 16);
        if (kind) return this.syncSend(sr, { type: "syncSting", kind, from: me.name });
        return;
      }
      case "syncBig": {
        const emoji = String(msg.emoji || "").slice(0, 8);
        if (emoji) return this.syncSend(sr, { type: "syncBig", emoji, from: me.name });
        return;
      }
      case "syncSecret": {
        const text = String(msg.text || "").slice(0, 200).trim();
        if (text) return this.syncSend(sr, { type: "syncSecret", text, from: me.name });
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
        await this.said(sr, `${me.name} queued ${entry.title}`);
        // an empty room starts straight away rather than waiting to be told
        if (!sr.content) return this.playNext(sr);
        return this.syncBroadcast(sr);
      }
      case "syncQueueRemove": {
        const i = sr.queue.findIndex((q) => q.id === msg.id);
        if (i === -1) return;
        // your own picks are yours to pull; anyone can prune once it is theirs
        if (sr.queue[i].byId !== me.id && sr.hostId !== me.id) return;
        sr.queue.splice(i, 1);
        return this.syncBroadcast(sr);
      }
      case "syncQueueNext": {
        if (sr.locked && me.id !== sr.hostId) {
          ws.send(JSON.stringify({ type: "syncNote", text: "controls are locked by the host" }));
          return this.syncBroadcast(sr);
        }
        return this.playNext(sr, me.name);
      }
      // whoever's player reaches the end moves the room along
      case "syncEnded": {
        const key = String(msg.key || "");
        if (!sr.content || key !== sr.content.key) return;
        if (sr.endedKey === key) return;
        sr.endedKey = key;
        return this.playNext(sr);
      }
      case "syncAway": {
        const away = !!msg.away;
        if (away === me.away) return;
        me.away = away;
        return this.syncBroadcast(sr);
      }
      case "syncTyping": {
        return this.syncSend(sr, { type: "syncTyping", from: me.name, fromId: me.id });
      }
      // voice: this relay only ever carries the handshake, never the audio
      case "syncVoice": {
        me.voice = !!msg.on;
        return this.syncBroadcast(sr);
      }
      case "syncSignal": {
        const toWs = this.socketsInRoom(sr.code)
          .find((w) => { const a = w.deserializeAttachment(); return a && a.memberId === msg.to; });
        if (toWs) toWs.send(JSON.stringify({ type: "syncSignal", from: me.id, data: msg.data }));
        return;
      }
      case "syncChat": {
        const text = String(msg.text || "").slice(0, 500).trim();
        if (!text) return;
        return this.syncSend(sr, {
          type: "syncChat", from: me.name, fromId: me.id, text,
          videoTime: transportTime(sr), at: Date.now(),
        });
      }
      case "syncReact": {
        const emoji = String(msg.emoji || "").slice(0, 8);
        if (!emoji) return;
        return this.syncSend(sr, { type: "syncReact", from: me.name, fromId: me.id, emoji });
      }
      case "syncHostLock": {
        if (me.id !== sr.hostId) {
          return ws.send(JSON.stringify({ type: "syncNote", text: "Only the room's host can lock controls." }));
        }
        sr.locked = !!msg.locked;
        sr.lastAction = { name: me.name, action: sr.locked ? "locked controls" : "unlocked controls", at: Date.now() };
        return this.syncBroadcast(sr);
      }
      // Ready check: nobody starts alone. When everyone's in, the room
      // schedules the play for a moment in the future so all sides begin on
      // the same wall-clock tick.
      case "syncReady": {
        me.ready = !!msg.ready;
        const all = Object.values(sr.membersMeta);
        if (me.ready && all.length > 1 && all.every((m) => m.ready)) {
          const countdownAt = Date.now() + 3000;
          sr.countdownAt = countdownAt;
          sr.state = { paused: false, time: transportTime(sr), at: countdownAt, rate: sr.state.rate || 1 };
          sr.lastAction = { name: "everyone", action: "ready", at: Date.now() };
          all.forEach((m) => { m.ready = false; });
          const code = sr.code;
          setTimeout(async () => {
            const cur = await this.getRoom(code);
            if (cur && cur.countdownAt === countdownAt) {
              cur.countdownAt = null;
              await this.syncBroadcast(cur);
            }
          }, 3200);
        }
        return this.syncBroadcast(sr);
      }
      // whoever changes what's playing changes it for the whole room
      case "syncContent": {
        const key = String(msg.key || "").slice(0, 200);
        const url = String(msg.url || "").slice(0, 800);
        if (!key || !/^https?:\/\//.test(url)) return;

        // A link queued from the panel only carries a URL. The player is the
        // only thing that sees the real page, so the first one to land on it
        // names it for the room. Adopting that name is NOT a content switch.
        if (sr.content && !sr.content.key) {
          sr.content.key = key;
          me.arrivedKey = key;
          const real = String(msg.title || "").slice(0, 200);
          if (real && !/^https?:\/\/| · /.test(real)) sr.content.title = real;
          applyHolds(sr);
          return this.syncBroadcast(sr);
        }

        // already the room's content: this is someone arriving on it
        if (sr.content && sr.content.key === key) {
          let changed = false;
          if (me.arrivedKey !== key) {
            me.arrivedKey = key;
            applyHolds(sr);
            changed = true;
          }
          const real = String(msg.title || "").slice(0, 200);
          if (real && real !== sr.content.title && !/^https?:\/\/| · /.test(real)) {
            sr.content.title = real;
            changed = true;
          }
          if (changed) return this.syncBroadcast(sr);
          return; // nothing changed: nothing to persist or announce
        }

        const title = String(msg.title || "").slice(0, 200);
        sr.content = { key, url, title, kind: String(msg.kind || "generic").slice(0, 16) };
        sr.contentAt = Date.now();
        this.armArrivalGrace(sr);
        for (const m of Object.values(sr.membersMeta)) m.arrivedKey = null;
        me.arrivedKey = key;
        const t = Number(msg.time);
        sr.state = { paused: true, time: isFinite(t) && t > 0 ? t : 0, at: Date.now(), rate: sr.state.rate || 1 };
        sr.heldPlaying = true; // start together once everyone has arrived
        await this.syncSend(sr, { type: "syncNarrate", text: `${me.name} put on ${title || "something new"}` });
        return this.syncBroadcast(sr);
      }
      case "syncCmd": {
        const t = Number(msg.time);
        if (!isFinite(t) || t < 0) return;
        // A command names the content it was measured against; drop it if
        // the room has already moved on (see server.js's identical guard).
        const wantKey = sr.content && sr.content.key;
        if (wantKey && msg.key && msg.key !== wantKey) return;
        if (sr.locked && me.id !== sr.hostId) {
          ws.send(JSON.stringify({ type: "syncNote", text: "Controls are locked by the host." }));
          return this.syncBroadcast(sr);
        }
        if (msg.action === "pause") sr.heldPlaying = false;
        const rate = sr.state.rate || 1;
        if (msg.action === "play") sr.state = { paused: false, time: t, at: Date.now(), rate };
        else if (msg.action === "pause") sr.state = { paused: true, time: t, at: Date.now(), rate };
        else if (msg.action === "seek") sr.state = { paused: sr.state.paused, time: t, at: Date.now(), rate };
        else if (msg.action === "rate") {
          const r = Number(msg.rate);
          if (!isFinite(r) || r < 0.25 || r > 4) return;
          sr.state = { paused: sr.state.paused, time: t, at: Date.now(), rate: r };
        } else return;
        const did = {
          play: "pressed play", pause: "paused", seek: "jumped ahead",
          rate: `set the speed to ${sr.state.rate}x`,
        }[msg.action];
        sr.lastAction = { name: me.name, action: did, at: Date.now() };
        await this.said(sr, `${me.name} ${did}`);
        return this.syncBroadcast(sr);
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // No ws.close(code, reason) here: on this compatibility date the runtime
    // already auto-replies to the client's Close frame, and re-closing with
    // whatever code the client sent throws for reserved codes like 1005/1006
    // (no-status / abnormal closure) — which aborted this handler before it
    // ever reached the room cleanup below.
    const att = ws.deserializeAttachment();
    if (!att) return;
    const sr = await this.getRoom(att.roomCode);
    if (!sr) return;
    const me = sr.membersMeta[att.memberId];
    if (!me) return;
    delete sr.membersMeta[att.memberId];
    // wasClean separates "closed the tab" from "the connection died", which is
    // the difference between normal churn and a bug worth chasing
    ev("member_left", {
      code: sr.code, wsCode: code, clean: !!wasClean,
      remaining: Object.keys(sr.membersMeta).length,
    });
    if (Object.keys(sr.membersMeta).length === 0) {
      return this.deleteRoom(sr.code);
    }
    // host left: pass it on, and never leave the room stuck locked
    if (sr.hostId === att.memberId) {
      sr.hostId = Number(Object.keys(sr.membersMeta)[0]);
      sr.locked = false;
    }
    sr.lastAction = { name: me.name, action: "left", at: Date.now() };
    await this.said(sr, `${me.name} left`);
    applyHolds(sr); // their hold leaves with them
    await this.syncBroadcast(sr);
  }

  async webSocketError(ws) {
    try { await this.webSocketClose(ws, 1011, "error", false); } catch {}
  }
}
