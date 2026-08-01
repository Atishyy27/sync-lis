// Does the on-page panel actually work, and is it actually responsive?
//
// The panel moved off Chrome's side panel (which forces its own minimum
// width and can't be a dismissable popup) onto the page itself, as a small
// collapsible dock we draw ourselves. That trade only pays off if this file
// proves it: the panel must never push the page into horizontal scroll, its
// container-query breakpoints must genuinely fire, the composer's focus
// state must not double up into a stray rectangle, one-tap reactions must
// not silently become typed text, and the always-visible controls must
// actually be visible without opening settings.

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

// injected as inline content, not a file:// script tag — about:blank has an
// opaque origin that Chrome refuses to load local file scripts into
const UI_SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "ui.js"), "utf8");

const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c || !extra ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};

const FAKE_ROOM = {
  code: "AB12C", server: "https://relay.example", meId: 1, hostId: 1, locked: false,
  members: [
    { id: 1, name: "Atishay", avatar: "🎧", pos: 42, arrived: true, holding: false, away: false, ready: false, voice: false },
    { id: 2, name: "Aditi", avatar: "🍿", pos: 38.2, arrived: true, holding: false, away: false, ready: false, voice: true },
    { id: 3, name: "Rahul", avatar: "", pos: 20, arrived: true, holding: false, away: false, ready: false, voice: false },
  ],
  queue: [
    { id: 1, title: "Next up: something great", byId: 2, byName: "Aditi" },
  ],
};
const FAKE_STATE = { paused: false, time: 40, at: Date.now(), rate: 1 };
const FAKE_CONTENT = { key: "yt:abc", url: "https://youtube.com/watch?v=abc", title: "A perfectly normal video title" };

