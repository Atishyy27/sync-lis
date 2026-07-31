// sync-lis Netflix bridge — runs in the page's MAIN world.
// Netflix's player ignores direct video.currentTime writes; its internal API is
// the only reliable transport, and that API is unreachable from a content
// script's isolated world. This relays commands across the boundary.

(() => {
  if (window.__syncLisNetflixBridge) return;
  window.__syncLisNetflixBridge = true;

  function player() {
    const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
    return vp.getVideoPlayerBySessionId(vp.getAllPlayerSessionIds()[0]);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.source !== "sync-lis-agent") return;
    try {
      const p = player();
      if (e.data.action === "seek") p.seek(Math.max(0, e.data.time * 1000));
      else if (e.data.action === "play") p.play();
      else if (e.data.action === "pause") p.pause();
      window.postMessage({ source: "sync-lis-netflix", ok: true }, "*");
    } catch {
      // player not ready or API shape changed; the agent falls back to <video>
      window.postMessage({ source: "sync-lis-netflix", ok: false }, "*");
    }
  });
})();
