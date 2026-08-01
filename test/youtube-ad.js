// Regression test: "ad k bad yt video bhi restart hora h from drop 0" — a
// YouTube video restarting from 0 right after an ad ends.
//
// YouTube plays its ads inside the SAME <video> element as the real content
// (content.js's isAd() comment says as much). The instant an ad ends, that
// element is mid-transition back to the resumed position — for a beat,
// isAd() already reads false (the ad-showing class is gone) while
// currentTime is still wherever the ad left it, typically ~0 as the real
// source reloads. A play/seeked event landing in exactly that gap used to
// have sendCmd() broadcast that bogus near-zero position as the room's new
// state — dragging everyone, including the ad-watcher's own video once it
// actually resumed, back to the start.
//
// Runs the REAL content.js source in a vm sandbox (same technique as
// spotify-jitter.js's agentWithVideo) so this exercises the shipped closure,
// not a model of it.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");

const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c || !extra ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function agentWithYouTube() {
  const listeners = {};
  const dom = { pos: 42, paused: false, plays: 0, pauses: 0, seeks: [], adShowing: false, sent: [] };
  const fakeVideo = {
    tagName: "VIDEO",
    duration: 300,
    paused: dom.paused,
    playbackRate: 1,
    readyState: 4,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    removeEventListener() {},
    play() { dom.plays++; dom.paused = false; return Promise.resolve(); },
    pause() { dom.pauses++; dom.paused = true; },
  };
  Object.defineProperty(fakeVideo, "currentTime", {
    get: () => dom.pos,
    set: (t) => { dom.seeks.push(t); dom.pos = t; },
  });
  const firePlayer = { classList: { contains: (c) => c === "ad-showing" && dom.adShowing } };
  let capturedPortMsg = null, capturedTick = null;
  const sandbox = {
    location: { href: "https://www.youtube.com/watch?v=abc123XYZ_-", hostname: "www.youtube.com", pathname: "/watch", search: "?v=abc123XYZ_-" },
    document: {
      title: "Fake Video - YouTube",
      querySelector: (sel) => {
        if (sel.includes("video.html5-main-video")) return fakeVideo;
        if (sel.includes("movie_player")) return firePlayer;
        return null;
      },
      querySelectorAll: (sel) => (sel.includes("video") ? [fakeVideo] : []),
      addEventListener() {}, documentElement: { appendChild() {} },
      createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, appendChild() {} }),
      hidden: false,
    },
    window: {},
    URLSearchParams, URL, Math, Date, JSON, String, Number, Object, Array, RegExp,
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    // real content.js only attaches DOM listeners (attachVideo) from inside
    // this tick — capture it so the test can drive it explicitly, same as
    // spotify-jitter.js's agentWithVideo
    setInterval: (fn, ms) => { if (ms >= 1000) capturedTick = fn; return 1; },
    setTimeout: () => 0, clearTimeout() {},
    chrome: {
      runtime: {
        connect: () => ({
          onMessage: { addListener: (fn) => { capturedPortMsg = fn; } },
          onDisconnect: { addListener() {} },
          postMessage: (msg) => { dom.sent.push(msg); }, // real chrome.runtime.Port takes an object, not a JSON string
        }),
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { timeout: 5000 });
  const pushState = (state, content) => capturedPortMsg({
    type: "state", state, content, offset: 0,
    room: { meId: "me", members: [{ id: "me" }, { id: "them" }] },
  });
  const fire = (name) => (listeners[name] || []).forEach((fn) => fn());
  const tick = () => capturedTick && capturedTick();
  return { dom, fire, pushState, tick };
}

(async () => {
  const content = { key: "yt:abc123XYZ_-", url: "https://www.youtube.com/watch?v=abc123XYZ_-", title: "x" };

  // ---- the actual regression: ad ends, video transiently at ~0, a seeked
  //      event fires in that exact gap — must not broadcast that position ----
  {
    const { dom, fire, pushState, tick } = agentWithYouTube();
    pushState({ paused: false, time: 42, at: Date.now(), rate: 1 }, content);
    tick(); // attaches the DOM listeners (attachVideo), same as the real 2s loop
    dom.adShowing = true;
    fire("play"); // ad starting also fires an event on the shared <video>
    // ad ends: isAd() now reads false, but the element hasn't landed on the
    // resumed position yet — this is the exact window the bug lived in
    dom.adShowing = false;
    dom.pos = 0;
    fire("seeked");
    const badCmd = dom.sent.find((m) => m.type === "cmd" && m.time < 5);
    check("a seeked event right as the ad ends does not broadcast the ad's leftover ~0 position",
      !badCmd, JSON.stringify(dom.sent));
  }

  // ---- the guard must not be permanent: a real seek shortly after settles
  //      and gets through ----
  {
    const { dom, fire, pushState, tick } = agentWithYouTube();
    pushState({ paused: false, time: 42, at: Date.now(), rate: 1 }, content);
    tick();
    dom.adShowing = true;
    fire("play");
    dom.adShowing = false;
    dom.pos = 0;
    fire("seeked"); // swallowed, same as above
    await sleep(1700); // past the settle window
    dom.pos = 88; // the viewer genuinely scrubs forward once real content is back
    fire("seeked");
    const goodCmd = dom.sent.find((m) => m.type === "cmd" && Math.abs(m.time - 88) < 1);
    check("a genuine seek once things have settled still reaches the room", !!goodCmd, JSON.stringify(dom.sent));
  }

  // ---- sanity: events firing WHILE the ad is still showing never send,
  //      exactly as before this fix ----
  {
    const { dom, fire, pushState, tick } = agentWithYouTube();
    pushState({ paused: false, time: 42, at: Date.now(), rate: 1 }, content);
    tick();
    dom.adShowing = true;
    dom.pos = 3;
    fire("play");
    fire("seeked");
    check("nothing is sent while the ad is still actually showing", dom.sent.every((m) => m.type !== "cmd"));
  }

  console.log(results.join("\n"));
  process.exit(process.exitCode || 0);
})();
