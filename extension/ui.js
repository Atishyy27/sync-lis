// sync-lis on-page panel — Teleparty-style: docked to the page itself, not
// Chrome's side panel. That is a deliberate trade: Chrome enforces a fixed
// minimum width on its side panel and it cannot be a dismissable floating
// surface. An element we draw ourselves has neither limit — it collapses to a
// small tab, and its own width (not the browser window's) drives every
// responsive rule via CSS container queries.
//
// content.js owns all state; this file only renders it and reports gestures
// back through the handlers passed to mount().

(() => {
  if (window.__syncLisUI) return;

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px; color: #ece7df;
}

/* ---------- the hold/countdown veil (unchanged in spirit) ---------- */
.veil {
  position: absolute; inset: 0;
  background: rgba(20, 18, 16, 0.62);
  backdrop-filter: blur(1.5px);
  opacity: 0; transition: opacity .28s ease;
  display: grid; place-items: center;
}
.veil.show { opacity: 1; }
.holdcard { text-align: center; padding: 0 24px; transform: translateY(6px); transition: transform .28s cubic-bezier(.22,1,.36,1); }
.veil.show .holdcard { transform: none; }
.kicker { font-size: 10.5px; letter-spacing: 2.2px; text-transform: uppercase; color: #9a9184; margin-bottom: 12px; }
.line { font-size: 34px; font-weight: 300; letter-spacing: -0.8px; color: #ece7df; line-height: 1.2; max-width: 16ch; margin: 0 auto; }
.line em { font-style: normal; color: #ffb454; }
.sub { font-size: 13px; color: #9a9184; margin-top: 14px; }
.count { font-size: 108px; font-weight: 200; color: #ece7df; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -4px; }

/* ---------- reactions / big / secret (unchanged) ---------- */
.float { position: absolute; font-size: 40px; animation: rise 2.2s ease-out forwards; }
@keyframes rise { 0% { opacity: 0; transform: translateY(0) scale(.6); } 15% { opacity: 1; transform: translateY(-18px) scale(1.15); } 100% { opacity: 0; transform: translateY(-230px) scale(1); } }
.huge { position: absolute; inset: 0; display: grid; place-items: center; font-size: 34vh; animation: slam 1.6s cubic-bezier(.2,1.4,.4,1) forwards; }
@keyframes slam { 0% { opacity: 0; transform: scale(2.4) rotate(-12deg); } 22% { opacity: 1; transform: scale(1) rotate(0deg); } 75% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1.15); } }
.secret { position: absolute; inset: 0; display: grid; place-items: center; animation: fadeInOut 5s ease-out forwards; }
.secret div { background: rgba(20,18,16,.94); border: 2px solid #ffe14d; color: #ffe14d; padding: 26px 34px; max-width: 60vw; font-size: 26px; font-weight: 300; line-height: 1.4; text-align: center; box-shadow: 0 0 60px rgba(255,225,77,.28); }
@keyframes fadeInOut { 0% { opacity: 0; transform: scale(.7) rotate(-2deg); } 10% { opacity: 1; transform: scale(1) rotate(0); } 85% { opacity: 1; } 100% { opacity: 0; transform: scale(1.04); } }
@media (prefers-reduced-motion: reduce) { .float, .huge, .secret { animation-duration: .5s; } }

/* ---------- the dock: collapsed tab or expanded panel ---------- */
.dock {
  position: absolute; top: 14vh; right: 0;
  pointer-events: auto;
  max-height: 78vh;
  display: flex;
}
.tab {
  writing-mode: vertical-rl;
  padding: 14px 7px;
  background: #ffb454; color: #241300;
  border: none; border-radius: 8px 0 0 8px;
  font-weight: 700; font-size: 11px; letter-spacing: 1.5px;
  box-shadow: -3px 0 18px rgba(0,0,0,.35);
  display: flex; align-items: center; gap: 6px;
}
.tab .dot2 { width: 6px; height: 6px; border-radius: 50%; background: #241300; writing-mode: horizontal-tb; }
.tab.hidden2 { display: none; }

.panel {
  width: 272px;
  container-type: inline-size;
  background: #161310;
  border: 1px solid #2a2620;
  border-right: none;
  border-radius: 10px 0 0 10px;
  box-shadow: -6px 0 30px rgba(0,0,0,.4);
  display: flex; flex-direction: column;
  overflow: hidden;
}
.panel.hidden2 { display: none; }

.phead {
  display: flex; align-items: center; gap: 6px;
  padding: 9px 10px;
  border-bottom: 1px solid #2a2620;
  background: #1c1916;
}
.pmark { font-size: 13px; font-weight: 300; letter-spacing: -0.4px; flex: none; }
.pmark b { font-weight: 600; }
.pmark::after { content: "."; color: #ffb454; }
.pcode { font-family: ui-monospace, Consolas, monospace; font-size: 10px; letter-spacing: 1.5px; color: #ffb454; }
.phead .spacer { flex: 1; }
.iconbtn {
  width: 24px; height: 24px; flex: none;
  display: grid; place-items: center;
  background: transparent; border: 1px solid #2a2620; border-radius: 4px;
  color: #9a9184; font-size: 12px; cursor: pointer;
}
.iconbtn:hover { color: #ece7df; border-color: #6b6357; }
.iconbtn.on { color: #ffb454; border-color: #ffb454; background: rgba(255,180,84,.12); }

.pbody { flex: 1; overflow-y: auto; min-height: 60px; }

/* the race: everyone's playback position as runners on a shared track,
   which replaces the unlabelled hairline bar entirely */
.race-wrap { padding: 10px 10px 8px; border-bottom: 1px solid #221e1a; }
.eyebrow { font-size: 9px; font-weight: 600; letter-spacing: 1.4px; text-transform: uppercase; color: #6b6357; margin-bottom: 6px; }
.stateline { font-size: 15px; font-weight: 300; letter-spacing: -0.3px; line-height: 1.3; margin-bottom: 10px; }
.stateline em { font-style: normal; color: #ffb454; }
.race {
  position: relative; height: 30px;
  background: linear-gradient(90deg, transparent, rgba(255,180,84,.06));
  border-radius: 4px;
  margin-bottom: 4px;
}
.race::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: #2a2620; }
.runner {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  width: 20px; height: 20px; border-radius: 50%;
  display: grid; place-items: center;
  font-size: 10px; font-weight: 700; color: #fff;
  border: 2px solid #161310;
  transition: left .5s cubic-bezier(.22,1,.36,1);
  z-index: 2;
}
.runner.leader { box-shadow: 0 0 0 2px #7dd8a6, 0 0 10px rgba(125,216,166,.5); z-index: 3; }
.runner.lag { box-shadow: 0 0 0 2px #e2614f; }
.runner.away { opacity: .4; }
.race-labels { display: flex; justify-content: space-between; font-size: 8.5px; color: #4a453d; letter-spacing: .5px; }

.now-title { font-size: 12.5px; color: #d9d2c4; line-height: 1.4; word-break: break-word; margin-top: 2px; }
.now-title.empty { color: #6b6357; font-style: italic; }

/* people, compact chips with ready/voice ALWAYS visible next to each name */
.people { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-bottom: 1px solid #221e1a; }
.person { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.pface { width: 18px; height: 18px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 9px; font-weight: 700; color: #fff; }
.pname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d9d2c4; }
.ptag { font-size: 8.5px; padding: 1px 5px; border-radius: 3px; color: #6b6357; border: 1px solid #2a2620; }
.ptag.ready { color: #7dd8a6; border-color: #7dd8a6; }
.ptag.mic { color: #ffb454; border-color: #ffb454; }

/* controls that must always be reachable, not buried in settings */
.handy { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #221e1a; }
.handy button {
  flex: 1; padding: 6px 4px; font-size: 10.5px; letter-spacing: .3px;
  background: transparent; border: 1px solid #2a2620; border-radius: 4px; color: #9a9184; cursor: pointer;
}
.handy button.on { color: #241300; background: #ffb454; border-color: #ffb454; }
.handy button:hover:not(.on) { color: #ece7df; border-color: #6b6357; }

/* the jam: paste links, they play in order */
.jam { padding: 8px 10px; border-bottom: 1px solid #221e1a; }
.jamrow { display: flex; gap: 5px; margin-bottom: 6px; }
.jamrow input { flex: 1; min-width: 0; padding: 6px 7px; font-size: 11px; background: #1c1916; border: 1px solid #2a2620; border-radius: 3px; color: #ece7df; }
.jamrow input::placeholder { color: #6b6357; }
.jamrow button { padding: 6px 9px; font-size: 10.5px; background: transparent; border: 1px solid #2a2620; border-radius: 3px; color: #9a9184; cursor: pointer; }
.jamrow button:hover { color: #ece7df; }
.qlist { list-style: none; max-height: 96px; overflow-y: auto; }
.qlist li { display: flex; align-items: baseline; gap: 6px; padding: 3px 0; font-size: 10.5px; }
.qn { color: #6b6357; font-variant-numeric: tabular-nums; flex: none; }
.qt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d9d2c4; }
.qx { color: #6b6357; cursor: pointer; background: none; border: none; font-size: 12px; }
.qx:hover { color: #e2614f; }
.qempty { color: #6b6357; font-size: 10.5px; }

/* chat */
.stream { flex: 1; overflow-y: auto; padding: 8px 10px; min-height: 60px; display: flex; flex-direction: column; gap: 8px; }
.said .from { font-size: 10px; color: #ffb454; font-weight: 600; }
.said .at { font-family: ui-monospace, Consolas, monospace; font-size: 8.5px; color: #6b6357; margin-left: 5px; }
.said .body { margin-top: 1px; font-size: 11.5px; word-wrap: break-word; }
.said img { max-width: 100%; margin-top: 5px; border-radius: 3px; display: block; }
.did { font-size: 10px; color: #6b6357; padding-left: 8px; border-left: 1px solid #2a2620; }
.did.switch { color: #9a9184; border-left-color: #ffb454; }
.typing { padding: 0 10px 4px; font-size: 9.5px; color: #6b6357; min-height: 12px; }

/* one tap fires the reaction; the input box gets exactly one visible border */
.quick { display: flex; gap: 2px; padding: 6px 10px 0; flex-wrap: wrap; }
.quick button { padding: 3px 4px; font-size: 15px; line-height: 1; background: none; border: none; border-radius: 3px; cursor: pointer; }
.quick button:hover { background: #221e1a; }
.quick button.sent { background: #ffb454; }

.composer { padding: 8px 10px 10px; }
.field {
  display: flex; align-items: center; gap: 4px;
  background: #1c1916; border: 1px solid #2a2620; border-radius: 5px;
  padding: 0 3px 0 9px;
}
.field:focus-within { border-color: #ffb454; }
.field input {
  flex: 1; min-width: 0; padding: 8px 0;
  background: none; border: none; color: #ece7df; font: inherit; outline: none;
}
.field input::placeholder { color: #6b6357; }
.field button {
  flex: none; padding: 5px 7px; font-size: 14px; line-height: 1;
  background: none; border: none; border-radius: 3px; color: #9a9184; cursor: pointer;
}
.field button:hover { color: #ece7df; background: #221e1a; }

.drawer { padding: 8px 10px 0; }
.drow { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
.dchip { padding: 5px 8px; font-size: 10px; background: none; border: 1px solid #2a2620; border-radius: 3px; color: #9a9184; cursor: pointer; }
.dchip:hover { color: #ece7df; border-color: #6b6357; }
.dchip.copied { color: #3fbf6b; border-color: #3fbf6b; background: rgba(63,191,107,.12); }
.dgrid { display: flex; flex-wrap: wrap; gap: 2px; }
.dgrid button { padding: 3px 5px; font-size: 15px; line-height: 1; background: none; border: none; border-radius: 3px; cursor: pointer; }
.dgrid button:hover { background: #221e1a; }
.dgrid.words button { font-size: 10.5px; color: #9a9184; border: 1px solid #2a2620; }
.dmini { display: flex; gap: 5px; margin-bottom: 6px; }
.dmini input { flex: 1; min-width: 0; padding: 6px 8px; background: #1c1916; border: 1px solid #2a2620; border-radius: 3px; color: #ece7df; }
.dmini button { padding: 6px 9px; border: 1px solid #2a2620; border-radius: 3px; color: #9a9184; background: none; cursor: pointer; }

/* ---------- container-query responsiveness: driven by the panel's OWN
   width, correct regardless of page zoom or window size ---------- */
@container (max-width: 240px) {
  .pmark { font-size: 12px; }
  .stateline { font-size: 13px; }
  .runner { width: 16px; height: 16px; font-size: 8px; }
  .handy button { font-size: 9.5px; padding: 5px 2px; }
  .pname { max-width: 90px; }
}

/* ---------- the settings sheet: the rarer stuff ---------- */
.sheet {
  position: absolute; inset: 0;
  background: rgba(10,9,7,.7);
  display: none; align-items: center; justify-content: center;
  pointer-events: auto;
}
.sheet.show { display: flex; }
.sheetcard {
  width: min(280px, 88vw);
  background: #161310; border: 1px solid #2a2620; border-radius: 8px;
  padding: 16px; display: flex; flex-direction: column; gap: 14px;
}
.sheethead { display: flex; align-items: center; justify-content: space-between; }
.sheethead h2 { font-size: 13px; font-weight: 500; color: #ece7df; }
.sblock { display: flex; flex-direction: column; gap: 6px; }
.scopy { display: flex; gap: 6px; }
.scopy input { flex: 1; min-width: 0; padding: 7px 9px; background: #1c1916; border: 1px solid #2a2620; border-radius: 3px; color: #ffb454; font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; }
.scopy input.name { color: #ece7df; font-family: inherit; font-size: 12px; }
.sfaces { display: flex; flex-wrap: wrap; gap: 3px; }
.sfaces button { width: 26px; height: 26px; font-size: 13px; background: none; border: 1px solid #2a2620; border-radius: 3px; cursor: pointer; }
.sfaces button.on { border-color: #ffb454; background: rgba(255,180,84,.14); }

/* a visible focus ring everywhere EXCEPT the composer input, which already
   shows focus by lighting up its own wrapper — adding the browser's default
   ring on top of that border is what read as a stray rectangle */
button:focus-visible, .jamrow input:focus-visible, .dmini input:focus-visible, .scopy input:focus-visible {
  outline: 1px solid #ffb454; outline-offset: 1px;
}

::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-thumb { background: #2a2620; }
::-webkit-scrollbar-track { background: transparent; }
`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const tint = (name) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 45% 46%)`; };

  const FACES = ["🎧", "🍿", "👾", "🐙", "🌙", "🔥", "🦊", "🫠", "💀", "🧃", "🪩", "🐈"];
  const EMOJI = ("😂 🤣 😭 😍 🥺 😳 😱 🤯 🫠 💀 👀 🙄 😴 🤡 🫡 🔥 ❤️ 💔 ✨ 🎉 🙌 👏 🤝 👍 " +
    "👎 🍿 🎬 🎧 🕺 💃 🤌 🧠 💯 ⚡ 🐐 🚩").split(" ");
  const STINGS = [["drumroll", "drum roll"], ["airhorn", "airhorn"], ["rimshot", "ba dum tss"], ["sad", "sad trombone"]];
  const QUICK = ["😂", "❤️", "🔥", "😭", "💀", "👀", "🎉", "🫠"];

  const ui = {
    root: null, sh: null, wrap: null,
    veil: null, holdcard: null,
    tab: null, panel: null, pbody: null,
    stream: null, typingEl: null, drawer: null,
    sheet: null,
    handlers: {},
    myFace: "",
    expanded: false,
    drawerKind: null,

    mount(handlers) {
      Object.assign(this.handlers, handlers || {});
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
      this.holdcard = document.createElement("div");
      this.holdcard.className = "holdcard";
      this.veil.appendChild(this.holdcard);

      this.wrap.appendChild(this.veil);
      this.wrap.appendChild(this.buildDock());
      this.wrap.appendChild(this.buildSheet());

      this.sh.append(style, this.wrap);

      // Shadow DOM doesn't stop bubbling — a keystroke typed into any panel
      // input still reaches the page's own document-level shortcut
      // listeners (YouTube's spacebar = play/pause chief among them), which
      // is why typing a space into chat kept pausing the video underneath.
      // Stopped at the shadow root, the highest point still inside our own
      // tree, for every text input the panel has now or grows later.
      const isTextInput = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      for (const type of ["keydown", "keyup", "keypress"]) {
        this.sh.addEventListener(type, (e) => { if (isTextInput(e.target)) e.stopPropagation(); });
      }

      document.documentElement.appendChild(this.root);

      window.addEventListener("message", () => {}); // reserved
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.target === "sync-lis-page" && msg.type === "expand") this.setExpanded(true);
      });
    },

    unmount() {
      if (this.root) this.root.remove();
      this.root = null;
    },

    // ---------- dock (collapsed tab / expanded panel) ----------

    buildDock() {
      const dock = document.createElement("div");
      dock.className = "dock";

      this.tab = document.createElement("button");
      this.tab.className = "tab";
      this.tab.innerHTML = `<span class="dot2"></span><span>sync-lis</span>`;
      this.tab.onclick = () => this.setExpanded(true);

      this.panel = document.createElement("div");
      this.panel.className = "panel hidden2";
      this.panel.innerHTML = `
        <div class="phead">
          <span class="pmark">sync&#8209;<b>lis</b></span>
          <span class="pcode" id="slPcode">·····</span>
          <span class="spacer"></span>
          <button class="iconbtn" id="slSettings" title="settings">&#9881;</button>
          <button class="iconbtn" id="slCollapse" title="collapse">&#10094;</button>
        </div>
        <div class="pbody">
          <div class="race-wrap">
            <div class="eyebrow">together?</div>
            <div class="stateline" id="slState">connecting…</div>
            <div class="race" id="slRace"></div>
            <div class="race-labels"><span>behind</span><span>ahead</span></div>
            <div class="now-title empty" id="slNow">nothing yet</div>
          </div>
          <div class="people" id="slPeople"></div>
          <div class="handy">
            <button id="slReady">Ready</button>
            <button id="slVoice">Voice</button>
            <button id="slMute" class="hidden2">Mute</button>
          </div>
          <div class="jam">
            <div class="eyebrow">up next</div>
            <div class="jamrow">
              <input id="slQUrl" placeholder="paste a link — anywhere" />
              <button id="slQAdd">Add</button>
            </div>
            <ul class="qlist" id="slQlist"></ul>
            <p class="qempty" id="slQempty">Drop a few links. They play in order, on each of your own accounts.</p>
            <div class="jamrow" style="margin-top:6px">
              <span style="flex:1"></span>
              <button id="slQNext">Skip</button>
            </div>
          </div>
          <div class="stream" id="slStream"></div>
          <div class="typing" id="slTyping"></div>
        </div>
        <div class="quick" id="slQuick"></div>
        <div class="composer">
          <div class="field">
            <input id="slMsg" maxlength="500" placeholder="say something" autocomplete="off" />
            <button id="slMore" title="more">+</button>
            <button id="slSend" title="send">&#8629;</button>
          </div>
          <div class="drawer hidden2" id="slDrawer"></div>
        </div>
      `;

      dock.append(this.tab, this.panel);
      this.wireDock();
      return dock;
    },

    setExpanded(v) {
      this.expanded = v;
      this.panel.classList.toggle("hidden2", !v);
      this.tab.classList.toggle("hidden2", v);
    },

    wireDock() {
      const q = (id) => this.sh.getElementById ? null : this.panel.querySelector("#" + id);
      const el = (id) => this.panel.querySelector("#" + id);

      el("slCollapse").onclick = () => this.setExpanded(false);
      el("slSettings").onclick = () => this.openSheet();

      el("slReady").onclick = () => this.handlers.onReady && this.handlers.onReady(!el("slReady").classList.contains("on"));
      el("slVoice").onclick = () => this.handlers.onVoice && this.handlers.onVoice(!el("slVoice").classList.contains("on"));
      el("slMute").onclick = () => {
        const m = el("slMute").classList.toggle("on");
        el("slMute").textContent = m ? "Muted" : "Mute";
        this.handlers.onMute && this.handlers.onMute(m);
      };

      el("slQAdd").onclick = () => this.submitQueue();
      el("slQUrl").onkeydown = (e) => { if (e.key === "Enter") this.submitQueue(); };
      el("slQNext").onclick = () => this.handlers.onQueueNext && this.handlers.onQueueNext();

      const send = () => {
        const v = el("slMsg").value.trim();
        if (!v) return;
        this.handlers.onSend && this.handlers.onSend(v);
        el("slMsg").value = "";
      };
      el("slSend").onclick = send;
      let lastTyped = 0;
      el("slMsg").onkeydown = (e) => { if (e.key === "Enter") send(); };
      el("slMsg").oninput = () => {
        const t = Date.now();
        if (t - lastTyped > 2000) { lastTyped = t; this.handlers.onTyping && this.handlers.onTyping(); }
      };
      el("slMore").onclick = () => this.toggleDrawer("menu", (d) => this.paneMenu(d));

      // one tap throws the reaction on screen; hold sends the huge one
      const quick = el("slQuick");
      for (const e of QUICK) {
        const b = document.createElement("button");
        b.textContent = e;
        b.title = "throw it on screen — hold for a big one";
        let timer = null, big = false;
        b.addEventListener("pointerdown", () => {
          big = false;
          timer = setTimeout(() => { big = true; this.handlers.onBig && this.handlers.onBig(e); b.classList.add("sent"); }, 450);
        });
        b.addEventListener("pointerup", () => {
          clearTimeout(timer);
          if (!big) { this.handlers.onReact && this.handlers.onReact(e); b.classList.add("sent"); }
          setTimeout(() => b.classList.remove("sent"), 220);
        });
        b.addEventListener("pointerleave", () => clearTimeout(timer));
        quick.appendChild(b);
      }
    },

    submitQueue() {
      const el = (id) => this.panel.querySelector("#" + id);
      const url = el("slQUrl").value.trim();
      if (!/^https?:\/\/\S+$/.test(url)) return;
      this.handlers.onQueueAdd && this.handlers.onQueueAdd(url);
      el("slQUrl").value = "";
    },

    toggleDrawer(kind, build) {
      const d = this.panel.querySelector("#slDrawer");
      if (this.drawerKind === kind && !d.classList.contains("hidden2")) {
        d.classList.add("hidden2");
        this.drawerKind = null;
        return;
      }
      this.drawerKind = kind;
      d.innerHTML = "";
      build(d);
      d.classList.remove("hidden2");
    },

    paneMenu(d) {
      const row = document.createElement("div");
      row.className = "drow";
      const items = [
        ["emoji", "Emoji", () => this.toggleDrawer("emoji", (dd) => this.paneEmoji(dd))],
        ["image", "Image", () => this.toggleDrawer("image", (dd) => this.paneImage(dd))],
        ["sound", "Sound", () => this.toggleDrawer("sound", (dd) => this.paneSound(dd))],
        ["secret", "Secret", () => this.toggleDrawer("secret", (dd) => this.paneSecret(dd))],
      ];
      for (const [, label, fn] of items) {
        const b = document.createElement("button");
        b.className = "dchip";
        b.textContent = label;
        b.onclick = fn;
        row.appendChild(b);
      }
      d.appendChild(row);
    },

    grid(d, values, onPick, words) {
      const g = document.createElement("div");
      g.className = "dgrid" + (words ? " words" : "");
      for (const v of values) {
        const b = document.createElement("button");
        b.textContent = Array.isArray(v) ? v[1] : v;
        b.onclick = () => onPick(Array.isArray(v) ? v[0] : v);
        g.appendChild(b);
      }
      d.appendChild(g);
    },

    paneEmoji(d) {
      this.paneMenu(d);
      // emoji here are for TYPING into a sentence — the quick row above the
      // composer is what throws one onto the screen with a single tap
      this.grid(d, EMOJI, (e) => {
        const i = this.panel.querySelector("#slMsg");
        i.value += e; i.focus();
      });
    },
    paneSound(d) {
      this.paneMenu(d);
      this.grid(d, STINGS, (kind) => this.handlers.onSting && this.handlers.onSting(kind), true);
    },
    paneImage(d) {
      this.paneMenu(d);
      const row = document.createElement("div");
      row.className = "dmini";
      const i = document.createElement("input");
      i.placeholder = "paste an image or gif link";
      const b = document.createElement("button");
      b.textContent = "Send";
      const go = () => {
        const v = i.value.trim();
        if (/^https?:\/\/\S+$/.test(v)) { this.handlers.onSend && this.handlers.onSend(v); i.value = ""; }
      };
      b.onclick = go;
      i.onkeydown = (e) => { if (e.key === "Enter") go(); };
      row.append(i, b);
      d.appendChild(row);
      i.focus();
    },
    paneSecret(d) {
      this.paneMenu(d);
      const row = document.createElement("div");
      row.className = "dmini";
      const i = document.createElement("input");
      i.maxLength = 200;
      i.placeholder = "bursts onto their screen";
      const b = document.createElement("button");
      b.textContent = "Drop";
      const go = () => {
        const v = i.value.trim();
        if (v) { this.handlers.onSecret && this.handlers.onSecret(v); i.value = ""; d.classList.add("hidden2"); this.drawerKind = null; }
      };
      b.onclick = go;
      i.onkeydown = (e) => { if (e.key === "Enter") go(); };
      row.append(i, b);
      d.appendChild(row);
      i.focus();
    },

    // ---------- settings sheet ----------

    buildSheet() {
      this.sheet = document.createElement("div");
      this.sheet.className = "sheet";
      this.sheet.innerHTML = `
        <div class="sheetcard">
          <div class="sheethead"><h2>Room</h2><button class="iconbtn" id="slSheetClose">&times;</button></div>
          <div class="sblock">
            <div class="eyebrow">invite</div>
            <div class="scopy"><input id="slLink" readonly /><button class="dchip" id="slCopy">Copy</button></div>
          </div>
          <div class="sblock">
            <div class="eyebrow">you</div>
            <div class="scopy"><input class="name" id="slMeName" maxlength="24" /><button class="dchip" id="slSaveMe">Save</button></div>
            <div class="sfaces" id="slFaces"></div>
          </div>
          <div class="sblock">
            <div class="eyebrow">room</div>
            <div class="drow">
              <button class="dchip" id="slLock">Lock controls</button>
              <button class="dchip" id="slLeave" style="color:#e2614f">Leave</button>
            </div>
          </div>
        </div>
      `;
      this.sheet.querySelector("#slSheetClose").onclick = () => this.sheet.classList.remove("show");
      this.sheet.addEventListener("click", (e) => { if (e.target === this.sheet) this.sheet.classList.remove("show"); });
      this.sheet.querySelector("#slCopy").onclick = () => {
        const btn = this.sheet.querySelector("#slCopy");
        // feedback lives on the button itself, not in the thread — copying a
        // link is not something worth a permanent line in the conversation
        navigator.clipboard.writeText(this.sheet.querySelector("#slLink").value).then(() => {
          const was = btn.textContent;
          btn.textContent = "Copied";
          btn.classList.add("copied");
          setTimeout(() => { btn.textContent = was; btn.classList.remove("copied"); }, 1400);
        });
      };
      this.sheet.querySelector("#slSaveMe").onclick = () => {
        const name = this.sheet.querySelector("#slMeName").value.trim();
        this.handlers.onIdentity && this.handlers.onIdentity(name, this.myFace);
      };
      this.sheet.querySelector("#slLock").onclick = () => {
        const on = this.sheet.querySelector("#slLock").classList.toggle("on");
        this.handlers.onLock && this.handlers.onLock(on);
      };
      this.sheet.querySelector("#slLeave").onclick = () => this.handlers.onLeave && this.handlers.onLeave();

      const faces = this.sheet.querySelector("#slFaces");
      for (const f of FACES) {
        const b = document.createElement("button");
        b.textContent = f;
        b.onclick = () => {
          this.myFace = f;
          this.handlers.onIdentity && this.handlers.onIdentity(this.sheet.querySelector("#slMeName").value.trim(), f);
          this.paintFaces();
        };
        faces.appendChild(b);
      }
      return this.sheet;
    },

    paintFaces() {
      this.sheet.querySelectorAll("#slFaces button").forEach((b) => {
        b.classList.toggle("on", b.textContent === this.myFace);
      });
    },

    openSheet() {
      this.sheet.classList.add("show");
    },

    // ---------- state rendering ----------

    renderRoom(state, content, room, offset) {
      if (!this.panel || !room) return;
      const el = (id) => this.panel.querySelector("#" + id);
      const members = room.members || [];
      const me = members.find((m) => m.id === room.meId);
      const rate = (state && state.rate) || 1;
      const now = !state ? 0 : state.paused ? state.time : state.time + ((Date.now() + (offset || 0) - state.at) / 1000) * rate;

      el("slPcode").textContent = room.code || "·····";
      el("slNow").textContent = content ? (content.title || content.url) : "nothing yet";
      el("slNow").classList.toggle("empty", !content);

      // the state line
      const behind = members.filter((m) => !m.arrived || m.holding);
      const counting = room.countdownAt && room.countdownAt > Date.now();
      const notReady = members.some((m) => m.ready) ? members.filter((m) => !m.ready) : [];
      let line;
      if (counting) line = `starting in <em>${Math.ceil((room.countdownAt - Date.now()) / 1000)}</em>`;
      else if (behind.length) line = `waiting for <em>${esc(behind.map((m) => (m.id === room.meId ? "you" : m.name)).join(" and "))}</em>`;
      else if (notReady.length) {
        line = notReady.some((m) => m.id === room.meId)
          ? "they're ready, <em>waiting on you</em>"
          : `waiting for <em>${esc(notReady.map((m) => m.name).join(" and "))}</em>`;
      } else if (!content) line = members.length < 2 ? "open something and press play" : "nobody has started anything";
      else if (state.paused) line = "paused";
      else line = "<em>in sync</em>";
      el("slState").innerHTML = line;

      // the race: one runner per person, spread by drift from the leader
      const race = el("slRace");
      race.innerHTML = "";
      if (members.length) {
        const span = Math.max(2, ...members.map((m) => Math.abs((m.pos || 0) - now)));
        const leader = members.reduce((a, b) => ((b.pos || 0) > (a.pos || 0) ? b : a), members[0]);
        for (const m of members) {
          const drift = (m.pos || 0) - now;
          const r = document.createElement("div");
          r.className = "runner" +
            (m.id === leader.id ? " leader" : "") +
            (Math.abs(drift) > 1.5 && m.arrived && !m.holding ? " lag" : "") +
            (m.away ? " away" : "");
          r.style.left = `calc(${(50 + (drift / span) * 42).toFixed(1)}% )`;
          r.style.background = tint(m.name || "");
          r.textContent = m.avatar || (m.name || "?").trim().charAt(0).toUpperCase();
          r.title = `${m.name} ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}s`;
          race.appendChild(r);
        }
      }

      // people
      const box = el("slPeople");
      box.innerHTML = "";
      for (const m of members) {
        const p = document.createElement("div");
        p.className = "person";
        p.innerHTML = `<span class="pface"></span><span class="pname"></span>` +
          (m.voice ? `<span class="ptag mic">mic</span>` : "") +
          (m.ready ? `<span class="ptag ready">ready</span>` : "");
        const f = p.querySelector(".pface");
        f.textContent = m.avatar || (m.name || "?").trim().charAt(0).toUpperCase();
        f.style.background = tint(m.name || "");
        p.querySelector(".pname").textContent = m.name + (m.id === room.meId ? " (you)" : "") + (m.id === room.hostId ? " · host" : "") + (m.away ? " · away" : "");
        box.appendChild(p);
      }

      el("slReady").classList.toggle("on", !!(me && me.ready));
      const lockBtn = this.sheet.querySelector("#slLock");
      lockBtn.classList.toggle("on", !!room.locked);
      lockBtn.textContent = room.locked ? "Controls locked" : "Lock controls";

      // the jam
      const q = room.queue || [];
      el("slQempty").classList.toggle("hidden2", q.length > 0);
      const ql = el("slQlist");
      ql.innerHTML = "";
      q.forEach((item, i) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="qn"></span><span class="qt"></span>` +
          (item.byId === room.meId || room.hostId === room.meId ? `<button class="qx" title="remove">&times;</button>` : "");
        li.querySelector(".qn").textContent = String(i + 1).padStart(2, "0");
        li.querySelector(".qt").textContent = item.title;
        const x = li.querySelector(".qx");
        if (x) x.onclick = () => this.handlers.onQueueRemove && this.handlers.onQueueRemove(item.id);
        ql.appendChild(li);
      });

      const linkBox = this.sheet.querySelector("#slLink");
      if (document.activeElement !== linkBox) linkBox.value = `${room.server || ""}/r/${room.code}`;
      const nameBox = this.sheet.querySelector("#slMeName");
      if (me && document.activeElement !== nameBox) nameBox.value = me.name || "";
      if (me && !this.myFace && me.avatar) { this.myFace = me.avatar; this.paintFaces(); }
    },

    setVoice(on, error) {
      if (!this.panel) return;
      const el = (id) => this.panel.querySelector("#" + id);
      el("slVoice").classList.toggle("on", on);
      el("slVoice").textContent = on ? "Voice on" : "Voice";
      el("slMute").classList.toggle("hidden2", !on);
      if (error === "mic") this.did("allow the microphone in the tab that opened, then try again");
      else if (error) this.did(`voice didn't start: ${error}`);
    },

    setTyping(name) {
      if (!this.panel) return;
      const t = this.panel.querySelector("#slTyping");
      t.textContent = name ? `${name} is typing` : "";
      clearTimeout(this._typingT);
      if (name) this._typingT = setTimeout(() => { t.textContent = ""; }, 3000);
    },

    // ---------- chat / activity ----------

    atBottom() {
      const s = this.panel.querySelector("#slStream");
      return s.scrollHeight - s.scrollTop - s.clientHeight < 40;
    },
    push(node) {
      const s = this.panel.querySelector("#slStream");
      const stick = this.atBottom();
      s.appendChild(node);
      while (s.children.length > 200) s.firstChild.remove();
      // an appended image loads asynchronously and grows the container
      // after scrollHeight was already read here; rAF gives layout a beat
      // to settle first so a burst of messages doesn't undershoot the true
      // bottom
      if (stick) requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; });
    },
    scrollToBottom() {
      if (!this.panel) return;
      const s = this.panel.querySelector("#slStream");
      requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; });
    },
    chat(from, text, at) {
      if (!this.panel) return;
      const d = document.createElement("div");
      d.className = "said";
      const img = /(https?:\/\/\S+\.(?:gif|png|jpe?g|webp))/i.exec(text || "");
      d.innerHTML = `<div><span class="from"></span><span class="at"></span></div><div class="body"></div>`;
      d.querySelector(".from").textContent = from;
      d.querySelector(".at").textContent = fmt(at);
      d.querySelector(".body").textContent = text;
      if (img) {
        const im = document.createElement("img");
        im.src = img[0];
        d.appendChild(im);
      }
      this.push(d);
    },
    did(text, isSwitch) {
      if (!this.panel) return;
      const d = document.createElement("div");
      d.className = "did" + (isSwitch ? " switch" : "");
      d.textContent = text;
      this.push(d);
    },
    resetStream() {
      if (this.panel) this.panel.querySelector("#slStream").innerHTML = "";
    },

    // ---------- the veil (hold / countdown) ----------

    hold(kicker, lead, who, sub) {
      if (!this.root) return;
      const show = !!lead;
      this.veil.classList.toggle("show", show);
      if (!show) return;
      this.holdcard.innerHTML =
        `<div class="kicker">${esc(kicker)}</div>` +
        `<div class="line">${esc(lead)} <em>${esc(who)}</em></div>` +
        (sub ? `<div class="sub">${esc(sub)}</div>` : "");
    },
    countdown(n) {
      if (!this.root) return;
      this.veil.classList.add("show");
      this.holdcard.innerHTML = `<div class="kicker">starting together</div><div class="count">${n}</div>`;
    },

    // ---------- moments ----------

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
        [0, 0.34, 0.68].forEach((o) => { tone(now + o, 0.3, 300, 300); tone(now + o, 0.3, 452, 452); });
      } else if (kind === "rimshot") {
        noiseBurst(now, 0.08, 900); noiseBurst(now + 0.13, 0.08, 700); noiseBurst(now + 0.28, 0.4, 300);
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
