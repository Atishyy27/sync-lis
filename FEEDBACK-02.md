# Feedback triage, round 2

Your words at the top of each item, then what is actually happening, then what
to do. Status is **confirmed** (found in the code or reproduced), **suspected**
(a mechanism that fits but is unproven), or **needs repro**.

The headline: this round is mostly not about the engine. The engine is fine.
This is about the experience, and about four small bugs that between them make
the room feel like it does not know who you are.

---

# A. The four bugs that make it feel broken

## A1. Everyone is called "friend" · confirmed · high

> "samne wale ka naam humesha friend ara h"

When you click a room link, the extension joins you silently, before you have
told it anything about yourself. It reads your saved name, finds nothing,
and falls back to the word "friend". Only the person who opened the panel and
typed a name ever gets a real one.

- The joiner never passes through the screen that asks for a name.
- The fallback is a constant, so every link-joiner in the world is "friend".
- Nobody is prompted afterwards either, so it never corrects itself.

**Fix:** join immediately (the link should still be instant), but the moment
you are in, the panel asks who you are, and the name updates live for everyone.
A room member's name has to be changeable after joining, which it currently is
not.

## A2. No avatars appeared at all · needs repro · medium

> "woset icons ek bhi nahi aye!"

Two candidates, and they are worth separating because the fix differs.

- Link-joiners never send an avatar at all (same root as A1), so their tile
  falls back to an initial.
- The picker itself only exists on the screen you see *before* joining, so once
  you are in a room there is no way to set or change it.

**Fix:** avatar lives in the room, editable at any time, same as the name.

## A3. Away and online stopped working · confirmed · high

> "away online wala jo bhi tha wo ab work ni krra pehle krra tha"

It regressed when the room moved into the side panel. The panel asks Chrome for
the active tab **once**, when it opens, and binds to that tab's room for its
whole life. Switch tabs and the panel is still describing the tab you left.

So the moment you go to another tab, which is exactly when "away" should light
up, the panel is looking at the wrong room and shows you nothing.

- The panel binds to a tab id at open time and never re-binds.
- Chrome's side panel is global, so it outlives the tab it was opened from.
- This one bug also explains the room feeling stale in other ways.

**Fix:** the panel follows the active tab, re-binding on every switch.

## A4. Rejoining reloaded everything · confirmed · medium

> "i leave room, teammate was in room, when i joined room it reloaded
> everything out of it"

Leaving closes the socket, and rejoining creates a fresh one. The server then
treats you as a brand new person and, because the room's content is already
set, immediately navigates your tab to it. So the tab reloads even though you
were already looking at the right thing.

- Rejoining should be a no-op when you are already on the room's content.
- The check exists for the person who *changes* content, not for a returning
  member.

**Fix:** on join, if the tab is already on the room's content, adopt it silently
instead of navigating.

---

# B. Spotify's timeline, and why "next" is broken

## B1. Next song inherits the previous song's timestamp · confirmed · high

> "spotify m next song krne par time stamp pichle wale ka ara hai" /
> "chalta hua gana skip next kro to whi se chalta h, pause karke next karo to 0
> se hota h"

Your reading is exactly right, and the mechanism is this: when the track
changes, we announce the new track together with *where the player currently
is*. On Spotify that reading is still the old song's position for a moment,
because the position display has not caught up. The server takes that number as
the new song's starting point, and everyone seeks there.

When you pause first, the position reads zero, so it works. That is why the two
cases behave differently.

- A content change should never carry a position from the previous item.
- Music players report position on a one second granularity, so the stale value
  survives long enough to be read.

**Fix:** a content change starts at zero, always. Position sync takes over a
moment later on its own.

## B2. Auto-next on Spotify is unusable · confirmed · high

> "spotify pr auto next audio chala hi ni skte qki wohi next song whi se play
> hoga jaha se last khtm hua"

Same root as B1, but worse, because the album rolls on by itself: every track
inherits the ending position of the one before, so by track four everyone is
three minutes into a two minute song.

**Fix:** B1's fix resolves it. Worth testing specifically with autoplay running,
since nobody presses anything in that flow.

---

# C. The experience, which is the real work

You said it yourself: not a repaint, a redesign of how it feels to use.

## C1. One screen was never the requirement · confirmed direction

> "kisne bola bas ek screen m sara kch rakh! u can have as manyyy"

