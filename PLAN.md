# mehfil + sync-lis — product & stack plan

_Written 30 Jul 2026. Revisit when a phase closes._

## The two products, decided (1 Aug 2026)

**The website is the room nobody has to install or sign into.** A phone on the
office wifi, a friend with no Spotify, a locked-down work laptop: they open a
link and they are hearing the music. That works only because the server plays
the audio itself, and it is the one thing the extension can never do. So the
site keeps its own job and gets the same room feel (waiting for people, chat,
reactions, presence, avatars) but stays audio-only and phone-first.

**The extension is for watching on your own accounts**, where the content
cannot be moved and everyone brings their own copy.

Not doing: video on the website (bandwidth, and the extension is better at it),
and video calling in the extension (it is a worse Meet with a film behind it).

## Where we actually are

Two products on one Node server, ~2,800 lines of our own code, two npm
dependencies, no build step. Every protocol path is machine-verified (100+
checks across five suites, chaos-tested to 12 users). **Almost nothing is
human-verified** — no real Netflix session, no real Spotify page, no two people
in a room with ears. That single gap, not any missing feature, is the biggest
risk in the project, and it decides the sequencing below.

## The two products, and the line between them

They share a server and a timing primitive. They differ on one axis only: **who
owns the media.**

|  | **mehfil** | **sync-lis** |
|---|---|---|
| Media lives | on our server | on each person's own account |
| Therefore | nobody needs a subscription or the file | works with Netflix, Prime, premium anything |
| Costs | bandwidth, disk, a machine that can fetch | almost nothing |
| Shape | group listening, one queue | two people, one timeline |
| Ceiling | needs a server + yt-dlp; ToS-grey; can never be a public service | distributable to anyone |

**Strategic call: invest in sync-lis.** It has a real outside-world path
(Teleparty has millions of users and three weaknesses we already beat: no music,
no cross-service following, no buffering handling). mehfil is an excellent
internal tool with a hard distribution ceiling — keep it sharp, keep it ours,
don't try to make it a product for strangers.

The one place they meet is already built: sync-lis's jam remote queues a tab
into mehfil. That's the right amount of integration; don't merge them further.

---

## Phase 0 — DONE (30 Jul 2026)

`npm test` now runs four protocol suites, the chaos harness, and a real-browser
end-to-end run: two Chrome profiles with the unpacked extension, a room created
from one and joined by clicking the link in the other, then content-following,
play/pause/seek, the injected panel, chat, and buffering holds — all asserted
against the actual players.

**It found eight real bugs on its first afternoon**, every one of which would
have hit a first real session:

1. **Wait-for-me deadlock.** A buffering hold paused the room, but the stall
   watchdog only ran while playing — so the hold could never clear and the room
   froze permanently.
2. **Room-link hijack.** A joiner's agent announced the room-link page itself as
   the room's content, dragging everyone off what they were watching. Now only
   pages with a real player may claim the room.
3. **Navigation never retried.** One failed follow-navigation marked the target
   as "in flight" forever, stranding the joiner on the link page.
4. **Unreliable MV3 wake-up.** `tabs.onUpdated` intermittently missed the
   room-link navigation entirely. Replaced with a content-script message, which
   is a guaranteed way to wake a sleeping service worker.
5. **Duplicate join.** Both wake paths raced, putting the same person in the
   room twice and orphaning their agent's port.
6. **Stale session on reconnect.** After a socket reconnect the port handler
   still referenced the old session, so every command was silently dropped while
   state kept arriving — "the controls just stopped working", undiagnosable in
   the wild.
7. **Play events cancelled.** Our own correction pausing the video in the same
   instant made Chrome cancel the `play` event, so the agent never learned the
   user pressed play: press play → instantly pauses, forever. Transport intent
   is now detected by comparing state, not by trusting events to arrive.
8. **Lock-out trap.** Link-only mode had no way back in without the key; the
   share link is now printed to the server console so it can always be
   recovered.

Two of the failures were the harness's own fault and worth remembering: the test
fixture served no HTTP Range (so Chrome silently reset the video to 0 instead of
seeking, which looks exactly like a sync bug), and one assertion was tighter
than the product's own ±8% correction tolerance.

**Still owed:** Netflix and Spotify runs need real logins, so they stay manual
for now (`storageState` can automate them later), and one human watch night.

## Phase 0 (original scope, for reference)

Nothing new ships until the thing we built is proven against real players.

- **Playwright harness** driving two persistent Chrome contexts with the
  unpacked extension loaded (`--load-extension` + `launchPersistentContext`;
  MV3 service worker reachable via `context.serviceWorkers()`). Assert
  *outcomes* — injected panel state, player position on both sides — not
  service-worker internals, since MV3 workers suspend after ~30s idle.
- Automated coverage on **YouTube** (no login needed): play/pause/seek
  propagation, content-following, ad-hold, drift under 500 ms.
