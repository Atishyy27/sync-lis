// sync-lis's relay, ported from server.js's `sync*` WebSocket handling.
//
// One fixed-name Durable Object (`getByName("relay")`) holds every room, the
// same way server.js's single Node process holds one `syncRooms` Map for
// everyone today — so the wire protocol the extension already speaks is
// unchanged. sw.js only needs a different URL, not a different message
// shape. See extension/sw.js's startSession() for the client side.

export { SyncRelay } from "./SyncRelay.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.SYNC_RELAY.getByName("relay");
    // GET /stats: live activeUsers/activeRooms counts, for a dashboard —
    // routed through the same singleton DO so it reads real connections,
    // not a separate count that could drift from reality.
    if (url.pathname === "/stats") return stub.fetch(request);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("sync-lis relay: expects a WebSocket connection (or GET /stats)", { status: 426 });
    }
    return stub.fetch(request);
  },
};
