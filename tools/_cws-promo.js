// Renders the 440x280 small promo tile the Chrome Web Store requires (and the
// optional 1400x560 marquee), on the product's own palette.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const OUT = process.argv[2];
const ICON = "data:image/svg+xml;base64," + Buffer.from(
  fs.readFileSync(path.join(__dirname, "..", "extension", "icons", "icon.svg"))
).toString("base64");

const page_html = (w, h, iconPx, titlePx, subPx, gap) => `
<body style="margin:0">
<div style="width:${w}px;height:${h}px;background:#161310;display:flex;
            flex-direction:column;align-items:center;justify-content:center;
            gap:${gap}px;font-family:'Segoe UI',system-ui,sans-serif">
  <img src="${ICON}" width="${iconPx}" height="${iconPx}"/>
  <div style="color:#ece7df;font-size:${titlePx}px;font-weight:600;letter-spacing:-0.02em">
    sync-lis<span style="color:#ffb454">.</span>
  </div>
  <div style="color:#9a9184;font-size:${subPx}px;text-align:center;line-height:1.45;max-width:${w - 80}px">
    watch together, anywhere.<br/>no screen sharing.
  </div>
</div>
</body>`;

(async () => {
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage();
  fs.mkdirSync(OUT, { recursive: true });

  await page.setViewportSize({ width: 440, height: 280 });
  await page.setContent(page_html(440, 280, 76, 34, 15, 14));
  await page.screenshot({ path: path.join(OUT, "promo-small-440x280.png") });

  await page.setViewportSize({ width: 1400, height: 560 });
  await page.setContent(page_html(1400, 560, 150, 68, 28, 28));
  await page.screenshot({ path: path.join(OUT, "promo-marquee-1400x560.png") });

  // The store icon is spec'd differently from the in-browser one: 96x96 of
  // artwork centred in a 128x128 transparent canvas, per the CWS image docs.
  await page.setViewportSize({ width: 128, height: 128 });
  await page.setContent(`<body style="margin:0"><div style="width:128px;height:128px;
      display:flex;align-items:center;justify-content:center">
      <img src="${ICON}" width="96" height="96"/></div></body>`);
  await page.screenshot({ path: path.join(OUT, "store-icon-128.png"), omitBackground: true });

  console.log("promo tiles + store icon written");
  await browser.close();
})();
