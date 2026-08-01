// Phase 0 harness: drives the REAL sync-lis extension in two real Chrome
// profiles and proves the product end to end â€” content-following, transport
// sync, the injected panel, chat, and wait-for-me buffering.
//
// Usage: node e2e.js [--headed]

const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const EXT = path.join(__dirname, "..", "extension");
const FIXTURE = path.join(__dirname, "fixture");

// the clip is generated, not committed — ffmpeg is already a dependency
const CLIP = path.join(FIXTURE, "clip.mp4");
if (!fs.existsSync(CLIP)) {
  console.log("generating the test clip…");
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=60",
    "-f", "lavfi", "-i", "sine=frequency=200:duration=60",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", CLIP,
  ], { stdio: "ignore" });
}
const RELAY = process.env.SYNC_TEST_RELAY || "https://localhost:7777";
const HEADED = process.argv.includes("--headed");
const PORT = 8899;

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a harness that can't explain a failure just moves the guesswork elsewhere
let diag = async () => "";
const check = async (n, c) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}`);
  if (!c) { process.exitCode = 1; results.push(`        ${await diag()}`); }
};

// wait until fn() is truthy, or give up
async function until(fn, ms = 15000, step = 400) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch {}
    await sleep(step);
  }
  return false;
}

// Range support is mandatory here: without it Chrome cannot seek an <video>
// and silently resets it to 0, which looks exactly like a sync bug.
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
  const dir = path.join(os.tmpdir(), `synclis-e2e-${tag}-${process.pid}`);
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

// the popup drives the service worker; in tests we drive it directly
async function tabIdFor(sw, urlPart) {
  return sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.includes(u));
    return t ? t.id : null;
  }, urlPart);
}

const videoState = (page) => page.evaluate(() => {
  const v = document.querySelector("video");
  return v ? { t: v.currentTime, paused: v.paused, rate: v.playbackRate } : null;
});

(async () => {
  const fixtureServer = await serveFixture();
  const A = await launch("a");
  const B = await launch("b");
  console.log("two browsers up with the extension loaded");

  try {
    // --- her side: open the video, start a room ---
    const pageA = await A.ctx.newPage();
    await pageA.goto(`http://127.0.0.1:${PORT}/page.html`);
    await pageA.waitForSelector("video");

    const tabA = await tabIdFor(A.sw, "127.0.0.1:8899");
    await check("found her tab from the service worker", !!tabA);

    const sessOf = (sw) => sw.evaluate(() => {
      const s = [...sessions.values()][0];
      return s ? {
        code: s.code, paused: s.state && s.state.paused, t: s.state && +s.state.time.toFixed(2),
        content: s.content && s.content.key, agentKey: s.agentKey, navTo: s.navigatingTo,
        ports: s.ports.size, ws: s.ws.readyState,
        last: s.lastAction && `${s.lastAction.name} ${s.lastAction.action}`,
        members: (s.members || []).map((m) => `${m.name}${m.holding ? "(buffering)" : ""}`),
      } : "NO SESSION";
    }).catch((e) => `sw error: ${e.message}`);

    diag = async () => {
      const [a, b, va, vb] = await Promise.all([
        sessOf(A.sw), sessOf(B.sw), videoState(pageA).catch(() => null), videoState(pageB).catch(() => null),
      ]);
      const agent = (p) => p.evaluate(() => { const r = document.getElementById("sync-lis-root"); return r ? r.dataset.syncLis : "no panel"; }).catch(() => "n/a");
      const [ga, gb] = await Promise.all([agent(pageA), agent(pageB)]);
      return `her: ${JSON.stringify(a)} video=${JSON.stringify(va)}\n` +
             `        her agent: ${JSON.stringify(ga)}\n` +
             `        him: ${JSON.stringify(b)} video=${JSON.stringify(vb)} url=${pageB.url()}\n` +
             `        his agent: ${JSON.stringify(gb)}`;
    };

    const created = await A.sw.evaluate(
      ([tabId, server]) => startSession(tabId, server, "her", { type: "syncCreate", name: "her" }),
      [tabA, RELAY]
    );
    await check("room created from a real browser", !!created && /^[A-Z0-9]{5}$/.test(created.code || ""));
    const code = created.code;

    // the injected panel is the visible proof the agent is alive
    await check("panel injected on her page", await until(() =>
      pageA.evaluate(() => !!document.getElementById("sync-lis-root"))));

    // --- his side: just click the room link ---
    let pageB = await B.ctx.newPage();
    await pageB.goto(`${RELAY}/r/${code}`);

    // the whole promise of the product: his tab lands on her video
    const followed = await until(async () =>
      pageB.url().includes("127.0.0.1:8899") && (await pageB.$("video")) !== null, 25000);
    await check("his tab follows her content automatically", followed);
    await check("panel injected on his page too", await until(() =>
      pageB.evaluate(() => !!document.getElementById("sync-lis-root"))));

    // the real panel — not the synthetic one panel-widths.js drives — must
    // actually show the real room once content.js wires a live connection
    // into it, not just the veil/toast it always had.
    // Note: ui.js's `window.__syncLisUI` lives in the content script's
    // ISOLATED world and is invisible to page.evaluate() (a different global
    // object from the page's own window, even though they share the same
    // DOM) — so expand the panel by editing the shared DOM directly instead
    // of calling into a function page.evaluate() cannot see.
    await pageB.evaluate(() => {
      const sh = document.getElementById("sync-lis-root").shadowRoot;
      sh.querySelector(".panel").classList.remove("hidden2");
      sh.querySelector(".tab").classList.add("hidden2");
    });
    await check("the real panel shows both people once expanded", await until(() =>
      pageB.evaluate(() => {
        const sh = document.getElementById("sync-lis-root").shadowRoot;
        return sh.querySelectorAll(".person").length === 2 && sh.querySelectorAll(".runner").length === 2;
      })));
    await check("and the room code, from the real server", await until(() =>
      pageB.evaluate((c) => {
        const sh = document.getElementById("sync-lis-root").shadowRoot;
        return sh.querySelector("#slPcode").textContent === c;
      }, code)));

    // --- transport: play ---
    await pageA.evaluate(() => document.querySelector("video").play());
    const playing = await until(async () => {
      const b = await videoState(pageB);
      return b && !b.paused;
    }, 20000);
    await check("her play starts his video", playing);

    // Drift is corrected by ±8% rate nudges, so absorbing half a second takes
    // several seconds by design. Assert that they CONVERGE, not that they are
    // already tight at some arbitrary instant.
    await sleep(3000);
    let drift = 999;
    const converged = await until(async () => {
      const [x, y] = [await videoState(pageA), await videoState(pageB)];
      if (!x || !y) return false;
      drift = Math.abs(x.t - y.t);
      return drift < 0.35;
    }, 15000, 500);
    await check(`they converge to under 350ms (settled at ${drift.toFixed(2)}s)`, converged);

    // --- transport: seek ---
    await pageA.evaluate(() => { document.querySelector("video").currentTime = 30; });
    const seeked = await until(async () => {
      const b = await videoState(pageB);
      return b && Math.abs(b.t - 30) < 3;
    }, 20000);
    await check("her seek moves him to the same place", seeked);

    // --- transport: pause ---
    // Settle first. A seek can leave a buffer hold in flight, and pausing an
    // already-paused player emits no event, so the assertion would race.
    await until(async () => {
      const [x, y] = [await videoState(pageA), await videoState(pageB)];
      return x && y && !x.paused && !y.paused;
    }, 15000, 400);
    await pageA.evaluate(() => document.querySelector("video").pause());
    await check("her pause stops his video", await until(async () => {
      const b = await videoState(pageB);
      return b && b.paused;
    }, 15000));

    // --- wait for me: his player stalls, the room holds ---
    await pageA.evaluate(() => document.querySelector("video").play());
    await until(async () => !(await videoState(pageB)).paused, 15000);
    // a real stall keeps stalling, so keep the signal alive while we assert
    const stall = setInterval(() => {
      pageB.evaluate(() => document.querySelector("video").dispatchEvent(new Event("waiting"))).catch(() => {});
    }, 500);
    await check("his buffering pauses her video too", await until(async () => {
      const a = await videoState(pageA);
      return a && a.paused;
    }, 15000));
    // the page itself now shows only what must be seen while watching
    await check("her page shows who the room is waiting for", await until(() =>
      pageA.evaluate(() => {
        const r = document.getElementById("sync-lis-root");
        const v = r && r.shadowRoot.querySelector(".veil");
        return v && v.classList.contains("show") && /waiting for/i.test(v.textContent);
      })));
    clearInterval(stall);

    await pageB.evaluate(() => document.querySelector("video").dispatchEvent(new Event("playing")));
    await check("room resumes by itself once he recovers", await until(async () => {
      const a = await videoState(pageA);
      return a && !a.paused;
    }, 15000));

    // --- reactions still land over the video, where they belong ---
    await A.sw.evaluate(() => {
      const s = [...sessions.values()][0];
      s.ws.send(JSON.stringify({ type: "syncReact", emoji: "🔥" }));
    });
    await check("a reaction floats over his video", await until(() =>
      pageB.evaluate(() => {
        const r = document.getElementById("sync-lis-root");
        return !!(r && r.shadowRoot.querySelector(".float"));
      }), 8000, 200));

  } catch (err) {
    await check(`harness crashed: ${err.message}`, false);
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



