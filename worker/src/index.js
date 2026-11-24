// sync-lis's relay, ported from server.js's `sync*` WebSocket handling.
//
// One fixed-name Durable Object (`getByName("relay")`) holds every room, the
// same way server.js's single Node process holds one `syncRooms` Map for
// everyone today — so the wire protocol the extension already speaks is
// unchanged. sw.js only needs a different URL, not a different message
// shape. See extension/sw.js's startSession() for the client side.

export { SyncRelay } from "./SyncRelay.js";
import { byeResponse } from "./bye.js";

const ev = (evt, fields = {}) => {
  try { console.log(JSON.stringify({ evt, at: Date.now(), ...fields })); } catch {}
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.SYNC_RELAY.getByName("relay");
    // GET /stats: live activeUsers/activeRooms counts, for a dashboard —
    // routed through the same singleton DO so it reads real connections,
    // not a separate count that could drift from reality.
    if (url.pathname === "/stats") return stub.fetch(request);
    // /r/<code>: the page a share link opens. Same singleton DO, so the page
    // reports the room's real state rather than a guess.
    if (url.pathname.startsWith("/r/")) return stub.fetch(request);
    // /bye: one-tap uninstall reason, see bye.js. Needs no room state.
    if (url.pathname === "/bye") return byeResponse(url, ev);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("sync-lis relay: expects a WebSocket connection (or GET /stats)", { status: 426 });
    }
    return stub.fetch(request);
  },
};
