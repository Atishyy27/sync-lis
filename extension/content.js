// sync-lis agent â€” injected into the tab being watched together.
// Two jobs: (1) report what this tab is playing and when someone drives it,
// (2) reconcile this tab against the room's state.
//
// Design rules:
//   1. Reconcile against STATE, idempotently â€” echoes become no-ops.
//   2. Small drift is fixed with playbackRate nudges, not visible seeks.
//   3. Ads are a hold: never sync during one, resync when it ends.
//   4. Site quirks live in adapters, not in the sync logic.

(() => {
  if (window.__syncLisAgent) return;
  window.__syncLisAgent = true;

  const host = location.hostname;

  // ---------- helpers ----------

  const mmss = (text) => {
    const parts = String(text || "").trim().split(":").map(Number);
    if (parts.some(isNaN) || !parts.length) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  };

  // React-controlled inputs ignore .value = x; go through the native setter.
  function setRangeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Pick the thing that's actually the show: the biggest video on screen,
  // ignoring thumbnails and preview blips. Audio elements are counted too —
  // music sites have no picture, and looking only for <video> made every one
  // of them invisible to us.
  function bestMedia() {
    let best = null, bestScore = 0;
    for (const m of document.querySelectorAll("video,audio")) {
      let score;
      if (m.tagName === "AUDIO") {
        if (!m.currentSrc && !m.src) continue;
        score = 5000; // always loses to a real video, always beats nothing
      } else {
        const r = m.getBoundingClientRect();
        score = r.width * r.height;
        if (score < 200 * 120) continue;
      }
      if (m.duration && m.duration < 45) score /= 10;
      if (!m.paused) score *= 2;
      if (score > bestScore) { best = m; bestScore = score; }
    }
    return best;
  }

  // ---------- adapters ----------

  const generic = {
    kind: "generic",
    canRate: true,
    tolerance: 2.5,
    el: () => bestMedia(),
    ready() { return !!this.el(); },
    key() { return location.href.split("#")[0]; },
    url() { return location.href.split("#")[0]; },
    title() { return document.title; },
    isAd() { return false; },
    getTime() { const v = this.el(); return v ? v.currentTime : 0; },
    isPaused() { const v = this.el(); return !v || v.paused; },
    seek(t) { const v = this.el(); if (v) v.currentTime = Math.max(0, t); },
    play() { const v = this.el(); if (v) v.play().catch(() => {}); },
    pause() { const v = this.el(); if (v) v.pause(); },
    setRate(r) { const v = this.el(); if (v) v.playbackRate = r; },
    ensureContent() {},
  };

  const youtube = Object.assign({}, generic, {
    kind: "youtube",
    el: () => document.querySelector("video.html5-main-video") || bestMedia(),
    key() {
      const id = new URLSearchParams(location.search).get("v");
      if (id) return `yt:${id}`;
      const m = location.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/);
      return m ? `yt:${m[1]}` : null;
    },
    url() {
      const k = this.key();
      return k ? `https://www.youtube.com/watch?v=${k.slice(3)}` : location.href;
    },
    title() {
      const h = document.querySelector("#title h1, h1.ytd-watch-metadata");
      return (h ? h.textContent : document.title).replace(/ - YouTube$/, "").trim();
    },
    // an ad plays inside the same <video>; syncing through it drags the room
    isAd() {
      const p = document.querySelector("#movie_player, .html5-video-player");
      return !!(p && p.classList.contains("ad-showing"));
    },
  });

  const netflix = Object.assign({}, generic, {
    kind: "netflix",
    bridgeOk: true,
    key() {
      const m = location.pathname.match(/\/watch\/(\d+)/);
      return m ? `nf:${m[1]}` : null;
    },
    url() {
      const k = this.key();
      return k ? `https://www.netflix.com/watch/${k.slice(3)}` : location.href;
    },
    title() { return document.title.replace(/ - Netflix$/, "").trim(); },
    // Netflix's player overrides direct currentTime writes; drive its own API
    // through the MAIN-world bridge instead, falling back if it's not there.
    seek(t) {
      if (this.bridgeOk) window.postMessage({ source: "sync-lis-agent", action: "seek", time: Math.max(0, t) }, "*");
      else generic.seek.call(this, t);
    },
    play() {
      if (this.bridgeOk) window.postMessage({ source: "sync-lis-agent", action: "play" }, "*");
      else generic.play.call(this);
    },
    pause() {
      if (this.bridgeOk) window.postMessage({ source: "sync-lis-agent", action: "pause" }, "*");
      else generic.pause.call(this);
    },
  });

  // Prime keeps the same URL while an overlay player runs, so the address bar
  // alone cannot tell one episode from the next. The playing asset id (`gti`)
  // is the reliable identity when it's there.
  const prime = Object.assign({}, generic, {
    kind: "prime",
    gti() {
      const q = new URLSearchParams(location.search);
      return q.get("gti") || q.get("asin") || null;
    },
    key() {
      const g = this.gti();
      if (g) return `pv:g:${g}`;
      const m = location.pathname.match(/\/detail\/([A-Z0-9]{8,})/i);
      return m ? `pv:${m[1]}` : null;
    },
    // The asset id is not a path you can navigate to, so it rides along as a
    // parameter. Sending a link built out of it produced a dead page, and the
    // key read back as nothing, which is a recipe for endless bouncing.
    url() {
      const g = this.gti();
      const base = location.origin + location.pathname;
      return g ? `${base}?gti=${encodeURIComponent(g)}` : base;
    },
    // A show's page counts even before anything plays: that page IS where you
    // want the other person to land, and waiting for a media element meant
    // nobody ever followed you onto Prime.
    ready() { return !!this.el() || !!this.key(); },
    title() { return document.title.replace(/\s*[-|]\s*Prime Video.*$/i, "").trim(); },
    // Prime marks its ad breaks on the player container
    isAd() {
      return !!document.querySelector('.adFriendlyControls, [class*="adCountdown"], [data-testid="ad-timer"]');
    },
  });

  // Hotstar (JioHotstar) puts a numeric content id in the watch URL.
  const hotstar = Object.assign({}, generic, {
    kind: "hotstar",
    key() {
      const m = location.pathname.match(/\/(?:shows|movies|sports|clips|episodes?)\/[^/]+\/(\d+)/);
      if (m) return `hs:${m[1]}`;
      const n = location.pathname.match(/\/(\d{6,})/);
      return n ? `hs:${n[1]}` : null;
    },
    url() { return location.href.split("?")[0]; },
    ready() { return !!this.el() || !!this.key(); },
    title() { return document.title.replace(/\s*[-|]\s*(Jio)?Hotstar.*$/i, "").trim(); },
    isAd() {
      return !!document.querySelector('[class*="ad-container"], [class*="adBadge"], [data-testid*="ad-"]');
    },
  });

  // Apple Music does expose a media element, so it behaves like any player.
  // A song is identified by the `i` parameter, not by the album in the path.
  const apple = Object.assign({}, generic, {
    kind: "apple",
    canRate: false, // its player ignores rate changes
    key() {
      const i = new URLSearchParams(location.search).get("i");
      if (i) return `am:song:${i}`;
      const m = location.pathname.match(/\/(album|playlist|station|music-video)\/[^/]+\/([\w.-]+)/);
      return m ? `am:${m[1]}:${m[2]}` : null;
    },
    url() { return location.href.split("#")[0]; },
    title() {
      const t = document.querySelector('[data-testid="player-lcd"] , .web-chrome-playback-lcd__song-name-scroll-inner-text-wrapper');
      const live = t && t.textContent.trim();
      if (live) return live.slice(0, 120);
      return document.title.replace(/\s*[-|]\s*Apple Music.*$/i, "").replace(/^‎/, "").trim();
    },
  });

  // JioSaavn and SoundCloud are ordinary HTML media under the hood; they only
  // needed us to stop ignoring <audio>.
  const saavn = Object.assign({}, generic, {
    kind: "saavn",
    key() {
      const m = location.pathname.match(/\/(song|album|featured|artist)\/[^/]+\/([\w-]+)/);
      return m ? `js:${m[1]}:${m[2]}` : null;
    },
    url() { return location.href.split("?")[0]; },
    title() { return document.title.replace(/\s*[-|]\s*JioSaavn.*$/i, "").trim(); },
  });

  const soundcloud = Object.assign({}, generic, {
    kind: "soundcloud",
    key() {
      const p = location.pathname.replace(/\/+$/, "");
      return /^\/[^/]+\/[^/]+$/.test(p) ? `sc:${p}` : null;
    },
    url() { return `https://soundcloud.com${location.pathname.replace(/\/+$/, "")}`; },
    title() { return document.title.replace(/\s*\|\s*Free Listening on SoundCloud.*$/i, "").trim(); },
  });

  // Spotify's web player has no controllable <video>; everything is DOM.
  // Positions are second-granular, so tolerances are wider and there is no
  // playbackRate to nudge â€” seek-only correction.
  const spotify = {
    kind: "spotify",
    canRate: false,
    tolerance: 3,
    // Being on any Spotify page counts. Requiring the player bar meant an open
    // but idle Spotify announced nothing at all, so nobody followed you there.
    ready() { return !!this.playBtn() || !!this.pageKey(); },
    pageKey() {
      const m = location.pathname.match(/\/(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/);
      return m ? `sp:${m[1]}:${m[2]}` : null;
    },
    playBtn() {
      return document.querySelector('[data-testid="control-button-playpause"]')
        || document.querySelector('button[aria-label="Play"], button[aria-label="Pause"]');
    },
    // The bar is `now-playing-bar` in the live player; the older
    // `now-playing-widget` is kept as a fallback. Looking only for the widget
    // meant we never knew what was playing.
    nowPlayingLink() {
      return document.querySelector('[data-testid="now-playing-bar"] a[href*="/track/"]')
        || document.querySelector('[data-testid="now-playing-widget"] a[href*="/track/"]')
        || document.querySelector('[data-testid="context-item-link"]');
    },
    key() {
      const a = this.nowPlayingLink();
      const m = a && a.getAttribute("href").match(/\/track\/([A-Za-z0-9]+)/);
      if (m) return `sp:track:${m[1]}`;
      return this.pageKey(); // whatever page you're on is followable
    },
    url() {
      const k = this.key();
      if (!k) return location.href.split("?")[0];
      const [, kind, id] = k.split(":");
      return `https://open.spotify.com/${kind}/${id}`;
    },
    title() {
      const a = this.nowPlayingLink();
      const artist = document.querySelector('[data-testid="now-playing-bar"] a[href*="/artist/"]')
        || document.querySelector('[data-testid="now-playing-widget"] a[href*="/artist/"]');
      const live = [a && a.textContent, artist && artist.textContent].filter(Boolean).join(" - ");
      if (live) return live;
      const h = document.querySelector("main h1");
      return (h && h.textContent.trim()) || document.title.replace(/ \| Spotify$/, "");
    },
    isAd() {
      const t = this.title().toLowerCase();
      return t.includes("advertisement") || t.includes("spotify ad");
    },
    getTime() {
      const el = document.querySelector('[data-testid="playback-position"]');
      const v = el && mmss(el.textContent);
      return v == null ? 0 : v;
    },
    duration() {
      const el = document.querySelector('[data-testid="playback-duration"]');
      const v = el && mmss(el.textContent);
      return v == null ? 0 : v;
    },
    isPaused() {
      const b = this.playBtn();
      if (!b) return true;
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      return label.includes("play"); // "Play" shown => currently paused
    },
    seek(t) {
      const dur = this.duration();
      if (!dur) return;
      const frac = Math.min(Math.max(t / dur, 0), 0.999);
      const input = document.querySelector('[data-testid="playback-progressbar"] input[type="range"], input[data-testid="progress-bar"]');
      if (input) {
        const max = Number(input.max) || 100;
        setRangeValue(input, frac * max);
        return;
      }
      // no range input: click the bar at the right fraction
      const bar = document.querySelector('[data-testid="playback-progressbar"], [data-testid="progress-bar"]');
      if (!bar) return;
      const r = bar.getBoundingClientRect();
      const x = r.left + r.width * frac, y = r.top + r.height / 2;
      for (const type of ["pointerdown", "pointerup", "click"]) {
        bar.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y }));
      }
    },
    play() { if (this.isPaused()) { const b = this.playBtn(); if (b) b.click(); } },
    pause() { if (!this.isPaused()) { const b = this.playBtn(); if (b) b.click(); } },
    setRate() {},
    // Landing on /track/<id> shows the track but doesn't start it â€” press the
    // page's own play button so following a partner actually plays the song.
    ensureContent() {
      const want = location.pathname.match(/\/track\/([A-Za-z0-9]+)/);
      if (!want) return;
      if (this.key() === `sp:track:${want[1]}`) return;
      const btn = document.querySelector('[data-testid="action-bar-row"] [data-testid="play-button"], main button[data-testid="play-button"]');
      if (btn) btn.click();
    },
  };

  // music.youtube.com deliberately falls to the YouTube adapter: same player,
  // same ?v= identity, so YouTube Music works for free.
  const adapter =
    /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host) ? youtube
    : /(^|\.)netflix\.com$/.test(host) ? netflix
    : /(^|\.)spotify\.com$/.test(host) ? spotify
    : /(^|\.)primevideo\.com$/.test(host) || /(^|\.)amazon\.[a-z.]+$/.test(host) ? prime
    : /(^|\.)hotstar\.com$/.test(host) ? hotstar
    : /(^|\.)music\.apple\.com$/.test(host) ? apple
    : /(^|\.)jiosaavn\.com$|(^|\.)saavn\.com$/.test(host) ? saavn
    : /(^|\.)soundcloud\.com$/.test(host) ? soundcloud
    : generic;

  // lets the adapter table be checked without a browser (see test/adapters.js)
  try { window.__syncLisAdapterProbe = adapter; } catch {}

  if (adapter === netflix) {
    window.addEventListener("message", (e) => {
      if (e.source === window && e.data && e.data.source === "sync-lis-netflix") netflix.bridgeOk = e.data.ok;
    });
  }

  // ---------- sync ----------

  let port = null;
  let state = null;    // { paused, time, at }
  let content = null;  // { key, url, title, kind }
  let offset = 0;      // serverClock - localClock
  let reconciling = false;
  let reconcileTimer = null;
  let reportedKey = null;
  let watched = null;  // the <video> we have listeners on
  let room = null;     // members, host, lock, countdown
  let holding = false;
  let userSeekAt = 0;      // when this person last grabbed the timeline themselves
  let lastSeenPaused = null; // this player's transport as of the last check
  let lastObserved = null;   // where the player was last time we looked
  let lastObservedAt = 0;

  const ui = window.__syncLisUI;

  function tell(msg) {
    try { if (port) port.postMessage(msg); } catch {}
  }

  // "Wait for me": the room holds while this player buffers.
  let holdSince = 0;
  function setHold(next) {
    if (next === holding) return;
    holding = next;
    holdSince = next ? Date.now() : 0;
    tell({ type: "hold", holding });
  }

  function roomRate() {
    return (state && state.rate) || 1;
  }

  function expectedTime() {
    if (!state) return 0;
    if (state.paused) return state.time;
    return state.time + ((Date.now() + offset - state.at) / 1000) * roomRate();
  }

  function beginReconcile() {
    reconciling = true;
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => { reconciling = false; }, 1200);
  }

  function onRoomContent() {
    // we are on the room's content already if keys match; otherwise the
    // service worker navigates this tab â€” nothing to do here.
    if (content && adapter.ensureContent) adapter.ensureContent();
  }

  function reconcile() {
    if (!state || !adapter.ready()) return;
    if (adapter.isAd()) { adapter.setRate(1); return; }  // hold through ads
    // never fight a seek that's still in flight â€” it's about to become the
    // room's new position via the 'seeked' report
    if (watched && (watched.seeking || Date.now() - userSeekAt < 1500)) return;
    if (content && adapter.key() && content.key !== adapter.key()) { onRoomContent(); return; }

    // Did this person change transport themselves? The 'play' event is
    // cancelled outright if anything pauses the video in the same instant â€”
    // including our own correction â€” so intent is detected by comparing state,
    // not by trusting events to arrive.
    const localPaused = adapter.isPaused();
    if (lastSeenPaused === null) {
      lastSeenPaused = localPaused;
    } else if (localPaused !== lastSeenPaused) {
      lastSeenPaused = localPaused;
      if (!reconciling) {
        sendCmd(localPaused ? "pause" : "play");
        return; // their intent wins this round; the room will confirm it
      }
    }

    const exp = expectedTime();
    if (state.paused) {
      if (!localPaused) { beginReconcile(); adapter.pause(); lastSeenPaused = true; }
      if (Math.abs(adapter.getTime() - state.time) > adapter.tolerance) { beginReconcile(); adapter.seek(state.time); }
      adapter.setRate(1);
      return;
    }
    if (localPaused) {
      beginReconcile();
      if (Math.abs(adapter.getTime() - exp) > adapter.tolerance) adapter.seek(exp);
      adapter.play();
      lastSeenPaused = false;
      return;
    }
    const d = adapter.getTime() - exp;
    if (Math.abs(d) > adapter.tolerance) {
      beginReconcile();
      adapter.seek(exp);
      adapter.setRate(1);
    } else if (!adapter.canRate) {
      // nothing to nudge; small drift is tolerated
    } else if (d > 0.25) {
      adapter.setRate(roomRate() * 0.92);   // nudges ride on top of the room's
    } else if (d < -0.25) {                 // chosen speed, they don't replace it
      adapter.setRate(roomRate() * 1.08);
    } else {
      adapter.setRate(roomRate());
    }
  }

  const counts = { play: 0, pause: 0, seeked: 0, sent: 0, dropped: 0, err: null };

  function sendCmd(action) {
    if (reconciling || !port || adapter.isAd()) { counts.dropped++; return; }
    try {
      port.postMessage({ type: "cmd", action, time: adapter.getTime() });
      counts.sent++;
    } catch (e) {
      counts.err = String(e && e.message || e);
    }
  }

  // report what this tab is playing so everyone else follows
  function reportContent() {
    const key = adapter.key();
    if (!key || key === reportedKey || !port) return;
    // Deliberately NOT skipped during an ad. Which video this is, is perfectly
    // known while an ad plays; only the position is meaningless. Waiting for
    // the ad to end left the other person stranded on the previous video.
    // Only pages that actually hold a player may claim the room. Without this
    // a joiner's own landing page (the room link) would announce itself as the
    // content and drag everyone off what they were watching.
    if (!adapter.ready()) return;
    reportedKey = key;
    try {
      port.postMessage({
        type: "content",
        key,
        url: adapter.url(),
        title: adapter.title(),
        kind: adapter.kind,
        // Always zero. A player's reported position lags a track change by a
        // second or so, so carrying it over made every next song start where
        // the last one ended. Position sync catches up on its own.
        time: 0,
      });
    } catch {}
  }

  const onPlay = () => { counts.play++; lastSeenPaused = false; sendCmd("play"); };
  const onPause = () => { counts.pause++; lastSeenPaused = true; sendCmd("pause"); };
  const onSeeked = () => {
    counts.seeked++;
    if (state && Math.abs(adapter.getTime() - expectedTime()) > 0.75) sendCmd("seek");
  };
  const onWaiting = () => setHold(true);
  const onResumeable = () => setHold(false);
  // A seek the user just started is the truth, not drift to be corrected.
  // 'seeking' fires the moment currentTime is set, well before 'seeked', so
  // without this the correction loop can yank them back mid-scrub.
  const onSeeking = () => { if (!reconciling) userSeekAt = Date.now(); };
  // Someone changing the speed changes it for the room. Our own drift nudges
  // are always a multiple of the room's speed, so they are ignored here.
  const onRateChange = () => {
    if (reconciling || !watched || !state) return;
    const r = watched.playbackRate;
    const base = roomRate();
    if (Math.abs(r - base * 0.92) < 0.01 || Math.abs(r - base * 1.08) < 0.01) return;
    if (Math.abs(r - base) < 0.01) return;
    tell({ type: "cmd", action: "rate", rate: r, time: adapter.getTime() });
  };

  // <video>-based sites report transport via events; Spotify is polled instead
  function attachVideo() {
    if (adapter === spotify) return;
    const v = adapter.el();
    if (v === watched) return;
    if (watched) {
      watched.removeEventListener("play", onPlay);
      watched.removeEventListener("pause", onPause);
      watched.removeEventListener("seeked", onSeeked);
      watched.removeEventListener("seeking", onSeeking);
      watched.removeEventListener("ratechange", onRateChange);
      watched.removeEventListener("waiting", onWaiting);
      watched.removeEventListener("playing", onResumeable);
      watched.removeEventListener("canplaythrough", onResumeable);
      watched.playbackRate = 1;
    }
    watched = v;
    if (v) {
      v.addEventListener("play", onPlay);
      v.addEventListener("pause", onPause);
      v.addEventListener("seeked", onSeeked);
      v.addEventListener("seeking", onSeeking);
      v.addEventListener("ratechange", onRateChange);
      v.addEventListener("waiting", onWaiting);
      v.addEventListener("playing", onResumeable);
      v.addEventListener("canplaythrough", onResumeable);
    }
  }

  // Spotify has no media events we can trust: poll its transport instead
  let lastPaused = null;
  function pollSpotifyTransport() {
    if (adapter !== spotify || !adapter.ready() || reconciling) return;
    const paused = adapter.isPaused();
    if (lastPaused === null) { lastPaused = paused; return; }
    if (paused !== lastPaused) {
      lastPaused = paused;
      sendCmd(paused ? "pause" : "play");
    }
  }

  function mountUI() {
    if (!ui || ui.root) return;
    ui.mount();
  }

  // The only thing worth interrupting the film for: the room is waiting, and
  // it should be obvious why without looking at the panel.
  function paintStatus() {
    if (!ui || !ui.root || !room) return;
    if (room.countdownAt && room.countdownAt > Date.now()) {
      return ui.countdown(Math.ceil((room.countdownAt - Date.now()) / 1000));
    }
    const waiting = (room.members || []).filter((m) => m.holding || m.arrived === false);
    if (!waiting.length) return ui.hold(null, null, null);

    const names = waiting.map((m) => (m.id === room.meId ? "you" : m.name));
    const why = waiting.some((m) => m.arrived === false)
      ? "still getting there"
      : adapter.isAd() && waiting.some((m) => m.id === room.meId)
        ? "an ad is playing on your side"
        : "their connection is catching up";
    ui.hold("hold on", "waiting for", names.join(" and "), why);
  }

  function connect() {
    port = chrome.runtime.connect({ name: "sync-lis" });
    port.onMessage.addListener((msg) => {
      if (msg.type === "state") {
        state = msg.state;
        content = msg.content;
        offset = msg.offset;
        room = msg.room || null;
        mountUI();
        paintStatus();
        reconcile();
      } else if (msg.type === "react") {
        if (ui) ui.float(msg.emoji);
      } else if (msg.type === "big") {
        if (ui) ui.big(msg.emoji);
      } else if (msg.type === "secret") {
        if (ui) ui.secret(msg.text);
      } else if (msg.type === "sting") {
        if (ui) ui.sting(msg.kind);
      } else if (msg.type === "ended") {
        state = null;
        content = null;
        room = null;
        adapter.setRate(1);
        if (ui) ui.unmount();
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(() => { if (window.__syncLisAgent) connect(); }, 500);
    });
    // announce what we're on the moment we attach
    setTimeout(reportContent, 800);
  }

  let lastNotedAt = null;

  // A window into the agent, published on the panel element because a content
  // script's globals live in an isolated world nothing else can read.
  function publishDebug() {
    if (!ui || !ui.root) return;
    ui.root.dataset.syncLis = JSON.stringify({
      kind: adapter.kind, ready: adapter.ready(), hasPort: !!port, listening: !!watched,
      reconciling, holding, seekAgo: userSeekAt ? Date.now() - userSeekAt : null,
      paused: state && state.paused, time: state && +state.time.toFixed(2),
      counts,
    });
  }

  setInterval(() => {
    attachVideo();
    reportContent();
    pollSpotifyTransport();
    reconcile();
    if (adapter.ready()) tell({ type: "pos", time: adapter.getTime() });

    // Buttons like Prime's "Skip intro" move the player without any event we
    // can tell apart from drift, so an unexplained jump is treated as a seek
    // the person meant. Our own corrections are excluded by `reconciling`.
    if (state && !state.paused && adapter.ready() && !adapter.isAd()) {
      const now = adapter.getTime();
      if (lastObserved !== null && !reconciling && Date.now() - userSeekAt > 1500) {
        const predicted = lastObserved + ((Date.now() - lastObservedAt) / 1000) * roomRate();
        if (Math.abs(now - predicted) > 2) sendCmd("seek");
      }
      lastObserved = now;
      lastObservedAt = Date.now();
    } else {
      lastObserved = null;
    }

    // A player that stalls without firing 'waiting' shouldn't strand the room.
    // This must keep evaluating while the room is PAUSED too: a hold pauses
    // everyone, and if we stopped checking here the hold could never clear and
    // the room would be frozen for good.
    // An ad is a reason to wait, exactly like buffering: the room holds until
    // whoever is watching one comes out the other side.
    if (adapter.isAd()) setHold(true);
    else if (watched && state) {
      if (!watched.paused && watched.readyState < 3) setHold(true);
      else if (watched.readyState >= 3) setHold(false);
    }
    // last resort: a hold never gets to hold the room hostage. Ads get longer
    // rope, since an unskippable one can run half a minute.
    if (holding && Date.now() - holdSince > (adapter.isAd() ? 45000 : 10000)) setHold(false);
  }, 2000);

  // countdown and drift readouts need a faster tick than the sync loop
  setInterval(() => {
    paintStatus();
    publishDebug();
  }, 400);

  // stepped away from the tab: say so, rather than leaving silence unexplained
  document.addEventListener("visibilitychange", () => {
    tell({ type: "away", away: document.hidden });
  });

  connect();
})();