Right now everything is stacked into a single column: invite, status, now
playing, people, chat, buttons. It is a list, not a product.

- Split into views: **Now**, **Room** (people, invite, settings), **Chat**.
- Persistent header stays: what's playing, who's waiting, the REC state.
- The bottom becomes navigation between views, not a row of four toggles.

## C2. The bottom four buttons are ugly and will not scale · confirmed

> "the bottom looks duh yuck 4 button! also 4 se kahi guna chize hongi!"

Voice, mute, ready, lock sit in one flat row, and everything new would join the
same row until it wraps into a mess.

- Transport-ish things (ready, lock) belong with the thing they affect.
- Voice and mute are a state, not a pair of buttons: one control that changes
  shape.
- Anything rare goes behind a single overflow, not on the surface.

## C3. Play and pause do not belong in the conversation · confirmed

> "y play pause to bhot hota rahega! like have a separate for that"

Every transport action currently writes a line into the same log as your
messages, so a two minute argument about a scene is buried under forty lines of
"pressed play".

- Chat is what people said.
- Activity is what people did, in its own quiet strip.
- Content switches stay in chat, because those genuinely are events.

## C4. Width will not go small enough · confirmed

> "width kam ni hoskta?"

Chrome enforces a floor on side panel width, so below a point it simply will
not shrink. What we control is whether it still looks right when narrow, which
is currently mediocre.

**Fix:** a genuinely compact mode, not a squeezed one: avatars only, times
hidden, controls collapsed to icons.

## C5. The on-page overlay is far too small · confirmed

> "wo beech m jo ata h na overlay while switching tab, wo bhot chotu h rn!"

The "waiting for..." line is a small pill at the top of the page. It is the one
piece of the product you see while actually watching, and it is the most timid
thing on screen.

**Fix:** make it a real moment. Dim the video slightly, show who everyone is
waiting for at a readable size, and get out of the way the instant it resolves.

## C6. The theme is not committing

> "theme se ni jara, use aur baddu bana like lage to kch!!"

The VHS idea is there in outline (scanlines, chroma split, a REC dot) but it is
applied politely. If the direction is a tape deck, it should look like one:
heavier type, real texture, chunky transport controls, a tape counter rather
than a plain clock, colour that commits.

---

# D. The fun, which is currently missing

> "wo jam wali masti kaha isme!" / "chat features are very limited"

## D1. Chat that is worth using

- An emoji picker, not five hardcoded buttons.
- GIFs (Tenor has a free key) and pasted images.
- Replies to a specific moment: "at 14:32 you said...".

## D2. Moments, not just messages

> "gifs ya certain things like drum rolls and wo sab, ya secret msg which gets
> shown ekdm se pop up hokr"

- **Sound stings**: a drum roll, an airhorn, a rimshot, played to everyone.
- **Big reactions**: an emoji sent large, filling the screen for a second.
- **Secret message**: written now, revealed to the room at a moment you choose,
  bursting onto the screen rather than scrolling past in a list.
- **Together moments**: both press ready and the countdown becomes an event.

## D3. Small things with outsized effect

> "chote chote features yess big heads!"

- Confetti when both people are in sync after a rough patch.
- A tape counter of how long you have watched together, all time.
- "You two have watched 14 things together."

---

# E. Still to verify

## E1. Netflix and Hotstar

> "netflix and hotstar test kar"

Neither can be reached logged out, so identity is proven by URL shape only.
What is untested: whether Netflix's player bridge actually drives seeks, and
whether Hotstar's ad markers are the ones I guessed from public class names.

## E2. Ads

> "ad ka ek wo dalde hold on kch"

Ads now hold the room, but nothing on screen says *why* everyone stopped. The
waiting overlay should name it: "waiting for Aditi, she's in an ad."

---

# Order I would build this in

1. **A1 to A4.** Four small bugs that make the room feel like it does not know
   you. Cheapest, most visible.
2. **B1.** One change, fixes Spotify's whole next-track story.
3. **C1 to C3.** The structural redesign: views, activity split from chat, a
   bottom bar that is navigation.
4. **C5, C6.** The watching-time overlay and a theme that commits.
5. **D.** The fun, once there is somewhere sensible to put it.
6. **E.** Netflix and Hotstar, with your login, since I cannot reach them.
