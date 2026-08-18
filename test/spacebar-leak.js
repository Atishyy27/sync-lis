// Real end-to-end proof for the spacebar-pauses-the-video bug: the earlier
// fix (test/panel-widths.js) proved the mechanism in isolation with a
// synthetic KeyboardEvent against a bare-mounted ui.js. This proves it
// against the REAL extension, loaded in a real Chromium profile, typing
// into the REAL injected panel on a page that reacts to spacebar the same
// way YouTube/Netflix do — because a synthetic test proving the isolated
// mechanism is not the same claim as "it doesn't happen in the product."

const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const EXT = path.join(__dirname, "..", "extension");
const FIXTURE = path.join(__dirname, "fixture");
const RELAY = process.env.SYNC_TEST_RELAY || "https://localhost:7777";
const PORT = 8902;
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
        rq.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream", "Content-Length": st.size });
        fs.createReadStream(f).pipe(rq);
      });
    });
    s.listen(PORT, () => res(s));
  });
}

(async () => {
  const fixtureServer = await serveFixture();
  const dir = path.join(os.tmpdir(), `synclis-spacebar-${process.pid}`);
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
      "--mute-audio",
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });

  try {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/page.html`);
    await page.waitForSelector("video");

    // simulate the real thing this bug is about: the HOST PAGE'S OWN
    // spacebar shortcut, exactly like YouTube's, bound at the document
    await page.evaluate(() => {
      window.__spacePauseCount = 0;
      document.addEventListener("keydown", (e) => {
        if (e.key === " " || e.code === "Space") {
          window.__spacePauseCount++;
          const v = document.querySelector("video");
          if (v) v.paused ? v.play() : v.pause();
        }
      });
    });

    const tabId = await sw.evaluate(async (u) => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.includes(u));
      return t ? t.id : null;
    }, "127.0.0.1:8902");
    check("found the tab from the service worker", !!tabId);

    const created = await sw.evaluate(
      ([tid, server]) => startSession(tid, server, "spacetest", { type: "syncCreate", name: "spacetest" }),
      [tabId, RELAY]
    );
    check("room created", !!created && !created.error, JSON.stringify(created));

    let rootSeen = false;
    for (let i = 0; i < 30; i++) {
      rootSeen = await page.evaluate(() => !!document.getElementById("sync-lis-root"));
      if (rootSeen) break;
      await sleep(500);
    }
    check("panel injected", rootSeen);
    if (!rootSeen) throw new Error("panel never appeared");

    // the room starts paused by default and nobody has pressed play yet
    // (solo — nobody else to sync against) — press it ourselves, same as a
    // real viewer clicking play, so there's an actual "stays playing" claim
    // to test
    await page.evaluate(() => document.querySelector("video").play());
    await sleep(500);

    // expand the panel and focus the composer, exactly as a real user would
    await page.evaluate(() => {
      const sh = document.getElementById("sync-lis-root").shadowRoot;
      sh.querySelector(".panel").classList.remove("hidden2");
      sh.querySelector(".tab").classList.add("hidden2");
      sh.querySelector("#slMsg").focus();
    });
    await sleep(200);

    const before = await page.evaluate(() => document.querySelector("video").paused);
    check("video is playing before typing", before === false, `paused=${before}`);

    // real keystrokes, through the real input, exactly as a user typing a
    // chat message with spaces in it would produce
    await page.keyboard.type("hello there friend", { delay: 20 });
    await sleep(300);

    const after = await page.evaluate(() => ({
      paused: document.querySelector("video").paused,
      spacePauseFired: window.__spacePauseCount,
      composerValue: document.getElementById("sync-lis-root").shadowRoot.querySelector("#slMsg").value,
    }));
    check("the page's own spacebar handler never fired while typing in chat",
      after.spacePauseFired === 0, `fired ${after.spacePauseFired} times`);
    check("video is STILL playing after typing three spaces worth of a chat message",
      after.paused === false, `paused=${after.paused}`);
    check("the typed text actually landed in the composer",
      after.composerValue === "hello there friend", `got "${after.composerValue}"`);
  } catch (e) {
    check(`unexpected failure: ${e.message}`, false);
  } finally {
    console.log(results.join("\n"));
    await ctx.close().catch(() => {});
    fixtureServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
