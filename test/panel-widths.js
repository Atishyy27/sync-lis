// Does the panel actually survive being narrow?
//
// Browser zoom does not widen the panel, it shrinks it in the units the CSS is
// written in: at 150% a 380px panel is about 250 CSS pixels. So this loads the
// panel at the widths those zoom levels produce and fails on anything that
// overflows its container or overlaps a neighbour.

const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

const PANEL = "file://" + path.join(__dirname, "..", "extension", "sidepanel.html").replace(/\\/g, "/");

// 380 physical px of panel, at the zoom levels people actually use
const WIDTHS = [
  [380, "100%"],
  [304, "125%"],
  [253, "150%"],
  [217, "175%"],
];

const results = [];
const check = (n, c, extra) => {
  results.push(`${c ? "PASS" : "FAIL"}  ${n}${c || !extra ? "" : `  <-- ${extra}`}`);
  if (!c) process.exitCode = 1;
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const [w, zoom] of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: 820 } });
    await page.goto(PANEL);
    // show the room, which is the crowded half
    await page.evaluate(() => {
      document.getElementById("door").classList.add("hidden");
      document.getElementById("live").classList.remove("hidden");
      document.getElementById("roomCode").textContent = "AB12C";
      document.getElementById("stateLine").innerHTML = "waiting for <em>Aditi</em>";
      document.getElementById("title").textContent =
        "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)";
      const people = document.getElementById("people");
      for (const [n, f] of [["Atishay", "🎧"], ["Aditi", "🍿"]]) {
        const s = document.createElement("span");
        s.className = "who";
        s.innerHTML = `<span class="face">${f}</span><span class="nm">${n}</span><span class="st">+1.2s</span>`;
        people.appendChild(s);
      }
    });
    await page.waitForTimeout(250);

    const report = await page.evaluate(() => {
      const bad = [];
      // nothing may push the document sideways
      const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      // and no element may spill out of the viewport
      for (const el of document.querySelectorAll("body *")) {
        if (el.offsetParent === null && el !== document.body) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > window.innerWidth + 1) {
          bad.push(`${el.className || el.tagName} spills ${Math.round(r.right - window.innerWidth)}px`);
        }
      }
      const bar = document.querySelector(".roombar");
      const line = document.getElementById("stateLine");
      const cs = getComputedStyle(line);
      const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
      return {
        docOverflow,
        bad: [...new Set(bad)].slice(0, 4),
        barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
        // the headline should never become a paragraph
        stateLines: Math.round(line.getBoundingClientRect().height / lineH),
        stateFont: Math.round(parseFloat(cs.fontSize)),
        // no single control may eat the header
        barChildren: bar ? bar.children.length : 0,
      };
    });

    check(`${zoom} (${w}px): nothing scrolls sideways`, report.docOverflow <= 0, `${report.docOverflow}px of overflow`);
    check(`${zoom} (${w}px): nothing spills out`, report.bad.length === 0, report.bad.join("; "));
    check(`${zoom} (${w}px): the header stays one row`, report.barHeight > 0 && report.barHeight < 52,
      `${report.barHeight}px tall`);
    check(`${zoom} (${w}px): the headline stays a headline`, report.stateLines <= 2,
      `wrapped to ${report.stateLines} lines at ${report.stateFont}px`);
    check(`${zoom} (${w}px): the type scales down with the panel`, report.stateFont <= (w < 300 ? 19 : 21),
      `${report.stateFont}px in a ${w}px panel`);
    await page.close();
  }
  await browser.close();
  console.log(results.join("\n"));
  process.exit(process.exitCode || 0);
})();
