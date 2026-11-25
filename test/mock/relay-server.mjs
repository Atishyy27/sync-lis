// The relay as a local server: the real worker code (index.js routing and
// SyncRelay.js) behind a Node HTTP + WebSocket server, on a fake Durable
// Object runtime. No network beyond 127.0.0.1, no wrangler.
//
// Faults a test can switch on: refuse upgrades (503), delay upgrades (a slow or
// stalled relay), drop every live socket, wipe all room storage (a relay that
// forgot its rooms).
import http from "node:http";
import { WebSocketServer } from "ws";
import { createRelay, FakeSocket, loadWorkerIndex } from "./do-runtime.mjs";

class WsSocket extends FakeSocket {
  constructor(raw) { super(); this.raw = raw; }
  send(s) { if (this.closed) throw new Error("socket closed"); this.raw.send(s); }
  close() { this.closed = true; try { this.raw.close(); } catch {} }
}

export async function startMockRelay({ port = 0 } = {}) {
  const { relay, state, fireAlarmIfDue } = await createRelay();
  const index = (await loadWorkerIndex()).default;
  const env = { SYNC_RELAY: { getByName: () => ({ fetch: (r) => relay.fetch(r) }) } };
  const wss = new WebSocketServer({ noServer: true });
  const ctl = { refusing: false, upgradeDelayMs: 0, upgrades: 0, refused: 0, errors: [], received: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const server = http.createServer(async (req, res) => {
    try {
      const r = await index.fetch(new Request(`http://${req.headers.host}${req.url}`), env);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(await r.text());
    } catch (e) {
      ctl.errors.push(e);
      res.writeHead(500);
      res.end("mock relay error");
    }
  });

  server.on("upgrade", async (req, socket, head) => {
    ctl.upgrades++;
    if (ctl.upgradeDelayMs) await sleep(ctl.upgradeDelayMs);
    if (ctl.refusing) {
      ctl.refused++;
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (raw) => {
      const sock = new WsSocket(raw);
      state.acceptWebSocket(sock);
      raw.on("message", (data) => {
        const text = data.toString();
        try { ctl.received.push(JSON.parse(text)); } catch {}
        relay.webSocketMessage(sock, text).catch((e) => ctl.errors.push(e));
      });
      raw.on("close", (code, reason) => {
        sock.closed = true;
        relay.webSocketClose(sock, code, reason.toString(), code === 1000).catch((e) => ctl.errors.push(e));
      });
    });
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url, ctl, relay, state, fireAlarmIfDue,
    liveSockets: () => state.getWebSockets().length,
    dropAll() { for (const s of state.getWebSockets()) s.raw.terminate(); },
    wipe() { state.storage.map.clear(); state.storage.alarm = null; relay.cache.clear(); },
    async close() {
      for (const s of state.getWebSockets()) s.raw.terminate();
      await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
    },
  };
}

export const waitFor = async (fn, ms = 3000, step = 10) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
};
