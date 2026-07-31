// The only thing sync-lis still draws on the page itself.
//
// The room lives in the side panel now, so nothing here covers the video. What
// stays is what has to be seen *while watching*: reactions floating up, and a
// brief line when the room is waiting for somebody.

(() => {
  if (window.__syncLisUI) return;

  const CSS = `
:host { all: initial; }
.wrap { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  font-family: "JetBrains Mono","Fira Code",ui-monospace,Consolas,monospace; }
.toast {
  position: absolute; top: 18px; left: 50%; transform: translateX(-50%);
  background: rgba(5, 11, 20, 0.94); color: #22d3ee;
  border: 1px solid rgba(34, 211, 238, 0.45); border-radius: 8px;
  padding: 8px 14px; font-size: 12px; letter-spacing: .2px;
  opacity: 0; transition: opacity .2s;
}
.toast.show { opacity: 1; }
.toast.count { font-size: 26px; font-weight: 700; padding: 10px 22px; }
.float { position: absolute; font-size: 38px; animation: rise 2.2s ease-out forwards; }
@keyframes rise {
  0% { opacity: 0; transform: translateY(0) scale(.6); }
  15% { opacity: 1; transform: translateY(-16px) scale(1.1); }
  100% { opacity: 0; transform: translateY(-210px) scale(1); }
}
@media (prefers-reduced-motion: reduce) { .float { animation-duration: .6s; } }
`;

  const ui = {
    root: null, sh: null, wrap: null, toastEl: null,

    mount() {
      if (this.root) return;
      this.root = document.createElement("div");
      this.root.id = "sync-lis-root";
      this.sh = this.root.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CSS;
      this.wrap = document.createElement("div");
      this.wrap.className = "wrap";
      this.toastEl = document.createElement("div");
      this.toastEl.className = "toast";
      this.wrap.appendChild(this.toastEl);
      this.sh.append(style, this.wrap);
      document.documentElement.appendChild(this.root);
    },

    unmount() {
      if (this.root) this.root.remove();
      this.root = null;
    },

    // text === null hides it; big === true for the countdown
    toast(text, big) {
      if (!this.root) return;
      this.toastEl.classList.toggle("show", !!text);
      this.toastEl.classList.toggle("count", !!big);
      if (text) this.toastEl.textContent = text;
    },

    float(emoji) {
      if (!this.root) return;
      const s = document.createElement("div");
      s.className = "float";
      s.textContent = emoji;
      s.style.left = `${15 + Math.random() * 70}%`;
      s.style.top = `${55 + Math.random() * 20}%`;
      this.wrap.appendChild(s);
      setTimeout(() => s.remove(), 2300);
    },
  };

  window.__syncLisUI = ui;
})();
