// Runs every suite against a server that must already be up (`npm start`).
// Protocol suites first (fast, deterministic), then the browser end-to-end.

const { execFileSync } = require("child_process");
const path = require("path");

const suites = [
  ["adapters: per-site identity", "adapters.js", []],
  ["spotify: buffering-noise vs real drift", "spotify-jitter.js", []],
  ["youtube: ad-end does not restart the room at 0", "youtube-ad.js", []],
  ["panel: on-page rendering + responsiveness", "panel-widths.js", []],
  ["popup: boot and create flow", "popup-boot.js", []],
  ["protocol: jukebox", "smoke-jukebox.js", [path.join(__dirname, "fixture", "tone.m4a")]],
  ["protocol: sync rooms", "smoke-sync.js", []],
  ["protocol: co-watching", "smoke-cowatch.js", []],
  ["room: ten people", "ten-people.js", []],
  ["chaos: 5 users", "chaos.js", ["5", path.join(__dirname, "fixture", "tone.m4a")]],
  ["browser: end to end", "e2e.js", []],
  ["browser: live sites", "live-sites.js", []],
  ["browser: voice (simulated mic, two real peers)", "voice-e2e.js", []],
];

// the jukebox suites need a tiny audio file; generate it once
const fs = require("fs");
const tone = path.join(__dirname, "fixture", "tone.m4a");
if (!fs.existsSync(tone)) {
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:a", "aac", "-b:a", "128k", tone], { stdio: "ignore" });
}

let failed = 0;
for (const [label, file, args] of suites) {
  console.log(`\n=== ${label} ===`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, file), ...args], {
      stdio: "inherit",
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    });
  } catch {
    failed++;
    console.log(`--- ${label} FAILED ---`);
  }
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
