# Launch drafts: sync-lis

Nothing here has been posted. Every post is his, from his own accounts, by hand.
Goal: the first 1,000 users, and their bug reports and UI notes (14 users on 24 Nov 2026, store page).
Every number below was measured on 24 Nov 2026; nothing here is a forecast.

## The market, measured

| What | Number | Source |
|---|---|---|
| Watch-together extensions on Chrome | about 12,000,000 users: Teleparty 10,000,000, Scener 1,000,000, Watch2Gether 900,000, TwoSeven 100,000 | store pages |
| Their ratings | Teleparty 4.0, Watch2Gether 3.5, TwoSeven 3.3, Scener 3.0 | store pages |
| Listen-together extensions | about 46 users in total: DaGrooveCync 18, Syncer 14, sync-lis 14 | store pages |
| Spotify | 788M monthly users, 499M of them free; free users cannot join a Jam remotely | Spotify Q3 2026 filing; Spotify Jam help |
| Discord | 200M+ monthly users; its Spotify Listen Along cannot be used during voice chat | Discord; Spotify help |
| Reviews per user at the incumbents | Teleparty 0.18%, Scener 0.037%, Watch2Gether 0.015% | store pages |

The last row is why feedback comes from the report link in the popup and the uninstall page, not store reviews: at those rates 1,000 users leave 0 to 2 reviews.

## The tracks

- **A. YouTube watch-together switchers.** Proven demand (12M installs) with weakly rated incumbents below Teleparty.
- **B. Free Spotify listeners who want to listen together.** 499M free accounts locked out of remote Jam; extension competitors here hold about 46 users. Demand is not measured yet: the posts measure it.
- **C. Listening plus voice.** Discord's own Listen Along blocks voice chat; sync-lis has voice built in.
- **D. His own network.** The only channel with a measured result: X DMs on 20 Nov brought 6 site visitors.

## What each channel did for similar products (measured)

- **Show HN:** title searches for watch or listen together, watch party and Spotify sync found 3-12 launches each, median 1-6 points. Outliers had a novelty angle (YouTube in a 3D world, 212 points; synced YouTube fitness, 143).
- **Product Hunt:** 2024-2026 listen-together launches got 0-20 upvotes and 2-26 followers. Older ones (2016-2020) got 104-313 upvotes.
- **Reddit audience sizes:** r/youtube 3,485,686; r/india 3,506,228; r/spotify 3,044,856; r/LongDistance 2,496,512; r/netflix 1,978,553; r/discordapp 1,550,224; r/SideProject 912,925; r/musicsuggestions 449,111; r/chrome_extensions 54,753. Size is reach, not installs; each post's result is read on the store dashboard.

Store: https://chromewebstore.google.com/detail/hcpjipoofgpnenpfjddkkodbobehonlb

## Before anything

- [ ] Run one real room between two different people on two different networks (not two tabs on one laptop): YouTube, then Spotify web, then Netflix. Note anything that breaks.
- [ ] Open a room link in a browser WITHOUT the extension and check the install page leads back into the same room.
- [ ] Record the clip (below). It goes in almost every post.
- [ ] Read each subreddit's self-promotion rules yourself before posting. Getting it wrong is a ban, not a correction.
- [ ] Check Cloudflare's free-tier limits for Workers and Durable Objects against the relay's dashboard numbers before a big post.

## The clip (20 seconds, OBS + CapCut, free)

Two browser windows side by side, labelled "me" and "friend". Start a room, paste the link in the other window, it jumps to the same second. Pause in one, both pause. Switch to a new video in one, the other follows. End on the store page. Captions only.

## The one-line pitch

Listen to Spotify in sync with friends, free, with voice. And watch YouTube together, at the same second. No screen share, so no quality loss. No account.

## The disclosure, said up front

Only a shared clock and room events go through the relay (a Cloudflare Worker). Your video, audio and screen never leave your browser. The relay logs counts and room codes, never content.

---

## 1. X (first, it already brought visitors on 20 Nov)

Post with the clip:

> built a chrome extension so my friends and i can listen to spotify together from different cities, free accounts too, with voice. send a link, it plays the same second for everyone. works for youtube too. tell me what breaks

(224 characters) Then reply to it with the store link, so the first post is not a bare link.

## 2. Batch and college WhatsApp groups (farewell season)

> made something for after college ends: sync-lis. you start a room on youtube or netflix, send the link, and everyone's tab plays the same second, pause and seek for everyone. voice chat built in. free, chrome or brave. [store link]

## 3. r/SideProject

**Title:** I built a watch-together extension where only a clock travels between you, not the video

**Body:** why (friends in different cities), the clip, what it does (same second, follows when someone switches video, waits when someone buffers, voice, 3-2-1 ready check), the disclosure, and an honest ask: "what breaks for you?". Link at the end.

## 4. Show HN

**Title:** Show HN: sync-lis, watch together by syncing a clock instead of streaming the video

**Body (engineering first):** each browser plays its own copy of the page, so DRM is irrelevant and quality is untouched. Clients reconcile against one server-owned transport state, so echoes are no-ops and late joiners land mid-scene. Small drift is fixed with plus or minus 8% playbackRate nudges instead of visible seeks. The relay is one Durable Object per room with WebSocket hibernation, so idle rooms cost nothing. Buffering anywhere pauses the room. Then the disclosure, then "happy to answer how the drift correction works".

## 5. Peerlist Launchpad (Indian devs, weekly launches)

Same pitch, the clip, three screenshots, the source link.

## 6. r/chrome_extensions

Short post: what it is, the clip, the store link. Read their rules first.

## 7. Product Hunt (last, once there are real reviews)

Tagline: "Watch and listen together, at the same second, from anywhere." First comment: the why, the disclosure, what is next.

## 8. r/LongDistance (strict: answer threads, do not launch)

Answer existing "how do you watch together?" threads honestly, mention it as one option, once.

---

## Finding people already asking (free)

F5Bot (f5bot.com) emails you when Reddit or Hacker News mention: "watch together", "watch party extension", "teleparty alternative", "sync youtube with friend". Reply by hand, only where it genuinely answers the question.

## What people will ask, and the honest answer

- **Why not Teleparty?** Check Teleparty's current feature list yourself first. Say only what you have checked: sync-lis works on any page with a normal video or audio player, has voice built in, and pauses the room when anyone buffers.
- **Is my data going through your server?** Only the clock and room events. The relay is open source in `worker/`.
- **Does Netflix work if it is DRM'd?** Yes, because nothing is streamed: each browser plays Netflix itself, and both people need their own account.
- **My friend does not have it.** The room link opens a page with the room code and a one-click install, then joins the same room.

## Every post ends the same way

Ask for what breaks, and point at the report link in the popup. The goal of the first 1,000 is the reports, not the count.

## Measure

After every post: weekly users and installs on the store dashboard, plus the relay's hourly snapshot (cnc Projects/synclis-relay-stats.csv) and uninstall reasons (evt "uninstall_reason" in Workers Logs). One line per post in cnc Projects/REVIEWS.md, so the channel that worked is known.
