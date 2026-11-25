// Browser end to end, in GitHub Actions only: real Chromium with the unpacked
// extension loaded, talking to the mock relay (the real worker code on a fake
// Durable Object runtime) on 127.0.0.1. No network, no wrangler.
//
// Product-team flows: host starts a room, friend clicks the link and lands on
// the same track, play and pause carry over. Changed flows: reconnect after a
// drop, a held empty room, a reddit-shaped page. QA: 360 px invite page.
import { chromium } from "playwright";
import { startMockRelay } from "../mock/relay-server.mjs";
import { startFixture, launchExt, tabIdFor, sessionOf, panelLines, createRoom, until, sleep } from "./lib.mjs";

const results = [];
const check = (name, ok, extra = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  <-- ${extra}`}`);
  console.log(results.at(-1));
  if (!ok) process.exitCode = 1;
};

const relay = await startMockRelay();
const fixture = await startFixture();
const A = await launchExt("host");
const B = await launchExt("guest");
let plain;
console.log("two browsers up with the extension loaded; relay", relay.url, "fixture", fixture.origin);

try {
  // ---- host: open a track, start a room ----
  const pageA = await A.ctx.newPage();
  await pageA.goto(`${fixture.origin}/page.html`);
  await pageA.waitForSelector("audio");
  const tabA = await tabIdFor(A.sw, fixture.origin);
  const created = await createRoom(A.sw, tabA, relay.url, "host");
  check("room created from a real browser", !!created && /^[A-Z0-9]{5}$/.test(created.code || ""), JSON.stringify(created));
  const code = created.code;
  check("panel injected on the host page", await until(() => pageA.evaluate(() => !!document.getElementById("sync-lis-root"))));

  // ---- friend: click the invite link (served by the relay, not the default host) ----
  const pageB = await B.ctx.newPage();
  await pageB.goto(`${relay.url}/r/${code}`);
  check("the friend's tab lands on the host's track", await until(() => pageB.url().startsWith(`${fixture.origin}/page.html`) && pageB.$("audio"), 25000), pageB.url());
  check("panel injected on the friend's page", await until(() => pageB.evaluate(() => !!document.getElementById("sync-lis-root"))));
  check("two people in the room", await until(async () => (await sessionOf(A.sw, tabA))?.members === 2));

  // ---- transport ----
  await pageA.evaluate(() => document.querySelector("audio").play());
  check("host plays, the friend's player plays", await until(() => pageB.evaluate(() => !document.querySelector("audio").paused), 12000));
  await pageA.evaluate(() => document.querySelector("audio").pause());
  check("host pauses, the friend's player pauses", await until(() => pageB.evaluate(() => document.querySelector("audio").paused), 12000));

  // ---- change 2: the connection drops, the host keeps trying and comes back ----
  relay.ctl.refusing = true;
  relay.dropAll();
  check("panel says it is reconnecting", await until(async () => (await panelLines(pageA) || []).some((l) => /reconnecting/i.test(l)), 8000), JSON.stringify(await panelLines(pageA)));
  await sleep(2500);                      // the first retry (1.5 s) fails against a down relay
  relay.ctl.refusing = false;
  check("host is back in the same room", await until(async () => (await sessionOf(A.sw, tabA))?.code === code && (await sessionOf(A.sw, tabA))?.ws === 1, 25000), JSON.stringify(await sessionOf(A.sw, tabA)));
  check("panel says it is back", await until(async () => (await panelLines(pageA) || []).some((l) => /back in the room/i.test(l)), 8000));
  check("the panel never went away", !!(await panelLines(pageA)));

  // ---- change 3: a page shaped like a room link on another site ----
  const before = fixture.stats.upgrades;
  await pageA.goto(`${fixture.origin}/r/funny`);
  await sleep(2500);
  check("a reddit-shaped page opens no connection to that site", fixture.stats.upgrades === before, `upgrades ${fixture.stats.upgrades - before}`);
  check("and the host is still in the room", (await sessionOf(A.sw, tabA))?.code === code && (await sessionOf(A.sw, tabA))?.ws === 1);

  // ---- change 1: everyone leaves, the room is held, the invite page says so ----
  await pageA.close();
  await pageB.close();
  check("relay has no sockets left", await until(() => relay.liveSockets() === 0, 8000));
  const browser = await chromium.launch();
  plain = browser;
  const invite = await browser.newPage({ viewport: { width: 360, height: 640 } });   // no extension in this browser
  await invite.goto(`${relay.url}/r/${code}`);
  const text = await invite.evaluate(() => document.body.innerText);
  check("invite page of the held room says nobody is inside", /nobody inside right now/i.test(text), text.slice(0, 200));
  check("invite page has no horizontal scroll at 360 px", await invite.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const C = await launchExt("late");
  const pageC = await C.ctx.newPage();
  await pageC.goto(`${relay.url}/r/${code}`);
  check("a late friend still gets into the held room", await until(() => relay.liveSockets() === 1, 15000));
  await C.ctx.close();
} catch (e) {
  console.log("run crashed:", e);
  process.exitCode = 1;
} finally {
  await A.ctx.close().catch(() => {});
  await B.ctx.close().catch(() => {});
  await plain?.close().catch(() => {});
  await relay.close();
  await fixture.close();
}
console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} checks passed`);
process.exit(process.exitCode || 0);
