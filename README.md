# mehfil 🎶

The office jukebox, self-hosted on your own IP. Paste a link — YouTube, Spotify,
SoundCloud — or drop an audio file, and it plays **for everyone on the LAN, in
sync**. One queue, no host, no accounts, no installs, no premium anything.

Nobody shares a screen and nobody captures audio: the **server fetches the track
itself** and every browser streams it from the server, clock-aligned.

```
server.js    HTTPS + WebSocket: rooms, queue + transport state machine (pause/
             resume/seek for everyone), media serving (Range), drag-drop upload
jukebox.js   link -> audio: yt-dlp resolve + download; Spotify -> oEmbed metadata
             -> auto-matched on YouTube (Spotify audio itself is DRM'd, unfetchable)
public/      the app: paste/drop -> card -> synced <audio> playback
extension/   synclist — a remote: queue the current tab in one click, control
             playback from any page (listening stays in the jam page)
core/        LEGACY (v2 aux/capture era) — kept for reference only
```

## Tests

```
npm start   # in one terminal
npm test    # in another
```

Four protocol suites, a chaos harness (random actions from many fake users), and
a **real-browser end-to-end run** — two Chrome profiles with the extension
loaded, a room created in one and joined by clicking the link in the other,
asserting content-following, transport sync, the panel, chat and buffering holds
against actual players. `npm run test:e2e` runs just the browser one; add
`--headed` to watch it happen.

## Requirements

- Node 18+, plus `yt-dlp` and `ffmpeg` on PATH (`winget install yt-dlp.yt-dlp`
  pulls both).

## Run

```
npm install
npm start
```

Share the printed wifi URL (e.g. `https://192.168.1.7:7777`). It's one jam per
server: open, enter a name, you're in. Two one-time clicks per device:

1. The cert is self-signed → browser warning → **Advanced → Proceed** (once).
2. Windows firewall prompt on the server machine → **Allow, private networks**.

**Who can join** is a toggle at the bottom of the page:
- *Anyone on this wifi* (default) — walk in, no code, nothing to send. The
  office case.
- *Only with the link* — for when this server is exposed to the internet:
  joining then needs a key that only the share link carries, and re-locking
  mints a fresh key so old links stop working.

(Power users: a `#hash` in the URL silently selects a separate jam; no UI for it.)

## sync-lis — watch & listen together, anywhere (the extension)

Not a LAN thing: this works between any two people on the internet.

**Her side:** open the video/track → click sync-lis → **Start a room** → Copy the
link → send it.
**His side:** click the link. The tab joins the room and jumps straight to what
she's playing, at her timestamp. From then on either person's play, pause or
seek moves both — and when she opens a different video or track, his tab
follows automatically.

Works on YouTube, Spotify web, Netflix, and any site with a normal `<video>`.
Ads are a hold, not a desync: sync freezes while one plays and resumes after.

### While you're watching

