// One-off: drives the REAL extension (two real browser profiles, same
// pattern as test/e2e.js) on a real YouTube video to capture genuine Chrome
// Web Store screenshots — not mockups. Deleted after use, not part of the
// permanent test suite.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require("playwright");

const EXT = path.join(__dirname, "..", "extension");
const RELAY = "https://localhost:7777";
const OUT = process.argv[2];
const VIDEO_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; // Big Buck Bunny, CC, stable, no ads
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMES = { a: "aish", b: "rohan" };

async function launch(tag) {
  const dir = path.join(os.tmpdir(), `synclis-cws-${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: false,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--ignore-certificate-errors",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
    ],
  });
  // Two separate browser windows cannot both hold OS focus, so one side always
  // reports document.hidden and the room correctly marks it "away". That is an
  // artefact of driving two browsers at once, not how the product behaves for
  // two real people, so pin visibility for the capture.
  await ctx.addInitScript(() => {
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  // sw.js falls back to the literal name "friend" when storage is empty, which
  // reads as a bug in a store screenshot rather than a default
  await sw.evaluate((n) => chrome.storage.local.set({ name: n }), NAMES[tag]);
  return { ctx, sw, dir };
}

async function until(fn, ms = 20000, step = 400) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch {}
    await sleep(step);
  }
  return false;
}

(async () => {
  const A = await launch("a");
  const B = await launch("b");
  try {
    const pageA = await A.ctx.newPage();
    await pageA.goto(VIDEO_URL, { waitUntil: "domcontentloaded" });
    await pageA.waitForSelector("video", { timeout: 20000 }).catch(() => {});
    await sleep(2500);
    // consent dialog, if the region/profile shows one
    for (const text of ["Accept all", "I agree", "Reject all"]) {
      const btn = pageA.getByRole("button", { name: text }).first();
      if (await btn.count()) { await btn.click().catch(() => {}); break; }
    }
    await pageA.evaluate(() => document.querySelector("video")?.play());
    await sleep(1500);

    const tabA = await A.sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.includes("youtube.com/watch"));
      return t ? t.id : null;
    });
    console.log("tabA", tabA);

    const created = await A.sw.evaluate(
      ([tabId, server]) => startSession(tabId, server, "aish", { type: "syncCreate", name: "aish" }),
      [tabA, RELAY]
    );
    console.log("room", created);
    const code = created.code;

    const pageB = await B.ctx.newPage();
    await pageB.goto(`${RELAY}/r/${code}`);
    await until(() => pageB.url().includes("youtube.com"), 25000);
    await pageB.waitForSelector("video", { timeout: 20000 }).catch(() => {});
    for (const text of ["Accept all", "I agree", "Reject all"]) {
      const btn = pageB.getByRole("button", { name: text }).first();
      if (await btn.count()) { await btn.click().catch(() => {}); break; }
    }
    await sleep(2000);

    // expand the panel and drop a couple of chat lines on both sides so the
    // screenshot shows the feature, not an empty shell
    for (const [page, name, msg] of [
      [pageA, "aish", "ok this part is so good"],
      [pageB, "rohan", "wait for it.."],
      [pageA, "aish", "HAHA"],
    ]) {
      await until(() => page.evaluate(() => !!document.getElementById("sync-lis-root")), 15000);
      await page.bringToFront();
      await sleep(400);
      await page.evaluate(({ msg }) => {
        const sh = document.getElementById("sync-lis-root").shadowRoot;
        sh.querySelector(".panel")?.classList.remove("hidden2");
        sh.querySelector(".tab")?.classList.add("hidden2");
        const input = sh.querySelector("#slMsg");
        if (input) {
          input.value = msg;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          sh.querySelector("#slSend")?.click();
        }
      }, { msg });
      await sleep(900);
    }
    await sleep(1000);

    fs.mkdirSync(OUT, { recursive: true });
    // each side must be the focused tab at the instant it is captured, or the
    // room correctly reports it "away" and the screenshot looks broken
    await pageB.bringToFront();
    await sleep(1200);
    await pageB.screenshot({ path: path.join(OUT, "screenshot-2-other-side.png") });
    await pageA.bringToFront();
    await sleep(1200);
    await pageA.screenshot({ path: path.join(OUT, "screenshot-1-together.png") });
    console.log("screenshots written to", OUT);
  } catch (e) {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  } finally {
    await A.ctx.close().catch(() => {});
    await B.ctx.close().catch(() => {});
    fs.rmSync(A.dir, { recursive: true, force: true });
    fs.rmSync(B.dir, { recursive: true, force: true });
  }
})();
