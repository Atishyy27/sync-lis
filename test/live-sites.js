// Does the real extension recognise real sites?
//
// Logged out, so nothing plays; what this proves is the part that was broken:
// whether the agent can tell WHAT you are on, and whether the room follows.
// Run with the server up.

const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const EXT = path.join(__dirname, "..", "extension");
const RELAY = "https://localhost:7777";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c || !extra ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};

const SITES = [
  {
    name: "spotify track",
    url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    wantKey: "sp:track:4uLU6hMCjMI75M1A2tKUQC",
    wantKind: "spotify",
  },
  {
    name: "spotify playlist",
    url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    wantKey: "sp:playlist:37i9dQZF1DXcBWIGoYBM5M",
    wantKind: "spotify",
  },
  {
    name: "prime detail",
    url: "https://www.primevideo.com/detail/0GHPFTPS7ARTKV1LGY7DDLU6UA/",
    wantKey: "pv:0GHPFTPS7ARTKV1LGY7DDLU6UA",
    wantKind: "prime",
  },
];

(async () => {
  const dir = path.join(os.tmpdir(), `synclis-live-${process.pid}`);
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

  const page = await ctx.newPage();

  try {
    for (const site of SITES) {
      let loaded = true;
      try {
        await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      } catch (e) {
        loaded = false;
        check(`${site.name}: page loaded`, false, e.message.split("\n")[0].slice(0, 60));
      }
      if (!loaded) continue;
      await page.waitForTimeout(7000);

      // what does the agent make of this page? (inject it standalone; no room
      // needed to answer "which adapter, which key")
      await ctx.pages()[0]; // keep the context awake
      const tabId = await sw.evaluate(async (u) => {
        const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.includes(u));
        return t ? t.id : null;
      }, new URL(site.url).hostname);

      const seen = await sw.evaluate(async (id) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: id },
          world: "MAIN",
          func: () => {
            const el = document.getElementById("sync-lis-probe");
            return el ? el.textContent : null;
          },
        });
        return r && r.result;
      }, tabId).catch(() => null);

      // read the adapter's own view through the isolated-world agent
      await sw.evaluate(async (id) => {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ["ui.js", "content.js"] });
      }, tabId);
      await page.waitForTimeout(2500);

      const dbg = await page.evaluate(() => {
        const r = document.getElementById("sync-lis-root");
        return r ? r.dataset.syncLis : null;
      });

      const probe = await sw.evaluate(async (id) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const a = window.__syncLisAdapterProbe;
            if (!a) return { err: "agent not present" };
            return { kind: a.kind, key: a.key(), url: a.url(), ready: a.ready(), title: (a.title() || "").slice(0, 60) };
          },
        });
        return r && r.result;
      }, tabId);

      console.log(`\n--- ${site.name} ---`);
      console.log(`landed: ${page.url().slice(0, 80)}`);
      console.log(`agent:  ${JSON.stringify(probe)}`);
      if (dbg) console.log(`panel:  ${dbg}`);

      check(`${site.name}: picks the right adapter`, probe && probe.kind === site.wantKind, probe && probe.kind);
      check(`${site.name}: identifies the content`, probe && probe.key === site.wantKey, probe && JSON.stringify(probe.key));
      check(`${site.name}: link is navigable`, !!(probe && /^https?:\/\//.test(probe.url || "")), probe && probe.url);
      // followable = will actually be announced to the room. Without this the
      // other person never gets pulled to what you opened.
      check(`${site.name}: reports itself as followable`, probe && probe.ready === true,
        "ready() false means nobody follows you here");
    }
  } finally {
    console.log("\n" + results.join("\n"));
    await ctx.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
