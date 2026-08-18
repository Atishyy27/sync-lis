# Feedback triage, round 1

From the first real two-person session. Every item below is one of Atishay's,
kept in his words at the top, then diagnosed. Status is one of **confirmed**
(found in the code or reproduced), **suspected** (a mechanism that fits, not yet
proven), or **needs repro**.

---

## A. Infrastructure, and why it may explain several complaints

### A1. The public address silently died · confirmed · blocker

> "mehfil the website ka url didnt opened"

Reproduced. The site was refusing connections from outside while the server was
perfectly healthy locally. Cause: after the machine restarted, the Tailscale
daemon was running but stuck in a "starting" state, because on Windows the
background service waits for the tray application before it actually connects.
The funnel configuration itself had also been dropped ("No serve config").
Starting the tray app and re-running the funnel command fixed it.

Why this matters beyond one broken link: **while the relay is down, every part
of sync-lis looks individually broken.** Buttons do nothing, voice never
connects, the other person never follows you anywhere, and everything feels
laggy. Several items further down may have no separate cause at all.

Fix: make both the jam server and the Tailscale connection start with Windows,
and add a visible health check so a dead relay announces itself instead of
looking like a dozen unrelated bugs.

---

## B. Confirmed bugs

### B1. Nobody can see who is ready · confirmed · high

> "cannot see ready ka koi mark" / "ready indicator of samne wala person isnt
> visible in my screen! bigg issue!! if im the last person to click on ready to
> esa ajaye ki they're awaiting for me!"

Confirmed by reading the code. The server does track and broadcast each person's
ready flag; the panel simply never draws it. So the feature works and is
invisible, which is worse than not having it.

Fix: a mark next to each person who is ready, and a line at the top saying
"waiting for you" or "waiting for her", which is exactly what he asked for.

### B2. Ads stop the other person from following you · confirmed · high

> "a played another vdo, got an ad (i didnt get anything, still in old vdo)... ig
> ad to link initiate hone ke baad ata hai na! to jaise hi new vdo samne wala
> chalaye turant mere me bhi push kardeta"

Confirmed, and his diagnosis is right. Our agent refuses to announce what it is
playing while an ad is on screen. That rule exists for a good reason: during an
ad the player's position is the ad's position, not the video's, so syncing to it
would drag everyone to the wrong place. But it was applied too broadly, because
the *identity* of the video is perfectly well known during an ad; only the
*position* is meaningless.

So when he clicked a new video, YouTube started an ad, and the room was told
nothing until the ad finished. Meanwhile his partner sat on the old video.

Fix, in two parts:
1. Announce the new video immediately, ad or no ad. Only the position is
   withheld. This is his "turant push kardo".
2. Treat "watching an ad" as a hold, the same way buffering already is. The room
   pauses and waits for whoever is in an ad, then everyone starts together. This
   also handles the case he hit second, where the push worked but *he* then got
   an ad.

### B3. A scrollbar is showing in the panel · confirmed · cosmetic

> "scroll bar is visible, a chotu bug!"

The chat log scrolls, so the browser draws a default scrollbar. Fix is a few
lines of styling.

### B4. My own dot is always green · needs repro · medium

> "i am always green dot but incase of participants unka sahi hai"

The dot colour comes from the server's copy of your own flags, so in principle it
should behave the same for you as for everyone else. Two candidate mechanisms:
your own "away" can never be seen by you (you are away exactly when you are not
looking), and your own buffering may clear before the next repaint. Needs a
repro: buffer deliberately and watch your own row.

---

## C. Needs a live relay before diagnosing

These are the ones that a dead relay would produce on its own, so they get
retested before anyone writes code.

### C1. Voice does not work · unknown

> "voice doesn't works either" / "voice and mute wasnt working dk what was it
> intended for"

What it is meant to do: let the two of you talk over the video, with your
microphones, audio going directly between you.

The server side is tested (the handshake reaches the right person). The browser
side has never run for real. Also note the first time you turn it on, a small
sync-lis tab is supposed to open asking for the microphone; if that tab did not
appear, that is the specific thing to report.

### C2. Spotify did not open on the other person's side · suspected · high

