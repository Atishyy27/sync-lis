// Does a room survive being BORING?
//
// A room that sits quiet -- paused film, nobody chatting -- is the state the
// rest of the suite never reaches, because every other test is busy. This one
// deliberately does nothing for over a minute and then checks the room is
// still there and still syncing.
//
// WHAT THIS TEST DOES *NOT* PROVE, despite appearances:
//
// It does not prove the 20s heartbeat in sw.js is load-bearing. It was written
// to test the theory that Chrome terminates an MV3 service worker after 30s of
// inactivity, taking the relay socket with it. Measured honestly, that theory
// is UNCONFIRMED here:
//
//   heartbeat ON,  polling every 10s -> passes
//   heartbeat OFF, polling every 10s -> passes  (polling was the flaw: each
//                  sw.evaluate() is an extension API call and resets the very
//                  idle timer under test -- observing the bug prevented it)
//   heartbeat ON,  no polling at all  -> passes
//   heartbeat OFF, no polling at all  -> ALSO PASSES
//
// That last line is the important one. The most likely explanation is that
// Playwright attaches to the service worker over the DevTools protocol, and an
// attached debugger keeps it alive -- meaning this failure mode may be
// untestable in this harness by construction, not merely unobserved.
//
// So: keep this test for what it genuinely covers (a room survives a long
// quiet period end to end, and still syncs afterwards), and do NOT read a pass
// here as evidence that the idle-termination bug is fixed. If someone claims
// that again, make them produce a run where this test FAILS with the heartbeat
// removed. Nobody has yet.
//
// Usage: node test/idle-soak.js [--headed] [--idle 130]

const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const EXT = path.join(__dirname, "..", "extension");
const FIXTURE = path.join(__dirname, "fixture");
const RELAY = process.env.SYNC_TEST_RELAY || "https://localhost:7777";
const HEADED = process.argv.includes("--headed");
const idleArg = process.argv.indexOf("--idle");
// well past the 30s termination window, and long enough that several
// heartbeats must have fired for the session to still be alive
const IDLE_S = idleArg > -1 ? Number(process.argv[idleArg + 1]) : 130;
const PORT = 8904;

const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c || !extra ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function launch(tag) {
  const dir = path.join(os.tmpdir(), `synclis-soak-${tag}-${process.pid}`);
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
  return { ctx, sw, dir };
}

// asking the service worker about itself: if it was terminated and respawned,
// the sessions map is empty, which is precisely the failure being hunted
const sessionOf = (sw) => sw.evaluate(() => {
  const s = [...sessions.values()][0];
  if (!s) return { alive: false };
  return {
    alive: true,
    code: s.code,
    ws: s.ws.readyState,
    beating: !!s.beat,
    members: (s.members || []).length,
    offset: typeof s.offset === "number",
  };
}).catch((e) => ({ alive: false, err: e.message }));

(async () => {
  const fixtureServer = await serveFixture();
  const A = await launch("a");
  const B = await launch("b");
  try {
    const pageA = await A.ctx.newPage();
    await pageA.goto(`http://127.0.0.1:${PORT}/page.html`);
    await pageA.waitForSelector("video");

    const tabA = await A.sw.evaluate(async (u) => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.includes(u));
      return t ? t.id : null;
    }, `127.0.0.1:${PORT}`);

    const created = await A.sw.evaluate(
      ([tid, server]) => startSession(tid, server, "host", { type: "syncCreate", name: "host" }),
      [tabA, RELAY]
    );
    check("room created", !!created && !!created.code, JSON.stringify(created));
    const code = created.code;

    const pageB = await B.ctx.newPage();
    await pageB.goto(`${RELAY}/r/${code}`);
    let followed = false;
    for (let i = 0; i < 50; i++) {
      followed = pageB.url().includes(`127.0.0.1:${PORT}`) && !!(await pageB.$("video"));
      if (followed) break;
      await sleep(500);
    }
    check("second browser joined and followed the content", followed, pageB.url());

    const before = await sessionOf(A.sw);
    check("host session is live before going idle", before.alive && before.ws === 1, JSON.stringify(before));
    check("the heartbeat interval is actually armed", before.beating === true, JSON.stringify(before));

    // ---- do absolutely nothing, on purpose ----
    // no playing, no chat, no seeking. This is the state the old build died in.
    // NOTHING may touch the service worker during this window. An earlier
    // version of this test polled sessionOf() every 10s and always passed,
    // even with the heartbeat deliberately disabled -- because sw.evaluate()
    // is itself an extension API call and resets the very idle timer being
    // measured. Observing the bug prevented it. So: one uninterrupted sleep,
    // then a single observation at the end.
    console.log(`sitting idle for ${IDLE_S}s, touching nothing (SW terminates at 30s without traffic)...`);
    await sleep(IDLE_S * 1000);

    const after = await sessionOf(A.sw);
    check(`host session still alive after ${IDLE_S}s of silence`, after.alive, JSON.stringify(after));
    check("its relay socket is still open, not reconnecting", after.ws === 1, "readyState=" + after.ws);
    check("it kept the same room, rather than silently rejoining a new one",
      after.code === code, `${code} -> ${after.code}`);

    const afterB = await sessionOf(B.sw);
    check("the joiner's session survived the same silence", afterB.alive && afterB.ws === 1, JSON.stringify(afterB));

    // ---- and does it still actually WORK, not just look connected? ----
    await pageA.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 5; v.play(); });
    let synced = false;
    let seen = null;
    for (let i = 0; i < 30; i++) {
      seen = await pageB.evaluate(() => {
        const v = document.querySelector("video");
        return v ? { t: +v.currentTime.toFixed(2), paused: v.paused } : null;
      });
      if (seen && !seen.paused && seen.t > 3) { synced = true; break; }
      await sleep(500);
    }
    check("play after the idle period still reaches the other side", synced, JSON.stringify(seen));

    // the room link page must still report the room as live
    // the dev server is self-signed, which node's fetch refuses outright; the
    // browsers above are already launched with --ignore-certificate-errors
    const html = await new Promise((res) => {
      const u = new URL(`${RELAY}/r/${code}`);
      const mod = u.protocol === "https:" ? require("https") : require("http");
      const req = mod.get(
        { hostname: u.hostname, port: u.port, path: u.pathname, rejectUnauthorized: false },
        (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(b)); }
      );
      req.on("error", () => res(""));
      req.setTimeout(8000, () => { req.destroy(); res(""); });
    });
    check("the room is still live server-side after the idle period",
      html.includes("Room is live"), html ? "page had no live marker" : "request failed");
  } catch (e) {
    check(`unexpected failure: ${e.message}`, false);
  } finally {
    console.log(results.join("\n"));
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    await A.ctx.close().catch(() => {});
    await B.ctx.close().catch(() => {});
    fixtureServer.close();
    fs.rmSync(A.dir, { recursive: true, force: true });
    fs.rmSync(B.dir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
