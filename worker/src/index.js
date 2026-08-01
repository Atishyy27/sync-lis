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
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("sync-lis relay: expects a WebSocket connection", { status: 426 });
    }
    const stub = env.SYNC_RELAY.getByName("relay");
    return stub.fetch(request);
  },
};
