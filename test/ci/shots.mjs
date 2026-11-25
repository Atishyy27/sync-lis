// Screenshots for the review, in GitHub Actions only. Run twice with the same
// scenario: `node shots.mjs before` against master's extension and relay code
// (EXT_DIR and SYNCLIS_WORKER_DIR point at a copy of master), `node shots.mjs after`
// against this branch. Each scenario at 1280 px and 360 px wide.
//   1. the invite page a friend sees after everyone in the room dropped
//   2. the on-page panel two seconds after the host's connection dropped
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import WebSocket from "ws";
import { startMockRelay } from "../mock/relay-server.mjs";
import { startFixture, launchExt, tabIdFor, createRoom, expandPanel, until, sleep, ROOT } from "./lib.mjs";

const label = process.argv[2] || "after";
const out = process.env.SHOTS_DIR || path.join(ROOT, "test", "ci", "out");
fs.mkdirSync(out, { recursive: true });
const SIZES = { desktop: { width: 1280, height: 720 }, 360: { width: 360, height: 640 } };

const relay = await startMockRelay();
const fixture = await startFixture();
const browser = await chromium.launch();
let ext;
try {
  // 1. a room whose only member dropped, then someone opens the link
  const code = await new Promise((resolve, reject) => {
    const ws = new WebSocket(relay.url.replace("http", "ws"));
    ws.on("open", () => ws.send(JSON.stringify({ type: "syncCreate", name: "host" })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "syncJoined") { ws.close(); setTimeout(() => resolve(m.code), 300); }
    });
    ws.on("error", reject);
  });
  for (const [size, viewport] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${relay.url}/r/${code}`);
    await page.screenshot({ path: path.join(out, `invite-after-everyone-dropped-${label}-${size}.png`) });
    await page.close();
  }

  // 2. the panel while the connection is down
  ext = await launchExt("shots");
  const page = await ext.ctx.newPage();
  await page.goto(`${fixture.origin}/page.html`);
  await page.waitForSelector("audio");
  const tab = await tabIdFor(ext.sw, fixture.origin);
  await createRoom(ext.sw, tab, relay.url, "host");
  await until(() => page.evaluate(() => !!document.getElementById("sync-lis-root")));
  await expandPanel(page);
  await sleep(600);
  relay.ctl.refusing = true;
  relay.dropAll();
  await sleep(2200);   // master has already given up by now; this branch is still trying
  for (const [size, viewport] of Object.entries(SIZES)) {
    await page.setViewportSize(viewport);
    await sleep(400);
    await page.screenshot({ path: path.join(out, `panel-while-reconnecting-${label}-${size}.png`) });
  }
  relay.ctl.refusing = false;
} finally {
  await ext?.ctx.close().catch(() => {});
  await browser.close();
  await relay.close();
  await fixture.close();
}
console.log("shots written to", out, fs.readdirSync(out).filter((f) => f.includes(`-${label}-`)));
process.exit(0);