> "i opened spotify and then opened this, but it just didnt opened! bigggg dikkat
> bhai ye to main chiz tha"

Most likely mechanism: our Spotify support identifies a track from the "now
playing" bar, which only exists once something is actually playing. If Spotify
was open but idle, there was nothing to announce, so nobody followed. A second
candidate is that the relay was down.

### C3. The bottom buttons do nothing · suspected

> "those bottom buttons are kinda like useless like nothing happens, beside lock,
> bt usme bhi it plays at first place"

Ready is invisible by B1, so it genuinely looks dead. Voice is C1. That leaves
the remark about Lock, which is not clear yet and needs one sentence from him.

### C4. Everything feels laggy · confirmed as a design limit · medium

> "the overall latency is there, in anything or eveyrhting!"

Real, and partly by design. The agent re-checks alignment on a two second
cycle, so anything that misses the instant path waits up to two seconds. Fix:
shorten the cycle to about half a second and make every local action send
immediately rather than waiting for the next check.

---

## D. Decisions needed before building

### D1. Make it a sidebar

> "it would be better if this is a sidebar! how about that!!!! sidebar, sidebar
> is actually"

Agreed, the floating panel covers the video. Two genuinely different options,
and the choice changes the work:

| | Chrome's own side panel | A docked sidebar we draw |
|---|---|---|
| Where it sits | Beside the page, browser-level | Inside the page, page shrinks |
| Covers the video | Never | Never, if we resize the page |
| Works on every site | Yes, identical everywhere | Depends on the site's layout |
| Survives navigation | Yes, it is not part of the page | Rebuilt on every page change |
| Cost | Medium, a new surface to build | Small, we already have the panel |

Recommendation: Chrome's own side panel. It cannot be broken by a website's
CSS, it stays put when you move between videos, and it is the thing people
already recognise.

### D2. Someone switches to a different platform mid-room

> "we both were on yt, i same tab me opened spotify but our player is synced?
> lmao, nice, but still ek to ghost seconds aynge kisi ek ke me, 2nd really dk
> what should happen there, suggestions pls!"

What happens today: whoever changes content drags everyone along, and the
timeline restarts at zero. Hence his "ghost seconds", where one side is briefly
playing the old thing at the old position.

Three options:
1. **Follow silently**, as now. Simplest, but jarring.
2. **Follow, but hold until everyone has arrived.** Nobody plays until both
   sides report they are on the new thing. Removes ghost seconds entirely.
   This is the same waiting machinery as buffering.
3. **Ask first.** "Aditi wants to switch to Spotify" with an accept button.
   Safest, but adds a click to something that should feel effortless.

Recommendation: option 2. It is invisible when it works, it reuses machinery we
already have, and it kills the exact symptom he described.

### D3. mehfil on the phone

> "website ka intent is ki handy (like phone se bhi kr sakte hai atleast sun
> sakte h)"

The site is already a plain web page, so a phone can open it and hear the music
today. The question is how much more should work there: queueing links, voting
to skip, dropping files. Needs one line from him on scope.

---

## E. New features requested

### E1. GIFs and images in chat

> "tenor//gif/image inchat dalne ka scene dede"

Pasting an image, and a Tenor search for GIFs. Tenor needs a free API key.
Medium sized, self-contained, and a good fit for the couch feeling.

### E2. mehfil does not wait for anyone

> "infront of extension the site isnt making any hold"

Correct, the website has no equivalent of "wait for me". If one person's audio
stalls, everyone else carries on. The machinery exists in the extension and
would port over.

---

## F. Answering the question in the middle

> "engine wagera kaha run krra h?"

Three places, and it is worth knowing which is which when something breaks.

- **Your machine** runs the server: the rooms, the queue, the clock everyone
  reads, and for the website the actual downloading and serving of audio.
- **Each person's browser** runs the agent: the thing that watches their player,
  reports what they are on, and nudges them back into line. There is one per
  tab, and it is invisible.
- **Between the browsers, with nothing in the middle**, runs voice. The server
  introduces you and then gets out of the way, which is why voice costs your
  machine nothing.
