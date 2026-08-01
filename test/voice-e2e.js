// Voice, proven in a simulated environment rather than left as "nobody has
// heard anyone yet". Chromium ships exactly the flags this needs:
// --use-fake-device-for-media-stream feeds a synthetic microphone instead of
// asking for a real one, --use-fake-ui-for-media-stream auto-grants the
// permission prompt neither side would otherwise see. Two real browsers, two
// real RTCPeerConnections, no human required.
//
// It specifically targets the case most likely to fail silently: BOTH people
// turning voice on within the same server-broadcast window. Each side's
// "call everyone already talking" snapshot is taken before the other's flag
// has arrived, so without a fix neither calls the other — voice looks "on"
// for both but connects to nobody.

const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { chromium } = require("playwright");

const EXT = path.join(__dirname, "..", "extension");
const FIXTURE = path.join(__dirname, "fixture");
const RELAY = "https://localhost:7777";
const PORT = 8901;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c || !extra ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};

function serveFixture() {
  const types = { ".html": "text/html", ".mp4": "video/mp4" };
  return new Promise((res) => {
    const s = http.createServer((req, rq) => {
      const f = path.join(FIXTURE, req.url === "/" ? "page.html" : req.url.slice(1).split("?")[0]);
      fs.stat(f, (e, st) => {
        if (e) { rq.writeHead(404); return rq.end(); }
        const type = types[path.extname(f)] || "application/octet-stream";
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
        if (m && (m[1] || m[2])) {
          const start = m[1] ? parseInt(m[1]) : 0;
          const end = m[2] ? Math.min(parseInt(m[2]), st.size - 1) : st.size - 1;
          rq.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
          return fs.createReadStream(f, { start, end }).pipe(rq);
        }
        rq.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": st.size });
        fs.createReadStream(f).pipe(rq);
      });
    });
    s.listen(PORT, () => res(s));
  });
}

async function launch(tag) {
  const dir = path.join(os.tmpdir(), `synclis-voice-${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--ignore-certificate-errors",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--mute-audio",
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  return { ctx, sw, dir };
}

async function voiceStatus(sw) {
  return sw.evaluate(() => toVoice({ type: "status" }));
}

(async () => {
  const fixtureServer = await serveFixture();
  const A = await launch("a"), B = await launch("b");
  console.log("two browsers up, fake mic + auto-granted permission");

  try {
    const pageA = await A.ctx.newPage();
    await pageA.goto(`http://127.0.0.1:${PORT}/page.html`);
    await pageA.waitForSelector("video");
    const tabA = await A.sw.evaluate(async (u) => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.includes(u));
      return t ? t.id : null;
    }, "127.0.0.1:8901");
    const created = await A.sw.evaluate(([tabId, server]) =>
      startSession(tabId, server, "her", { type: "syncCreate", name: "her" }), [tabA, RELAY]);
    check("room created", !!created && /^[A-Z0-9]{5}$/.test(created.code || ""));
    const code = created.code;

    const pageB = await B.ctx.newPage();
    await pageB.goto(`${RELAY}/r/${code}`);
    const followed = await (async () => {
      for (let i = 0; i < 25; i++) {
        if (pageB.url().includes("127.0.0.1:8901") && (await pageB.$("video"))) return true;
        await sleep(500);
      }
      return false;
    })();
    check("second browser followed into the room", followed);

    const tabB = await B.sw.evaluate(async (u) => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.includes(u));
      return t ? t.id : null;
    }, "127.0.0.1:8901");

    // the case that actually matters: both flip voice on together, not staggered
    console.log("enabling voice on both sides simultaneously...");
    const [resA, resB] = await Promise.all([
      A.sw.evaluate((tid) => startVoice(tid), tabA),
      B.sw.evaluate((tid) => startVoice(tid), tabB),
    ]);
    check("voice started with no error on her side", resA && resA.ok === true, JSON.stringify(resA));
    check("voice started with no error on his side", resB && resB.ok === true, JSON.stringify(resB));

    // give WebRTC a real window to negotiate: offer/answer + ICE gathering
    let stA = null, stB = null;
    for (let i = 0; i < 20; i++) {
      stA = await voiceStatus(A.sw);
      stB = await voiceStatus(B.sw);
      const doneA = stA && stA.peers.some((p) => p.state === "connected");
      const doneB = stB && stB.peers.some((p) => p.state === "connected");
      if (doneA && doneB) break;
      await sleep(500);
    }

    console.log("her side:", JSON.stringify(stA));
    console.log("his side:", JSON.stringify(stB));

    check("her mic opened", stA && stA.hasMic === true);
    check("his mic opened", stB && stB.hasMic === true);
    check("she has a peer connection to him", stA && stA.peers.length >= 1, JSON.stringify(stA && stA.peers));
    check("he has a peer connection to her", stB && stB.peers.length >= 1, JSON.stringify(stB && stB.peers));
    check("her connection to him actually reaches 'connected' (proves the simultaneous-click race is fixed)",
      stA && stA.peers.some((p) => p.state === "connected"), JSON.stringify(stA && stA.peers));
    check("his connection to her actually reaches 'connected'",
      stB && stB.peers.some((p) => p.state === "connected"), JSON.stringify(stB && stB.peers));

    // muting is local-only and should not tear anything down
    await A.sw.evaluate(() => toVoice({ type: "mute", muted: true }));
    await sleep(300);
    const stAMuted = await voiceStatus(A.sw);
    check("muting keeps the connection alive", stAMuted && stAMuted.peers.some((p) => p.state === "connected"));

    // leaving voice on one side tears down cleanly without breaking the room
    await B.sw.evaluate((tid) => stopVoice(tid), tabB);
    let stAAfterLeave = null;
    for (let i = 0; i < 16; i++) {
      stAAfterLeave = await voiceStatus(A.sw);
      if (!stAAfterLeave || !stAAfterLeave.peers.some((p) => p.state === "connected")) break;
      await sleep(400);
    }
    console.log("her side after his leave:", JSON.stringify(stAAfterLeave));
    check("the other side's connection closes when someone leaves voice",
      !stAAfterLeave || !stAAfterLeave.peers.some((p) => p.state === "connected"));
  } finally {
    console.log("\n" + results.join("\n"));
    await A.ctx.close().catch(() => {});
    await B.ctx.close().catch(() => {});
    fixtureServer.close();
    fs.rmSync(A.dir, { recursive: true, force: true });
    fs.rmSync(B.dir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
