# Where this stands — session handoff

_Written 1 Aug 2026, at the end of a long build session._

## What exists

Two products, one server, in `Desktop/codes masti/mehfil/`. Private repo at
**github.com/Atishyy27/sync-lis** (10 commits, email `sethatishayjain@gmail.com`,
`.cert/` and `media/` git-ignored).

**mehfil** — the website. The server fetches a pasted link's audio with yt-dlp
and streams it to everyone, clock-synced. Its whole reason to exist is that
nobody needs an install or an account: a phone on the wifi opens a link and
hears the music. Has queue, vote-skip, drag-drop files, chat, reactions,
avatars, wait-for-me holds, phone-first layout, and an access toggle (anyone on
this wifi / only with the link).

**sync-lis** — the Chrome extension. Everyone plays their own copy; only a clock
travels. Content-following moves the room between videos. Per-site adapters:
YouTube, YouTube Music (rides the YouTube adapter), Netflix, Prime, Hotstar,
Spotify, Apple Music, JioSaavn, SoundCloud, plus generic. Voice chat is peer to
peer. Now also carries **the jam**: a shared running order where everyone drops
links and they play one after another on each person's own account.

## Running it

- Server: `Start-Process node -ArgumentList "server.js" -WorkingDirectory <mehfil> -WindowStyle Hidden`.
  Never as a session background task — those get reaped and take the server with them.
- Public address: `https://desktop-ch7a7q7.tail5847e5.ts.net` via Tailscale Funnel.
  **After a reboot Tailscale sits in "NoState" until the tray app runs**, and the
  funnel config can drop; re-run `tailscale funnel --bg https+insecure://localhost:7777`.
  A dead relay makes every feature look individually broken.
- `npm test` runs everything: adapters, jukebox, sync rooms, co-watching, ten
  people, chaos, real-browser e2e, live sites. All green as of this writing.
- Extension zip built to `Desktop/sync-lis.zip` (31.6 KB).

## Design, after several rejected attempts

He rejected amber-v1 (too basic), navy/cyan, and VHS. The lesson was that the
problem was never colour: every version was the same flat stack of equal-weight
cards. The current panel answers **one question first — are we together** — as a
large light sentence over a track carrying a mark per person that separates when
someone lags. Everything else is demoted.

Palette is warm near-black with an amber accent (his v1 colours, which he
missed) and sage/red kept separate for sync state. **He specifically loves the
punctuation in the wordmark** — `mehfil.` / `sync-lis.` with the accent dot.

## Open, in his priority order

1. **Room-link page should be a loader**, not a page you look at. Half done: a
   "joining…" state exists, the hand-off does not.
2. **More screens / wider UX pass.** He says we have not gone through the screens
   properly. His framing of the product: "Google Meet + WhatsApp in the sidebar,
   plus Spotify Jam, and better than each."
3. **Netflix and Hotstar** are untested behind logins — identity is proven by URL
   shape only, ad markers are guesses from public class names. Needs his account.
4. **Voice is unverified end to end.** Server handshake is tested; nobody has
   heard anyone. Both sides must enable it.
5. Chrome Web Store as **Unlisted** ($5 once) — the only way to stop emailing
   zips, and Gmail blocks the zip anyway because it contains `.js`.

## Things that cost time, worth not rediscovering

- Chrome **cancels the `play` event** if anything pauses the video in the same
  tick, so transport intent is detected by comparing state, never by trusting
  events.
- `tabs.onUpdated` is an **unreliable way to wake an MV3 service worker**; a
  content-script message is the guaranteed path (`joinlink.js`).
- A port handler that closes over a session object **silently drops every command
  after a reconnect** while state keeps arriving.
- Test fixtures must serve **HTTP Range** or Chrome resets the video to 0, which
  looks exactly like a sync bug.
- Content changes must report **time 0**; carrying the player's reported position
  across a track change made every next Spotify song start where the last ended.
- Spotify's element is `now-playing-bar`, not `now-playing-widget`.
- Waiting for arrival needs a **ceiling** (20s) or one unscriptable tab freezes
  the room for everyone.

## Feedback docs

`FEEDBACK-01.md` and `FEEDBACK-02.md` hold his raw feedback dissected with
causes and status. `PLAN.md` holds the phased roadmap and the stack decisions
(including what we deliberately did not adopt, and why).