A panel rides along on the page (its own shadow root, so no site's CSS can
break it and ours can't leak):

- **Who's here, and how far off they are.** Each person shows a live drift
  readout, so "is it just me?" is answerable at a glance.
- **Wait for me.** If anyone's player starts buffering, the room pauses itself
  and resumes when they recover — the thing that actually ruins co-watching
  elsewhere. A deliberate pause during a hold is respected and not undone.
- **Voice.** Talk while you watch. Hit 🎙 Voice in the panel and your voices go
  straight between you, never through the server, with the echo cancellation and
  noise suppression that we deliberately strip out for music. Chrome asks for the
  microphone once, on the extension's own name rather than the website's, which
  is why it works on sites that block microphone access outright.
- **Chat and reactions**, stamped to the video's timestamp; reactions float up
  over the video on everyone's screen, and you can see when someone is typing.
- **Away.** Switch tabs and the room sees "away" next to your name, so a silence
  has an explanation.
- **Ready check.** Both press Ready, a 3-2-1 counts down, and playback is
  scheduled for a *future* instant so both sides start on the same tick instead
  of one chasing the other.
- **Host lock**, off by default: the room's opener can take sole control when
  someone keeps fumbling the seek bar. If the host leaves, host passes on and
  the lock is released, so a room can never end up stuck.

### The public address

The relay is this machine, exposed by **Tailscale Funnel** — a permanent
`https://<machine>.<tailnet>.ts.net` with a real, browser-trusted certificate.
No domain, no account beyond Tailscale's free tier, no code to run alongside it:

```
tailscale funnel --bg https+insecure://localhost:7777   # once, it persists
tailscale funnel status                                  # check
tailscale funnel --https=443 off                         # take it down
```

`https+insecure` refers only to the hop from Funnel to our own self-signed
server on localhost; the public side gets a genuine certificate, so nobody sees
a warning. Two consequences worth knowing: the address is reachable by anyone on
the internet (set the jam's access toggle to **Only with the link**), and your
machine has to be on.

`npm run relay` remains as a fallback for when Tailscale isn't available — it
opens a Cloudflare quick tunnel (no account, but a new URL every run) and
rewrites the extension's constant for you.

### Running the fallback relay

The room link points at a relay — your machine, exposed publicly by a Cloudflare
quick tunnel (real TLS, no account, no port forwarding):

```
npm start      # the server (jam + sync rooms)
npm run relay  # public link, baked into the extension automatically
```

`npm run relay` prints the public URL, writes it into `extension/popup.js`, and
tells you to reload the extension. **Keep that window open** — closing it kills
the public link, and the next run mints a different URL.

#### Getting a permanent free URL

The quick tunnel is ephemeral by design. Free ways to stop that, in order of
how well they fit:

1. **Tailscale Funnel** — free personal plan, gives a permanent
   `https://<machine>.<tailnet>.ts.net` with a real certificate, **no domain and
   no code changes**. One command (`tailscale funnel 7777`) replaces the quick
   tunnel. This is the right answer for mehfil, which has to run on your machine
   anyway (see below). Trade: your machine must be on.
2. **Cloudflare Tunnel, named** — permanent and free, but requires a domain you
   own on Cloudflare.
3. **Cloudflare Workers + Durable Objects** — free tier covers a relay this
   small, and WebSocket Hibernation means idle rooms cost nothing. This is the
   only option where sync-lis keeps working with your machine off. The relay is
   already rewritten as a Durable Object (`worker/`, ported in `8365768`) and
   passes locally under `wrangler dev` — it just isn't deployed yet, since that
   needs an interactive `wrangler login` (OAuth) followed by `wrangler deploy`.

**Why mehfil can't just be hosted somewhere:** YouTube blocks *fetching* from
datacenter IPs by reputation — the "Sign in to confirm you're not a bot" wall —
so a cloud-hosted jukebox fails constantly while the same code on your home
connection works. The jam therefore stays on your machine and gets exposed; only
sync-lis (which never touches media) is a candidate for cloud hosting.

### Installing it (both people)

`chrome://extensions` → Developer mode → **Load unpacked** → the `extension/`
folder. To send it to someone: share `sync-lis.zip`, they unzip and load the
folder the same way.

### How sync-lis works

Sturdier than Teleparty by design: clients reconcile against a single
server-owned transport state (echoes become no-ops, late joiners land mid-scene
correctly), and small drift is fixed by ±8% `playbackRate` nudges instead of
visible seeks. It drives each site's player and never touches the stream, so DRM
is irrelevant. The WebSocket lives in the service worker, out of reach of page
CSP, and rejoins automatically after network blips. Content-following is
key-based (`yt:<id>`, `sp:<id>`, `nf:<id>`), so echoing a key back is a no-op and
tabs can't ping-pong between videos.

Site-specific handling:
- **YouTube** — sync freezes during ads (`ad-showing` detection) and hard-resyncs
  after; otherwise an ad on one screen would drag the whole room around.
- **Netflix** — its player ignores direct `video.currentTime` writes; a bridge
  script injected into the page's MAIN world drives Netflix's internal player API
  (`seek/play/pause`), with `<video>` fallback if the API shape changes.
- **Spotify web** — no controllable `<video>`; the adapter drives the real
  controls (play/pause button, progress slider via the native value setter React
  respects) and identifies tracks from the now-playing widget. Positions are
  second-granular there, so tolerance is wider and there is no rate-nudging.
  Landing on a `/track/<id>` page presses its play button, since navigating alone
  doesn't start playback.
- **Prime & others** — decoy/preview `<video>` elements are filtered out (size,
  duration, playing-state scoring) so the agent controls the actual show.

**Jam remote** (collapsed in the popup). Connect to the LAN server once, then
**Queue this tab** from any music page — no link copying — plus pause/seek/skip
for the room. Listening itself happens in the jam page (a popup dies when it
closes; a remote shouldn't hum).

## How it works (the parts worth knowing)

- **Paste → card → play.** The server resolves metadata first (card appears in
  ~2s with title/art), downloads the audio as m4a, and auto-plays when the track
  reaches the head of the queue. Paste anywhere on the page — no need to find the
  input. First play of a fresh link takes ~15–30s (yt-dlp fetch); tracks queued
  behind something already playing are ready by their turn.
- **Spotify links**: audio is DRM-protected — impossible to fetch for any tool.
  We read the song's metadata from Spotify's public oEmbed endpoint and play the
  same song from YouTube, keeping Spotify's album art. YouTube fetching itself is
  against YT ToS — private-LAN gray zone, same as every listen-together tool.
- **Sync**: clients estimate the server-clock offset (median of ping samples) and
  keep `<audio>` at `(serverNow − startedAt)`; >0.4s off → seek, small drift →
  ±3% `playbackRate` nudge (inaudible). Late joiners land mid-song in the right
  place. Everyone is within a few tens of ms — headphone- and same-room-safe.
- **Skips**: majority vote skips; whoever queued the track can pull it instantly.
- **Local files**: drag-drop anywhere; the browser streams the file to the server
  in the background (sub-second on LAN) and ffmpeg normalizes it to m4a. No
  visible "upload" ceremony.
- Played files are deleted from `media/` after playing; queue-removed and
  owner-left entries are cleaned up too.

## The three-part explainer

**Capability:** `yt-dlp` already turns ~1000 sites' links into audio + rich
metadata; browsers already play HTTP-range-served m4a natively; Spotify's oEmbed
endpoint hands out track metadata without auth.

**What we did:** composed those into a queue state machine (fetching → ready →
playing → advance, errors auto-dropped), because nothing off-the-shelf does
*shared, synced, multi-user* queueing on a self-hosted LAN box. Replaced the whole
WebRTC/capture stack — capture was the wrong primitive (screen-share picker UX,
"Timeout starting video source" on some machines, sharer had to stay present).

**Optimized:** metadata resolved before download so cards render in ~2s while the
audio fetches; server-clock sync beats the old WebRTC path (late joiners work,
same-room speakers are safe, no per-listener connections); Range-capable serving
makes seeks/joins instant off the LAN. Deliberately naive elsewhere: in-memory
state, no DB, no build step.