async function setup(page) {
  await page.goto("about:blank");
  // a stand-in for chrome.runtime so ui.js's mount() doesn't throw outside
  // an extension context
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener() {} } } };
  });
  await page.addScriptTag({ content: UI_SRC });
  await page.evaluate(({ room, state, content }) => {
    window.__handlerCalls = [];
    const record = (name) => (...args) => window.__handlerCalls.push([name, ...args]);
    window.__syncLisUI.mount({
      onSend: record("send"), onReact: record("react"), onBig: record("big"),
      onSting: record("sting"), onSecret: record("secret"), onReady: record("ready"),
      onLock: record("lock"), onVoice: record("voice"), onMute: record("mute"),
      onTyping: record("typing"), onIdentity: record("identity"),
      onQueueAdd: record("queueAdd"), onQueueRemove: record("queueRemove"),
      onQueueNext: record("queueNext"), onLeave: record("leave"),
    });
    window.__syncLisUI.setExpanded(true);
    window.__syncLisUI.renderRoom(state, content, room, 0);
  }, { room: FAKE_ROOM, state: FAKE_STATE, content: FAKE_CONTENT });
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ---- 1. no horizontal overflow at realistic window widths ----
  for (const w of [1280, 900, 600]) {
    const page = await browser.newPage({ viewport: { width: w, height: 800 } });
    await setup(page);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${w}px window: panel causes no horizontal scroll`, overflow <= 0, `${overflow}px of overflow`);
    await page.close();
  }

  // ---- 2. the panel itself, and its pieces, actually render ----
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await setup(page);

  const shape = await page.evaluate(() => {
    const sh = document.getElementById("sync-lis-root").shadowRoot;
    return {
      panelVisible: !sh.querySelector(".panel").classList.contains("hidden2"),
      runners: sh.querySelectorAll(".runner").length,
      leaders: sh.querySelectorAll(".runner.leader").length,
      lagged: sh.querySelectorAll(".runner.lag").length,
      people: sh.querySelectorAll(".person").length,
      queueRows: sh.querySelectorAll(".qlist li").length,
      code: sh.querySelector("#slPcode").textContent,
      title: sh.querySelector("#slNow").textContent,
    };
  });
  check("panel expands on setExpanded(true)", shape.panelVisible);
  check("one runner per person on the race track", shape.runners === 3, `got ${shape.runners}`);
  check("the person furthest ahead is marked as leader", shape.leaders === 1, `got ${shape.leaders}`);
  check("the person meaningfully behind is marked lagging", shape.lagged >= 1, `got ${shape.lagged}`);
  check("the room code renders", shape.code === "AB12C");
  check("the now-playing title renders", shape.title.includes("perfectly normal"));

  // ---- 3. Ready and Voice are reachable without opening settings ----
  const handy = await page.evaluate(() => {
    const sh = document.getElementById("sync-lis-root").shadowRoot;
    const row = sh.querySelector(".handy");
    const sheetOpen = sh.querySelector(".sheet").classList.contains("show");
    return {
      sheetOpenByDefault: sheetOpen,
      hasReady: !!row.querySelector("#slReady"),
      hasVoice: !!row.querySelector("#slVoice"),
    };
  });
  check("the settings sheet is closed by default", !handy.sheetOpenByDefault);
  check("Ready is in the always-visible row, not behind settings", handy.hasReady);
  check("Voice is in the always-visible row, not behind settings", handy.hasVoice);

  // ---- 4. one tap on a quick-reaction fires react(), never types into the box ----
  await page.evaluate(() => {
    const sh = document.getElementById("sync-lis-root").shadowRoot;
    const btn = sh.querySelector(".quick button");
    const r = btn.getBoundingClientRect();
    for (const type of ["pointerdown", "pointerup"]) {
      btn.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.x + 2, clientY: r.y + 2 }));
    }
  });
  await page.waitForTimeout(150);
  const afterTap = await page.evaluate(() => {
    const sh = document.getElementById("sync-lis-root").shadowRoot;
    return { msgBox: sh.querySelector("#slMsg").value, calls: window.__handlerCalls.map((c) => c[0]) };
  });
  check("a quick-tap reaction calls onReact, not onSend", afterTap.calls.includes("react"), afterTap.calls.join(","));
  check("and never appends the emoji into the message box", afterTap.msgBox === "", `box had "${afterTap.msgBox}"`);

  // ---- 5. the composer shows exactly one focus indicator, not two ----
  const focusRing = await page.evaluate(() => {
    const sh = document.getElementById("sync-lis-root").shadowRoot;
    const input = sh.querySelector("#slMsg");
    input.focus();
    const cs = getComputedStyle(input);
    return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
  });
  check("the message input suppresses the default focus ring (the wrapper shows focus instead)",
    focusRing.outlineStyle === "none" || focusRing.outlineWidth === "0px",
    `outline: ${focusRing.outlineStyle} ${focusRing.outlineWidth}`);

  // ---- 6. container queries genuinely work, proven at a width where they must fire ----
  const cq = await page.evaluate(() => {
    const sh = document.getElementById("sync-lis-root").shadowRoot;
    const panel = sh.querySelector(".panel");
    const mark = sh.querySelector(".pmark");
    const wide = getComputedStyle(mark).fontSize;
    panel.style.width = "200px"; // below the 240px breakpoint
    const narrow = getComputedStyle(mark).fontSize;
    panel.style.width = "";
    return { wide, narrow };
  });
  check("the container query actually narrows the type when the panel itself shrinks",
    parseFloat(cq.narrow) < parseFloat(cq.wide), `${cq.wide} -> ${cq.narrow}`);

  // ---- 7. collapse/expand ----
  await page.evaluate(() => window.__syncLisUI.setExpanded(false));
  const collapsed = await page.evaluate(() => {
    const sh = document.getElementById("sync-lis-root").shadowRoot;
    return { panelHidden: sh.querySelector(".panel").classList.contains("hidden2"), tabShown: !sh.querySelector(".tab").classList.contains("hidden2") };
  });
  check("collapsing hides the panel", collapsed.panelHidden);
  check("and leaves only the small tab, which is the whole point of moving off the side panel", collapsed.tabShown);

  await page.close();
  await browser.close();
  console.log(results.join("\n"));
  process.exit(process.exitCode || 0);
})();
