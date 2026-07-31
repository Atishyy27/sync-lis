// Runs only on room-link pages (`*://*/r/*`).
//
// Waking a Manifest V3 service worker from tabs.onUpdated is unreliable — the
// worker may be asleep when the navigation completes and the event can be
// missed. A message from a content script is a guaranteed wake path, so the
// page itself asks to be joined.

const m = /^(https?:\/\/[^/]+)\/r\/([A-Za-z0-9]{5})\/?$/.exec(location.href);
if (m) {
  chrome.runtime.sendMessage({
    target: "sync",
    type: "linkJoin",
    origin: m[1],
    code: m[2].toUpperCase(),
  });
}
