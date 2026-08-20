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
