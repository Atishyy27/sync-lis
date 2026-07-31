// Asks for the microphone once, on the extension's own origin.
// An offscreen document cannot show a permission prompt, so this small page
// does the asking; afterwards the voice engine can open the mic silently.

const msg = document.getElementById("msg");
const ask = document.getElementById("ask");

ask.addEventListener("click", async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop()); // we only needed the permission
    msg.innerHTML = '<span class="ok">Microphone allowed.</span> Go back to your video and turn on voice from the sync-lis panel.';
    ask.remove();
    setTimeout(() => window.close(), 2500);
  } catch (e) {
    msg.textContent =
      e && e.name === "NotAllowedError"
        ? "Chrome blocked the microphone. Click the camera icon in the address bar to allow it, then try again."
        : `Couldn't open the microphone: ${e && e.name}`;
  }
});
