# sync-lis — privacy policy

sync-lis lets a group watch or listen to the same thing together: each person
plays their own copy of a page (YouTube, Netflix, Spotify, or any site with a
video/audio player) and a shared clock keeps everyone at the same timestamp.

## What it accesses, and why

| Permission | Why sync-lis needs it |
|---|---|
| `host_permissions: <all_urls>` + `scripting` | The room can be started on **any** site that plays video or audio, not a fixed list — the "any site" case is the point of the extension. This is why the permission is broad: it injects a small script only into the tab you explicitly start or join a room on, never in the background on tabs you haven't opened a room for. |
| `tabs` | To find the tab you're watching in, and to navigate a joining tab to the same page the room is already on. |
| `storage` | Locally remembers your display name and avatar between sessions, on your own device only. |
| `offscreen` (+ microphone) | Voice chat. The microphone is opened **only** when you tap "Voice" on, and only for as long as it's on — never silently, never in the background. |
| Content script on `*://*/r/*` | Detects when you've opened a room-join link (any domain — a room can run on any relay server someone chooses to host, not one fixed address). It reads the URL only to notice the `/r/<code>` pattern; it takes no other action and injects no UI on any page that isn't a room link. |

## What is sent, where, and to whom

- **Nothing goes through sync-lis's developer or any third party.** Sync
  traffic (what's playing, playback position, chat messages, reactions, voice
  signaling) goes directly to the relay server configured for the room you're
  in — a small, self-hostable Node.js server anyone can run
  (see the [mehfil repo](https://github.com/Atishyy27/sync-lis) `server.js`).
- **The extension currently defaults to one specific relay
  (`desktop-ch7a7q7.tail5847e5.ts.net`), reachable via the developer's own
  Tailscale Funnel**, unless the room was started against a different one.
  That default is expected to change before wide release — see the open
  question below.
- **Voice is peer-to-peer (WebRTC).** Audio itself never touches the relay
  server at all — only the connection setup (who's calling whom) does. Voice
  is never recorded or stored anywhere.
- Chat history and room state live only in the relay server's memory for as
  long as the room is open; nothing is written to disk unless whoever runs
  that server chooses to add that themselves.
- No analytics, no ad networks, no data broker, no sale or sharing of any
  data collected, for any purpose unrelated to running the room you're
  actively in.

## What it does not do

- No tracking outside an active room.
- No access to browsing history.
- No credentials, payment info, or financial data collected.
- No use of your data to train any model.

## Contact

Questions: open an issue on the repository above.
