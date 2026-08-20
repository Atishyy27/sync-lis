// Proves the video actually gets quieter when someone talks, and comes back.
//
// The speech DETECTION lives in the offscreen document and is driven by real
// peer audio, which a test cannot make someone say. What this drives instead
// is everything downstream of that verdict: service worker -> content script
// -> the real <video>.volume on a real page. That is the part that can break
// silently (wrong scope, stale volume, ratcheting toward zero on repeat
// ducks), and it is the part a user would feel.
//
// Usage: node test/voice-duck.js [--headed]

const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const EXT = path.join(__dirname, "..", "extension");
const FIXTURE = path.join(__dirname, "fixture");
const RELAY = process.env.SYNC_TEST_RELAY || "https://localhost:7777";
const HEADED = process.argv.includes("--headed");
const PORT = 8903;

const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c || !extra ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Range support is mandatory or Chrome resets the video to 0, which looks
// exactly like a sync bug (learned the hard way elsewhere in this suite).
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
          rq.writeHead(206, {
            "Content-Type": type,
            "Content-Range": `bytes ${start}-${end}/${st.size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
          });
          return fs.createReadStream(f, { start, end }).pipe(rq);
        }
        rq.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": st.size });
        fs.createReadStream(f).pipe(rq);
      });
    });
    s.listen(PORT, () => res(s));
  });
}

const volume = (page) => page.evaluate(() => {
  const v = document.querySelector("video");
  return v ? +v.volume.toFixed(3) : null;
});

// tell the service worker to broadcast the same message the offscreen
// speech detector would, so the real downstream path runs
const setDuck = (sw, on) => sw.evaluate((flag) => {
  const s = [...sessions.values()][0];
  if (!s) return "no session";
  for (const port of s.ports) { try { port.postMessage({ type: "duck", on: flag }); } catch {} }
  return s.ports.size;
}, on);

(async () => {
  const fixtureServer = await serveFixture();
  const dir = path.join(os.tmpdir(), `synclis-duck-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: !HEADED,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--ignore-certificate-errors",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });

  try {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/page.html`);
    await page.waitForSelector("video");

    const tabId = await sw.evaluate(async (u) => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.includes(u));
      return t ? t.id : null;
    }, `127.0.0.1:${PORT}`);
    check("found the tab from the service worker", !!tabId);

    const created = await sw.evaluate(
      ([tid, server]) => startSession(tid, server, "talker", { type: "syncCreate", name: "talker" }),
      [tabId, RELAY]
    );
    check("room created", !!created && !created.error, JSON.stringify(created));

    let panel = false;
    for (let i = 0; i < 30; i++) {
      panel = await page.evaluate(() => !!document.getElementById("sync-lis-root"));
      if (panel) break;
      await sleep(500);
    }
    check("agent injected on the page", panel);
    if (!panel) throw new Error("panel never appeared");

    // the viewer is watching at their own level, not full blast: restoring to
    // 1.0 instead of to this is the obvious bug and the test must catch it
    await page.evaluate(() => { document.querySelector("video").volume = 0.8; });
    const before = await volume(page);
    check("video starts at the viewer's chosen volume", before === 0.8, `volume=${before}`);

    const ports = await setDuck(sw, true);
    check("the agent has a live port to receive the duck", typeof ports === "number" && ports > 0, String(ports));
    await sleep(600);
    const ducked = await volume(page);
    check("video gets quieter while someone is talking", ducked !== null && ducked < before, `${before} -> ${ducked}`);
    check("but is not muted outright, so the film is still audible under the voice",
      ducked > 0, `volume=${ducked}`);

    await setDuck(sw, false);
    await sleep(600);
    const restored = await volume(page);
    check("volume returns to exactly where the viewer had it",
      Math.abs(restored - before) < 0.02, `${before} -> ${ducked} -> ${restored}`);

    // the failure that matters most: duck/restore repeatedly and make sure the
    // level does not ratchet downward each time
    for (let i = 0; i < 4; i++) {
      await setDuck(sw, true);
      await sleep(320);
      await setDuck(sw, false);
      await sleep(320);
    }
    const afterMany = await volume(page);
    check("four duck cycles do not ratchet the volume down",
      Math.abs(afterMany - before) < 0.02, `${before} -> ${afterMany}`);

    // the viewer turning it down mid-call must survive the next duck
    await page.evaluate(() => { document.querySelector("video").volume = 0.3; });
    await setDuck(sw, true);
    await sleep(400);
    await setDuck(sw, false);
    await sleep(600);
    const afterUserChange = await volume(page);
    check("a volume the viewer set during the call is respected, not overwritten",
      Math.abs(afterUserChange - 0.3) < 0.05, `expected ~0.3, got ${afterUserChange}`);
  } catch (e) {
    check(`unexpected failure: ${e.message}`, false);
  } finally {
    console.log(results.join("\n"));
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    await ctx.close().catch(() => {});
    fixtureServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
