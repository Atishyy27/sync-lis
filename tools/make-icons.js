// Renders extension/icons/icon.svg to the PNG sizes Chrome asks for.
//
// Playwright is already a devDependency for the browser tests, so this needs
// no image library — the browser that runs the e2e suite rasterises the SVG.

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const dir = path.join(__dirname, "..", "extension", "icons");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
const SIZES = [16, 32, 48, 128];

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0">${svg.replace(/width="128" height="128"/, `width="${size}" height="${size}"`)}</body>`
    );
    await page.screenshot({ path: path.join(dir, `icon${size}.png`), omitBackground: true });
    console.log(`icon${size}.png`);
  }
  await browser.close();
})();
