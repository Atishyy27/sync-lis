# Chrome Web Store listing — copy-paste fields

Everything below goes into the Developer Dashboard at submission time, not
into `manifest.json` — the manifest only needs the (already-correct)
`permissions` array; the dashboard needs the *justification* for each.

## Single purpose (required, ~short)

> Watch or listen to the same video/audio as someone else, at the same
> timestamp, each on your own copy of the page — no screen sharing, no
> shared account, no host.

## Permission justifications (one box per permission in the dashboard)

**Host permission `<all_urls>`**
> The extension syncs playback on whatever site a room's members are
> watching — not a fixed list of sites — so it needs to be able to run on
> any page a user explicitly starts or joins a room on. It never runs
> automatically on tabs that aren't part of an active room.

**`scripting`**
> Used to inject the sync script into the specific tab the user starts or
> joins a room on, on demand — never automatically, never in the background.

**`tabs`**
> Used to find the tab currently in a room and to navigate a joining
> member's tab to the same page the room is already watching.

**`storage`**
> Stores the user's display name and avatar locally on their own device, so
> they don't have to retype it every session.

**`offscreen`**
> Hosts the WebRTC voice connection and microphone access, which a
> Manifest V3 service worker cannot hold directly. Microphone access is
> requested only when the user explicitly turns voice on.

**`audioCapture`**
> Required to call getUserMedia() for the voice-chat microphone. Voice is
> opt-in per session; nothing is captured until the user turns it on, and
> audio goes peer-to-peer (WebRTC), never through any server we operate.

## Data usage disclosure (the checkbox grid)

- **Website content** — Yes (page URL/title of the tab in an active room,
  read only while syncing).
- **Personally identifiable information** — No (display name is
  user-chosen, stored locally only, never tied to any real identity).
- **Health, financial, authentication info** — No.
- **Location** — No.
- **User activity** — No (nothing tracked outside an active room).
- **Web history** — No.
- Certify: *not* sold to third parties, *not* used for purposes unrelated to
  the single purpose above, *not* used for creditworthiness/lending
  decisions.

## Privacy policy URL

Point this at wherever `PRIVACY.md` (same folder) ends up hosted publicly —
not decided yet, see the open question raised alongside this file.
