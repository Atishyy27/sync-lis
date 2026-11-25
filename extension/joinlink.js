// Runs only on room-link pages (`*://*/r/*`).
//
// Waking a Manifest V3 service worker from tabs.onUpdated is unreliable — the
// worker may be asleep when the navigation completes and the event can be
// missed. A message from a content script is a guaranteed wake path, so the
// page itself asks to be joined.

(() => {
  // Any site can have a /r/<5 characters> page (reddit.com/r/funny is one), so the
  // URL alone does not make a room link. It is one when it is on the default
  // relay, or when the page says so itself: the relay's invite page carries
  // <meta name="sync-lis-room" content="CODE">, which is how a self-hosted relay
  // is recognised without a list of hosts.
  const DEFAULT_RELAY = "https://sync-lis-relay.sync-lis-relay.workers.dev";

  const m = /^(https?:\/\/[^/]+)\/r\/([A-Za-z0-9]{5})\/?$/.exec(location.href);
  const marker = m && document.querySelector('meta[name="sync-lis-room"]');
  if (m && (m[1] === DEFAULT_RELAY || (marker && marker.content.toUpperCase() === m[2].toUpperCase()))) {
    chrome.runtime.sendMessage({
      target: "sync",
      type: "linkJoin",
      origin: m[1],
      code: m[2].toUpperCase(),
    });

    // The page ships an "Add to Chrome" button because most people opening an
    // invite link do not have this installed yet. This script running at all is
    // proof that this visitor does, so swap the install pitch for the joining
    // message rather than nagging someone who already said yes.
    const swap = () => {
      const need = document.getElementById("need");
      const have = document.getElementById("have");
      if (need) need.style.display = "none";
      if (have) have.style.display = "block";
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", swap, { once: true });
    } else {
      swap();
    }
  }
})();
