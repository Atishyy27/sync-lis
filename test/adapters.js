// Adapter identity check.
//
// The riskiest part of a per-site adapter is the URL pattern: get it wrong and
// the room either follows nobody or follows everybody to the wrong page. These
// run the real key/url logic against real URL shapes, with no browser needed.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");

const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};

// Run the agent inside a fake page so its adapters can be inspected. Only the
// handful of browser things the adapter table touches need to exist.
function agentFor(href, dom = {}) {
  const url = new URL(href);
  const el = (sel) => (dom[sel] === undefined ? null : dom[sel]);
  const sandbox = {
    location: {
      href, hostname: url.hostname, pathname: url.pathname,
      search: url.search, host: url.host,
    },
    document: {
      title: dom.title || "",
      querySelector: (s) => el(s),
      querySelectorAll: () => [],
      addEventListener() {},
      documentElement: { appendChild() {} },
      createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, appendChild() {} }),
    },
    URLSearchParams, URL, Math, Date, JSON, String, Number, Object, Array, RegExp,
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    chrome: { runtime: { connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }) } },
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // expose the adapter the agent picked, without changing production code
  vm.runInContext(SRC + "\n;window.__pick = typeof adapter !== 'undefined' ? adapter : null;", sandbox, { timeout: 5000 });
  return sandbox.__syncLisAdapterProbe || sandbox.window.__pick || null;
}

const CASES = [
  // [what, url, expected kind, expected key]
  ["youtube watch", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "yt:dQw4w9WgXcQ"],
  ["youtube with playlist noise", "https://www.youtube.com/watch?v=abc123XYZ_-&list=RDabc&index=2", "youtube", "yt:abc123XYZ_-"],
  ["youtube shorts", "https://www.youtube.com/shorts/AbCdEf12345", "youtube", "yt:AbCdEf12345"],
  ["youtube music", "https://music.youtube.com/watch?v=kJQP7kiw5Fk", "youtube", "yt:kJQP7kiw5Fk"],
  ["netflix watch", "https://www.netflix.com/watch/81234567?trackId=99", "netflix", "nf:81234567"],
  ["netflix browse (nothing playing)", "https://www.netflix.com/browse", "netflix", null],
  ["spotify track", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "spotify", "sp:track:4uLU6hMCjMI75M1A2tKUQC"],
  ["spotify playlist", "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "spotify", "sp:playlist:37i9dQZF1DXcBWIGoYBM5M"],
  ["spotify intl path", "https://open.spotify.com/intl-de/track/1301WleyT98MSxVHPZCA6M", "spotify", "sp:track:1301WleyT98MSxVHPZCA6M"],
  ["prime detail", "https://www.primevideo.com/detail/0GHPFTPS7ARTKV1LGY7DDLU6UA/", "prime", "pv:0GHPFTPS7ARTKV1LGY7DDLU6UA"],
  ["prime playing asset", "https://www.primevideo.com/detail/0ABC/?gti=amzn1.dv.gti.xyz123", "prime", "pv:g:amzn1.dv.gti.xyz123"],
  ["hotstar show", "https://www.hotstar.com/in/shows/shark-tank-india/1260119731/watch", "hotstar", "hs:1260119731"],
  ["hotstar movie", "https://www.hotstar.com/in/movies/jawan/1260125576", "hotstar", "hs:1260125576"],
  ["apple music song", "https://music.apple.com/us/album/after-hours/1499378108?i=1499378615", "apple", "am:song:1499378615"],
  ["apple music album", "https://music.apple.com/in/album/after-hours/1499378108", "apple", "am:album:1499378108"],
  ["jiosaavn song", "https://www.jiosaavn.com/song/kesariya/RT8zfxpaU2Q", "saavn", "js:song:RT8zfxpaU2Q"],
  ["soundcloud track", "https://soundcloud.com/artist/some-track", "soundcloud", "sc:/artist/some-track"],
  ["soundcloud profile (not a track)", "https://soundcloud.com/artist", "soundcloud", null],
  ["anything else", "https://example.com/video/7", "generic", "https://example.com/video/7"],
];

for (const [label, href, kind, key] of CASES) {
  let a = null, err = null;
  try { a = agentFor(href); } catch (e) { err = e.message; }
  if (!a) { check(label, false, err || "adapter not exposed"); continue; }
  const gotKind = a.kind;
  const gotKey = a.key();
  check(`${label} -> ${kind}`, gotKind === kind, `got ${gotKind}`);
  check(`${label} -> key`, gotKey === key, `got ${JSON.stringify(gotKey)}, wanted ${JSON.stringify(key)}`);
}

// a key must survive the round trip: whatever url() gives, reading it back
// must produce the same key, or people ping-pong between pages forever
for (const [label, href, , key] of CASES) {
  if (!key) continue;
  let a;
  try { a = agentFor(href); } catch { continue; }
  if (!a) continue;
  const dest = a.url();
  let b;
  try { b = agentFor(dest); } catch { continue; }
  if (!b) continue;
  check(`${label} -> url() round trips`, b.key() === key, `${dest} reads back as ${JSON.stringify(b.key())}`);
}

console.log(results.join("\n"));
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
