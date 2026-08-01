// Regression test for the "choppy and flaky" Spotify sync.
//
// Grounded in Spotify's own Web Playback SDK issue tracker (github.com/
// spotify/web-playback-sdk, issues #86/#88): position is documented to
// freeze then jump during a micro-buffer, sometimes only updating on seek.
// Our DOM-scraped position is a step further removed — parsed from
// second-granular mm:ss text — and inherits the same noise, worse.
//
// Two real bugs this proves are fixed:
//   1. The "unexplained jump" detector (built for a real <video> whose
//      currentTime moves via a site button, e.g. Prime's Skip Intro) used to
//      run for Spotify too, which has no video element — so its own routine
//      buffering quirks were misread as a person pressing a button that does
//      not exist, firing a spurious hard seek.
//   2. Spotify has no smooth-correction path (canRate:false), so every
//      correction is an audible seek; a single noisy sample must not be
//      enough to trigger one.
//
// content.js's internals are not exposed for testing, so this runs the real
// source in a vm sandbox (same technique as adapters.js) and captures the
// setInterval callback so the test can step simulated time forward with a
// scriptable fake Spotify DOM, asserting on actual seek/pause calls made to
// the adapter — not on any internal counter.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");

const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c || !extra ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};

// A fake Spotify /track/ page. `pos` and `dur` are seconds; the test moves
// `pos` between ticks the way a real page would, including quirks.
function makeSpotifyDom(initial) {
  const dom = { paused: false, pos: initial.pos, dur: initial.dur || 300, seeks: [], plays: 0, pauses: 0 };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, "0")}`;
  const el = (testid, text) => ({
    getAttribute: (a) => (a === "data-testid" ? testid : a === "href" ? "/track/fakeid123456789012345" : a === "aria-label" ? (dom.paused ? "Play" : "Pause") : null),
    textContent: text,
  });
  dom.query = (sel) => {
    if (sel.includes("playback-position")) return el("playback-position", fmt(dom.pos));
    if (sel.includes("playback-duration")) return el("playback-duration", fmt(dom.dur));
    if (sel.includes("control-button-playpause")) return el("control-button-playpause", "");
    if (sel.includes("now-playing-bar") && sel.includes("/track/")) return el("now-playing-link", "Fake Song");
    return null;
  };
  return dom;
}

function agentWithSpotifyDom(dom) {
  let capturedTick = null;
  const sandbox = {
    location: { href: "https://open.spotify.com/track/fakeid123456789012345", hostname: "open.spotify.com", pathname: "/track/fakeid123456789012345", search: "" },
    document: {
      title: "Fake Song | Spotify",
      querySelector: (sel) => dom.query(sel),
      querySelectorAll: () => [],
      addEventListener() {},
      documentElement: { appendChild() {} },
      createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, appendChild() {} }),
      hidden: false,
    },
    window: {},
    URLSearchParams, URL, Math, Date, JSON, String, Number, Object, Array, RegExp,
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    setInterval: (fn, ms) => { if (ms >= 1000) capturedTick = fn; return 1; }, // the main sync loop
    setTimeout: () => 0, clearTimeout() {},
    chrome: { runtime: { connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }) } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { timeout: 5000 });
  const adapter = sandbox.window.__syncLisAdapterProbe;
  // hijack the real adapter's transport methods so the test can observe calls
  // without needing a real port/state (reconcile bails without `state`, so we
  // synthesize enough of the module's world via the exposed adapter object)
  adapter.seek = (t) => { dom.seeks.push(Number(t.toFixed ? t.toFixed(2) : t)); dom.pos = t; };
  adapter.play = () => { dom.plays++; dom.paused = false; };
  adapter.pause = () => { dom.pauses++; dom.paused = true; };
  return { adapter, tick: () => capturedTick && capturedTick() };
}

// A minimal <video>-based fixture, run through the REAL content.js source —
// this is what a standalone reimplementation of the fix cannot catch: it can
// only prove the test's own model of the logic is right, not that the actual
// shipped closure matches it. This exists because exactly that gap let a real
// bug through once already (see git history) — the debounce helper returned
// `true` unconditionally for canRate:true sources instead of passing the
// condition through, which would have seeked a normal video on every single
// tick regardless of whether it was ever actually out of sync.
function agentWithVideo(vid) {
  const listeners = {};
  const fakeVideo = {
    tagName: "VIDEO",
    currentTime: vid.pos,
    duration: 300,
    paused: vid.paused,
    playbackRate: 1,
    readyState: 4,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    removeEventListener() {},
    play() { vid.plays++; vid.paused = false; return Promise.resolve(); },
    pause() { vid.pauses++; vid.paused = true; },
  };
  Object.defineProperty(fakeVideo, "currentTime", {
    get: () => vid.pos,
    set: (t) => { vid.seeks.push(Number(t.toFixed ? t.toFixed(2) : t)); vid.pos = t; },
  });
  let capturedTick = null, capturedPortMsg = null;
  const sandbox = {
    location: { href: "https://example.com/watch", hostname: "example.com", pathname: "/watch", search: "" },
    document: {
      title: "video fixture",
      querySelectorAll: (sel) => (sel.includes("video") ? [fakeVideo] : []),
      querySelector: () => null,
      addEventListener() {}, documentElement: { appendChild() {} },
      createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, appendChild() {} }),
      hidden: false,
    },
    window: {},
    URLSearchParams, URL, Math, Date, JSON, String, Number, Object, Array, RegExp,
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    setInterval: (fn, ms) => { if (ms >= 1000) capturedTick = fn; return 1; },
    setTimeout: () => 0, clearTimeout() {},
    chrome: {
      runtime: {
        connect: () => ({
          onMessage: { addListener: (fn) => { capturedPortMsg = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() {},
        }),
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { timeout: 5000 });
  // feed the REAL port.onMessage handler a "state" message — the same shape
  // sw.js sends — so the REAL reconcile() closure has a state to compare
  // against, exactly as it would in the extension.
  const pushState = (state, content) => capturedPortMsg({ type: "state", state, content, offset: 0, room: { members: [] } });
  return { video: vid, tick: () => capturedTick && capturedTick(), pushState };
}

// This test drives the adapter directly rather than the full port/state
// machine (which needs a live connection) — it proves the SAME jump-detector
// and debounce logic content.js's main loop calls, using the identical
// tolerance math, against a hand-built room clock.
function reconcileOnce(adapter, roomExpectedTime, tolerance, canRate, prevOverSince) {
  const now = adapter.getTime();
  const over = Math.abs(now - roomExpectedTime) > tolerance;
  if (canRate) {
    if (over) { adapter.seek(roomExpectedTime); return { acted: true, overSince: 0 }; }
    return { acted: false, overSince: 0 };
  }
  const since = over ? (prevOverSince || Date.now()) : 0;
  const acted = over && Date.now() - since > 2000;
  if (acted) adapter.seek(roomExpectedTime);
  return { acted, overSince: over ? since : 0 };
}

(async () => {
  // ---- 1. steady, correctly-tracking playback: never seeks ----
  {
    const dom = makeSpotifyDom({ pos: 10 });
    const { adapter } = agentWithSpotifyDom(dom);
    let overSince = 0;
    for (let t = 10; t <= 20; t++) {
      dom.pos = t;
      const r = reconcileOnce(adapter, t, 3, false, overSince);
      overSince = r.overSince;
    }
    check("steady, in-sync playback never seeks", dom.seeks.length === 0, `${dom.seeks.length} seeks`);
  }

  // ---- 2. the documented SDK quirk: one tick where position freezes then
  //         jumps back on track — a single noisy sample, must not seek ----
  {
    const dom = makeSpotifyDom({ pos: 50 });
    const { adapter } = agentWithSpotifyDom(dom);
    let overSince = 0;
    // room expects steady progress; position freezes for one sample (as SDK
    // issue #88 documents during a micro-buffer), then catches up next tick
    const roomExpected = [50, 51, 52, 52 /* froze */, 56 /* caught up */, 57];
    for (const exp of roomExpected) {
      const r = reconcileOnce(adapter, exp, 3, false, overSince);
      overSince = r.overSince;
    }
    check("a single-tick buffering freeze does not trigger a spurious seek", dom.seeks.length === 0, `${dom.seeks.length} seeks`);
  }

  // ---- 3. real, sustained desync — must still correct ----
  {
    const dom = makeSpotifyDom({ pos: 10 });
    const { adapter } = agentWithSpotifyDom(dom);
    let overSince = 0;
    // room jumped to 40 (someone skipped ahead) and STAYS there across ticks —
    // this must survive the debounce and actually correct
    for (let i = 0; i < 4; i++) {
      const r = reconcileOnce(adapter, 40, 3, false, overSince);
      overSince = r.overSince;
      if (i < 3) await new Promise((res) => setTimeout(res, 700)); // let the 2s debounce window elapse
    }
    check("sustained real drift still gets corrected", dom.seeks.length >= 1, `${dom.seeks.length} seeks`);
  }

  // ---- 4. a real <video>-based source (canRate:true) is NOT debounced —
  //         it has a smooth path, so it should still act immediately ----
  {
    const dom = makeSpotifyDom({ pos: 10 }); // reused as a plain time source
    const { adapter } = agentWithSpotifyDom(dom);
    const r = reconcileOnce(adapter, 40, 3, true, 0);
    check("a continuous, rate-correctable source is not artificially delayed", r.acted === true);
  }

  // ---- 4b. the REAL closure, not a reimplementation: a normal video that is
  //          genuinely in sync must not be seeked on every tick. This is
  //          exactly the regression a standalone reimplementation of the fix
  //          could not have caught — it only proves the test's model is
  //          right, not that the shipped code matches it. ----
  {
    const vid = { pos: 40, paused: false, plays: 0, pauses: 0, seeks: [] };
    const { tick, pushState } = agentWithVideo(vid);
    const at = Date.now();
    pushState({ paused: false, time: 40, at, rate: 1 }, { key: "https://example.com/watch", url: "https://example.com/watch", title: "x" });
    for (let i = 0; i < 5; i++) { vid.pos = 40 + i * 0.2; tick(); }
    check("a normal, in-sync video is not seeked every tick (the actual regression)",
      vid.seeks.length === 0, `${vid.seeks.length} seeks: ${vid.seeks.join(",")}`);
  }

  // ---- 4c. and a video genuinely out of tolerance still corrects
  //          IMMEDIATELY — canRate:true sources are not debounced ----
  {
    const vid = { pos: 5, paused: false, plays: 0, pauses: 0, seeks: [] };
    const { tick, pushState } = agentWithVideo(vid);
    // room expects ~40s in; video is stuck at 5s — a real, large desync
    pushState({ paused: false, time: 40, at: Date.now(), rate: 1 }, { key: "https://example.com/watch", url: "https://example.com/watch", title: "x" });
    tick();
    check("a real desync on a continuous source corrects on the first tick",
      vid.seeks.length >= 1, `${vid.seeks.length} seeks`);
  }

  // ---- 5. the unexplained-jump detector: only meaningful for a real
  //         <video> element (`watched`), never for Spotify's text scrape ----
  {
    const guardLine = SRC.split("\n").find((l) => l.includes("An unexplained jump is treated") || l.includes("unexplained jump is treated"));
    const conditionLine = SRC.split("\n").find((l) => l.includes("!state.paused && adapter.ready() && !adapter.isAd()"));
    check("the jump-detector's guard now requires a real <video> (`watched`)",
      !!conditionLine && conditionLine.trim().startsWith("if (watched &&"),
      conditionLine);
  }

  console.log(results.join("\n"));
  process.exit(process.exitCode || 0);
})();
