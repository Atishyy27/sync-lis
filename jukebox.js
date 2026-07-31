// Mehfil jukebox — resolves pasted links into playable audio on the server.
// yt-dlp handles YouTube/SoundCloud/etc; Spotify links are DRM'd, so they are
// resolved to metadata via Spotify's public oEmbed endpoint and auto-matched
// on YouTube (ytsearch). Local files skip all of this.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const MEDIA_DIR = path.join(__dirname, "media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// yt-dlp spawns are heavy (python + ffmpeg); cap concurrency so a paste-storm
// queues politely instead of forking a process tree per user.
const MAX_YTDLP = 3;
let ytdlpActive = 0;
const ytdlpWaiters = [];
async function ytdlpSlot() {
  if (ytdlpActive >= MAX_YTDLP) await new Promise((r) => ytdlpWaiters.push(r));
  ytdlpActive++;
}
function ytdlpRelease() {
  ytdlpActive--;
  const w = ytdlpWaiters.shift();
  if (w) w();
}

async function run(cmd, args, opts = {}) {
  const gated = cmd === "yt-dlp";
  if (gated) await ytdlpSlot();
  try {
    return await runNow(cmd, args, opts);
  } finally {
    if (gated) ytdlpRelease();
  }
}

function runNow(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.split("\n").find((l) => l.includes("ERROR")) || `${cmd} exited ${code}`));
    });
  });
}

function isSpotify(url) {
  return /^https?:\/\/(open|play)\.spotify\.com\//.test(url) || /^spotify:/.test(url);
}

// Spotify links arrive in many shapes (/track/ID, /intl-xx/track/ID,
// ?trackId=ID, spotify:track:ID); oEmbed only understands the canonical one.
function canonicalSpotify(url) {
  const m =
    url.match(/spotify:track:([A-Za-z0-9]+)/) ||
    url.match(/\/track\/([A-Za-z0-9]+)/) ||
    url.match(/[?&]trackId=([A-Za-z0-9]+)/);
  return m ? `https://open.spotify.com/track/${m[1]}` : url;
}

// Spotify -> "title artist" search text, via the public oEmbed endpoint (no auth).
async function spotifyToQuery(url) {
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(canonicalSpotify(url))}`);
  if (!res.ok) throw new Error("Could not read that Spotify link");
  const o = await res.json();
  if (!o.title) throw new Error("That Spotify link doesn't point at a track");
  return { query: o.title, thumb: o.thumbnail_url || null };
}

// Fetch metadata only (fast) — fills the queue card before the download finishes.
async function resolveMeta(url) {
  let target = url;
  let spotifyThumb = null;
  if (isSpotify(url)) {
    const s = await spotifyToQuery(url);
    target = `ytsearch1:${s.query}`;
    spotifyThumb = s.thumb;
  }
  const out = await run("yt-dlp", ["-J", "--no-download", "--no-playlist", target], { timeoutMs: 60000 });
  let info = JSON.parse(out);
  if (info._type === "playlist") info = info.entries && info.entries[0];
  if (!info) throw new Error("Nothing found for that link");
  return {
    target: info.webpage_url || target,
    title: info.title || "Unknown title",
    artist: info.artist || info.uploader || info.channel || "",
    duration: Math.round(info.duration || 0),
    thumb: spotifyThumb || info.thumbnail || null,
  };
}

// Download audio as m4a into media/<id>.m4a.
async function download(target, id) {
  const file = path.join(MEDIA_DIR, `${id}.m4a`);
  await run("yt-dlp", [
    "-f", "bestaudio/best",
    "-x", "--audio-format", "m4a", "--audio-quality", "0",
    "--no-playlist",
    "-N", "4",
    "-o", file.replace(/\.m4a$/, ".%(ext)s"),
    target,
  ], { timeoutMs: 300000 });
  if (!fs.existsSync(file)) throw new Error("Download produced no audio file");
  return file;
}

// Duration of an uploaded local file, via ffprobe.
async function probeDuration(file) {
  try {
    const out = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      file,
    ], { timeoutMs: 20000 });
    return Math.round(parseFloat(out.trim()) || 0);
  } catch {
    return 0;
  }
}

module.exports = { MEDIA_DIR, resolveMeta, download, probeDuration };
