// What sync-lis draws on the page you are watching.
//
// The room lives in the side panel. What stays here is only what has to be
// seen without looking away from the film: why everyone stopped, the countdown,
// reactions, and the party pieces.

(() => {
  if (window.__syncLisUI) return;

  const CSS = `
:host { all: initial; }
.wrap {
  position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

/* the room is waiting: dim the film just enough, say it plainly, leave */
.veil {
  position: absolute; inset: 0;
  background: rgba(8, 9, 11, 0.62);
  backdrop-filter: blur(1.5px);
  opacity: 0; transition: opacity .28s ease;
  display: grid; place-items: center;
}
.veil.show { opacity: 1; }
.card {
  text-align: center;
  padding: 0 24px;
  transform: translateY(6px);
  transition: transform .28s cubic-bezier(.22,1,.36,1);
}
.veil.show .card { transform: none; }
.kicker {
  font-size: 10.5px; letter-spacing: 2.2px; text-transform: uppercase;
  color: #878d96; margin-bottom: 12px;
}
.line {
  font-size: 34px; font-weight: 300; letter-spacing: -0.8px;
  color: #e9ebee; line-height: 1.2; max-width: 16ch; margin: 0 auto;
}
.line em { font-style: normal; color: #8b8cff; }
.sub { font-size: 13px; color: #878d96; margin-top: 14px; }
.count {
  font-size: 108px; font-weight: 200; color: #e9ebee; line-height: 1;
  font-variant-numeric: tabular-nums; letter-spacing: -4px;
}

/* reactions */
.float { position: absolute; font-size: 40px; animation: rise 2.2s ease-out forwards; }
@keyframes rise {
  0% { opacity: 0; transform: translateY(0) scale(.6); }
  15% { opacity: 1; transform: translateY(-18px) scale(1.15); }
  100% { opacity: 0; transform: translateY(-230px) scale(1); }
}
/* a reaction sent big enough to interrupt */
.huge {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 34vh; animation: slam 1.6s cubic-bezier(.2,1.4,.4,1) forwards;
}
@keyframes slam {
  0% { opacity: 0; transform: scale(2.4) rotate(-12deg); }
  22% { opacity: 1; transform: scale(1) rotate(0deg); }
  75% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.15); }
}
/* the secret, revealed */
.secret {
  position: absolute; inset: 0; display: grid; place-items: center;
  animation: fadeInOut 5s ease-out forwards;
}
.secret div {
  background: rgba(8,9,11,.95); border: 1px solid #8b8cff;
  color: #e9ebee; padding: 28px 36px; max-width: 60vw;
  font-size: 26px; font-weight: 300; line-height: 1.4; text-align: center;
  letter-spacing: -0.3px;
  box-shadow: 0 24px 80px rgba(0,0,0,.55);
}
@keyframes fadeInOut {
  0% { opacity: 0; transform: scale(.7) rotate(-2deg); }
  10% { opacity: 1; transform: scale(1) rotate(0); }
  85% { opacity: 1; }
  100% { opacity: 0; transform: scale(1.04); }
}
@media (prefers-reduced-motion: reduce) {
  .float, .huge, .secret { animation-duration: .5s; }
}
`;

  const ui = {
    root: null, sh: null, wrap: null, veil: null, body: null,

    mount() {
      if (this.root) return;
      this.root = document.createElement("div");
      this.root.id = "sync-lis-root";
      this.sh = this.root.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CSS;
      this.wrap = document.createElement("div");
      this.wrap.className = "wrap";
      this.veil = document.createElement("div");
      this.veil.className = "veil";
      this.body = document.createElement("div");
      this.body.className = "card";
      this.veil.appendChild(this.body);
      this.wrap.appendChild(this.veil);
      this.sh.append(style, this.wrap);
      document.documentElement.appendChild(this.root);
    },

    unmount() {
      if (this.root) this.root.remove();
      this.root = null;
    },

    // kicker/line/sub, or null to clear
    // `who` is emphasised inside the sentence, the way the panel does it
    hold(kicker, lead, who, sub) {
      if (!this.root) return;
      const show = !!lead;
      this.veil.classList.toggle("show", show);
      if (!show) return;
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      this.body.innerHTML =
        `<div class="kicker">${esc(kicker)}</div>` +
        `<div class="line">${esc(lead)} <em>${esc(who)}</em></div>` +
        (sub ? `<div class="sub">${esc(sub)}</div>` : "");
    },

    countdown(n) {
      if (!this.root) return;
      this.veil.classList.add("show");
      this.body.innerHTML =
        `<div class="kicker">starting together</div><div class="count">${n}</div>`;
    },

    float(emoji) {
      if (!this.root) return;
      const s = document.createElement("div");
      s.className = "float";
      s.textContent = emoji;
      s.style.left = `${12 + Math.random() * 74}%`;
      s.style.top = `${58 + Math.random() * 18}%`;
      this.wrap.appendChild(s);
      setTimeout(() => s.remove(), 2300);
    },

    big(emoji) {
      if (!this.root) return;
      const s = document.createElement("div");
      s.className = "huge";
      s.textContent = emoji;
      this.wrap.appendChild(s);
      setTimeout(() => s.remove(), 1700);
    },

    secret(text) {
      if (!this.root) return;
      const s = document.createElement("div");
      s.className = "secret";
      const inner = document.createElement("div");
      inner.textContent = text;
      s.appendChild(inner);
      this.wrap.appendChild(s);
      setTimeout(() => s.remove(), 5100);
    },

    // Sounds are synthesised rather than shipped: no files to load, no delay
    // before the joke lands.
    sting(kind) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ac = new Ctx();
      const now = ac.currentTime;
      const out = ac.createGain();
      out.gain.value = 0.22;
      out.connect(ac.destination);

      const noiseBurst = (t, dur, freq) => {
        const len = Math.max(1, Math.floor(ac.sampleRate * dur));
        const buf = ac.createBuffer(1, len, ac.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = ac.createBufferSource();
        src.buffer = buf;
        const bp = ac.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = freq;
        src.connect(bp).connect(out);
        src.start(t);
      };
      const tone = (t, dur, f0, f1, type) => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = type || "sawtooth";
        o.frequency.setValueAtTime(f0, t);
        o.frequency.linearRampToValueAtTime(f1, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + dur + 0.05);
      };

      if (kind === "drumroll") {
        for (let i = 0; i < 34; i++) noiseBurst(now + i * 0.045, 0.05, 220 + i * 12);
        noiseBurst(now + 1.6, 0.35, 180);
        tone(now + 1.6, 0.5, 380, 120, "triangle");
      } else if (kind === "airhorn") {
        [0, 0.34, 0.68].forEach((o) => {
          tone(now + o, 0.3, 300, 300);
          tone(now + o, 0.3, 452, 452);
        });
      } else if (kind === "rimshot") {
        noiseBurst(now, 0.08, 900);
        noiseBurst(now + 0.13, 0.08, 700);
        noiseBurst(now + 0.28, 0.4, 300);
      } else if (kind === "sad") {
        [523, 494, 440, 392].forEach((f, i) => tone(now + i * 0.18, 0.22, f, f * 0.98, "triangle"));
      } else {
        tone(now, 0.18, 880, 1200, "square");
      }
      setTimeout(() => ac.close().catch(() => {}), 4000);
    },
  };

  window.__syncLisUI = ui;
})();
