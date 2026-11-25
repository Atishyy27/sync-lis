// Shared pieces for the browser runs that execute in GitHub Actions only
// (.github/workflows/review-e2e.yml). Never run these locally.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright";

export const ROOT = path.join(import.meta.dirname, "..", "..");
export const EXT = process.env.EXT_DIR || path.join(ROOT, "extension");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 15000, step = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch {}
    await sleep(step);
  }
  return false;
}

// 60 s of a 440 Hz tone as an 8 kHz 8-bit WAV, generated so nothing binary is committed
function wav() {
  const rate = 8000, secs = 60, n = rate * secs;
  const b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write("data", 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return b;
}

// A stand-in for "some site": an audio page, and a /r/funny page like reddit's.
// It counts WebSocket upgrade attempts, so a test can tell whether the
// extension tried to open a connection to a site that is not a relay.
export async function startFixture() {
  const tone = wav();
  const stats = { upgrades: 0 };
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/tone.wav") {
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
      if (m && (m[1] || m[2])) {
        const start = m[1] ? parseInt(m[1]) : 0;
        const end = m[2] ? Math.min(parseInt(m[2]), tone.length - 1) : tone.length - 1;
        res.writeHead(206, { "Content-Type": "audio/wav", "Content-Range": `bytes ${start}-${end}/${tone.length}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
        return res.end(tone.subarray(start, end + 1));
      }
      res.writeHead(200, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": tone.length });
      return res.end(tone);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    if (url === "/page.html") return res.end(`<!doctype html><title>fixture tone</title><body style="margin:0;background:#111;color:#ddd;font:16px sans-serif"><p style="padding:16px">a track</p><audio id="a" src="/tone.wav" controls loop></audio></body>`);
    res.end(`<!doctype html><title>${url}</title><body style="background:#fff">a page that is not a room link: ${url}</body>`);
  });
  server.on("upgrade", (req, socket) => { stats.upgrades++; socket.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { stats, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

export async function launchExt(tag) {
  const dir = path.join(os.tmpdir(), `synclis-ci-${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  return { ctx, sw };
}

export const tabIdFor = (sw, urlPart) => sw.evaluate(async (u) => {
  const tabs = await chrome.tabs.query({});
  const t = tabs.find((x) => x.url && x.url.includes(u));
  return t ? t.id : null;
}, urlPart);

export const sessionOf = (sw, tabId) => sw.evaluate((id) => {
  const s = sessions.get(id);
  return s ? { code: s.code, ws: s.ws.readyState, members: (s.members || []).length } : null;
}, tabId);

// the panel's activity lines (shadow DOM is open, so evaluate can read it)
export const panelLines = (page) => page.evaluate(() => {
  const r = document.getElementById("sync-lis-root");
  return r ? [...r.shadowRoot.querySelectorAll("#slStream .did")].map((d) => d.textContent) : null;
});

export const expandPanel = (page) => page.evaluate(() => {
  const sh = document.getElementById("sync-lis-root").shadowRoot;
  sh.querySelector(".panel").classList.remove("hidden2");
  sh.querySelector(".tab").classList.add("hidden2");
});

export const createRoom = (sw, tabId, server, name) =>
  sw.evaluate(([t, s, n]) => startSession(t, s, n, { type: "syncCreate", name: n }), [tabId, server, name]);
