// Packs extension/ into the zip that gets attached to a GitHub Release and
// uploaded to the Chrome Web Store.
//
// The one rule that matters: manifest.json must sit at the ZIP ROOT, not
// inside a sync-lis/ folder. Zipping the directory instead of its contents
// produces an archive Chrome rejects with "Manifest file is missing or
// unreadable", which reads like a broken manifest rather than a packaging
// mistake and costs an hour to spot.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "extension");
const dist = path.join(root, "dist");

const version = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8")).version;
const out = path.join(dist, `sync-lis-v${version}.zip`);

fs.mkdirSync(dist, { recursive: true });
fs.rmSync(out, { force: true });

// `zip` on CI and any unix box; Compress-Archive is the Windows fallback so
// this works on his machine without installing anything.
const haveZip = (() => {
  try {
    execFileSync("zip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// CWS-SUBMISSION.md is our own dashboard crib sheet, not something a user
// installing the extension should receive.
const EXCLUDE = ["CWS-SUBMISSION.md"];

if (haveZip) {
  execFileSync("zip", ["-r", "-q", out, ".", "-x", ...EXCLUDE], { cwd: src });
} else {
  const keep = fs
    .readdirSync(src)
    .filter((f) => !EXCLUDE.includes(f))
    .map((f) => `'${path.join(src, f)}'`)
    .join(",");
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Compress-Archive -Path ${keep} -DestinationPath '${out}' -Force`],
    { stdio: "inherit" }
  );
}

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`${path.relative(root, out)}  (${kb} KB)`);