- **Netflix and Spotify** need logins → saved `storageState`, run locally, not
  in any shared CI.
- Human acceptance: one real watch night, end to end.

**Exit:** the YouTube suite passes twice consecutively, and one real session runs
without anyone touching a control to fix sync.

_Why first: every phase below assumes the adapters work. Verifying by hand once
proves nothing about next week; a harness proves it every time._

## Phase 1 — It never mysteriously stops

The failures that kill trust are silent ones. We've already been bitten twice
(vanishing error cards, the secure-context trap).

- **Permanent URL** — Tailscale Funnel (free, no domain, no code change).
  Retires the ephemeral quick-tunnel and the "reload the extension" ritual.
- **rVFC drift measurement** — `requestVideoFrameCallback` reports the actual
  presentation timestamp; `currentTime` is quantized to ~40 ms, which is why our
  nudge thresholds sit at 0.25 s. Sharper measurement → tighter thresholds →
  visibly better sync on video. Small change, best sync-per-line in the plan.
- **Adapter health checks** — when a site's DOM shifts under us, say so in the
  panel ("can't control this player") instead of drifting quietly.
- **Session resume** — close the tab, reopen the link, land back in the room at
  the right second.

## Phase 2 — You'd pick it over Teleparty

- **Voice chat** — WebRTC audio between the room. For two people watching
  together this is the feature, not a nice-to-have. We already carry the
  music-grade WebRTC lineage in `core/` from the v2 era.
- **Room queue** — "next episode" so the night continues without renegotiating.
- **Richer presence** — tabbed away / back, so silence is explained.
- **Mobile, honestly** — Chrome on Android runs no extensions. sync-lis stays
  desktop; mehfil gets the phone story (it's already a web page).

## Phase 3 — Other people can get it

- **Chrome Web Store** — one-time $5 developer fee, review, a privacy policy,
  and a written justification for `<all_urls>` + scripting. Teleparty clears this
  bar, so it's passable, but budget a review cycle.
- **Onboarding without a zip** — install, click, room.
- **Privacy as the pitch** — we collect nothing and have no account system.
  Say so plainly; it's true and it's a real differentiator.

## Phase 4 — Ambition

- **PartyKit / Durable Objects relay** — each room becomes a Durable Object at
  the edge; sync-lis then works with your machine off. Free tier covers it, and
  WebSocket Hibernation means idle rooms cost nothing.
- **AudioWorklet + `getOutputTimestamp()`** for mehfil — sample-accurate
  scheduling and true output-latency calibration. This is the only path to two
  laptops on speakers in one room with no phasing.
- Bigger rooms: moderation, kick, per-person volume.

---

## Stack plan

**Keep (it's right):** Node + `ws`, no framework, no bundler, no database, no
build step. Vanilla JS front ends. Plain-Node test scripts. External binaries
(yt-dlp, ffmpeg) doing the heavy lifting. The whole dependency list is two
packages and that is a feature.

**Add now:** Playwright (dev-only) for real-browser testing.
`requestVideoFrameCallback` in the agent. Tailscale Funnel (no code).

**Add when the trigger fires:**
- PartyKit/Durable Objects → *when* sync-lis must work with the PC off.
- AudioWorklet + audio-clock calibration → *when* same-room speakers matter.
- A bundler → *only if* the extension exceeds roughly a dozen files.

**Deliberately not adopting, with reasons:**
- **WebAssembly** — nothing here is CPU-bound. We're quantized by media-element
  granularity, not slow. WASM would only pay off if we owned decoding.
- **WebCodecs** — true frame accuracy, but requires owning decode+render, which
  is impossible on DRM'd sites. Fine for our own media only.
- **timingsrc / Timing Object** — our `{paused, time, at}` is already their
  `{position, velocity, timestamp}` vector. Adopting the framework buys
  vocabulary we have and costs a dependency.
- **Croquet / Multisynq** — a deterministic VM producing bit-identical state
  across clients is a beautiful answer to a much larger question than ours.
- **React / any front-end framework** — would add a build step to save nothing.

## Risks worth naming

- **Site DOM drift** breaks adapters — Spotify is the most fragile (its
  `data-testid` values move). Mitigation: health checks (Phase 1) and
  fallbacks already in place.
- **Web Store review** may push back on `<all_urls>`. Mitigation: narrow host
  permissions to the sites we actually adapt, plus optional permissions for the
  rest, before submitting.
- **mehfil's fetching violates YouTube's ToS.** It stays a personal/office tool.
  It must never be distributed or hosted as a service for strangers. This is a
  hard line, not a caution.
- **MV3 service-worker suspension** kills the socket at ~30s idle; we reconnect,
  and Phase 0's harness must keep testing exactly that.

## Sequencing in one line

Prove it (0) → make it unbreakable (1) → make it lovable (2) → let others have
it (3) → get ambitious (4). Each phase is useful on its own; none of them
depends on a phase after it.
