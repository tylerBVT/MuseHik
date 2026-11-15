# MuseHik – Listening experience spec

> Status: **SPEC ONLY – nothing in sections P-2 to P-8 is built yet.** Waiting for the owner's review (see "Open questions" at the end).
> Written 2026-11-15. Update the status lines as work progresses.

## How to read the status lines

Every requirement ends with the same three lines:

- **Status:** `Done` (built), `Partial`, or `Todo`.
- **Automated tests:** `✅` + the test that covers it, `⚠️` partly covered, or `❌ not yet`. A ✅ means the test was actually run and passed.
- **Manually tested:** always `NO` until **the owner** tests it and changes it to `YES` themselves. Claude never sets this to YES.

## Goal

One main page dedicated to **listening**: every song in the library, click to play, it plays on to the next one by itself.
While something plays there is a small Deezer-style bar. Clicking it opens a full-screen player with the big cover, full title,
artist, seek bar, shuffle and repeat. The whole library behaves as one playlist ("All songs").

## Inspiration from the three reference apps (honest summary)

None of Harmony, OpenCrate or SongMirror plays audio (Harmony: "not a music player", delegates to Navidrome; SongMirror to Jellyfin).
There is **no playback code to copy**. What was found and is reused as UI/architecture patterns:

| Pattern | Where | Used for |
|---|---|---|
| Global floating mini widget that slides in/out (`translateY` + opacity transition, blurred glass background) and keeps living across pages | Harmony `base.html` / `app.js` / `app.css` ("mini-player") | The mini player's look, its slide-in/out and the rule that it lives **outside** page content so it survives navigation (P-3, P-1.3) |
| State that comes from one global stream and is shown in a small widget while you browse elsewhere | Harmony (SSE dashboard stream) | Download progress badge while you are on the Listen page (P-1.3) |
| Floating "+" button that opens the download dialog instead of a whole page | Harmony `global-fab` | "Add music" as a dialog on top of the Listen page (P-1.2) |
| Mobile-first responsive layout, square artwork (`aspect-ratio: 1 / 1`) | Harmony AGENTS.md / CSS | All new screens (P-8) |
| Durable state: remember things across restarts | Harmony (SQLite, durable jobs) | Remembering volume / shuffle / repeat / last song (P-7) |
| Player behaviours (auto-next, shuffle, repeat, mini → full screen) | **Deezer / Spotify conventions** (owner's reference) | P-2 to P-5 |

### Open-source players cloned for reference (in `reference/`, git-ignored, read-only)

Cloned on 2026-11-15 because the three downloader apps have no player.

| Project | Licence | What it gave us |
|---|---|---|
| **Feishin** (`reference/feishin`, React, desktop + web client) | **GPL-3.0 – behaviours only, no code copied** (copying code would make MuseHik GPL) | The rules below: shuffle as an index permutation next to the queue, repeat none/all/one, what "next" and "previous" do at the ends, previous restarts after 10 s, "skip ±10 s" buttons, the **mobile full-screen layout** (header with close button → big cover → title/artist → progress → previous / −10 s / play / +10 s / next → bottom row shuffle · repeat · queue), persisted player settings, Media Session handling |
| **angular-spotify** (`reference/angular-spotify`, Angular, Spotify clone) | **MIT – code may be reused with credit** | The Spotify-style three-column player bar (now playing left, controls centre with a round play button, volume right) and its small Angular component split (`player-controls`, `player-playback`, `player-volume`). It plays through Spotify's own SDK, so it has **no** shuffle/repeat/queue logic of its own to reuse |

Rules taken from Feishin (re-implemented in our own code):
- The **queue is never reordered**; shuffle keeps a separate list of positions (a permutation, Fisher–Yates with a secure random source).
  The current song is kept in place; songs added later are shuffled into the part *after* the current song only.
- **Repeat off** at the last song: playback **stops and the player returns to the first song, paused** (not "stay on the last song").
- **Repeat all** wraps in both directions (next from last → first, previous from first → last). **Repeat off** previous on the first song just restarts it.
- **Repeat one** only affects what happens when a song *ends*; the Next/Previous buttons still move.
- **Previous** restarts the song when it has played for a while (Feishin: 10 s, Spotify: 3 s – we keep **3 s**, as built), otherwise goes back.

## Scope

In: Listen page, queue = "All songs", auto-advance, mini player, full-screen player, shuffle, repeat, remembered settings,
media keys, tests.
Out (later, not in this spec): user-made playlists, editing the queue, sorting options, lyrics, equalizer, crossfade/gapless,
Android background playback, dark mode.

---

## P-0 What already exists (built and checked on 2026-11-15)

### P-0.1 Library list with covers and text search
Shows every indexed song (cover, title, artist, album, length); typing filters by title/artist/album.
- **Status:** Done
- **Automated tests:** ✅ `tmpBack/ui-check.mjs` › "library lists all songs from the server", "search narrows the list"
- **Manually tested:** NO

### P-0.2 Click a song to play it; basic controls
Play/pause, previous (restarts the song if more than 3 s in), next, seek bar, volume, current song highlighted.
- **Status:** Done
- **Automated tests:** ✅ `ui-check.mjs` › play, clock advances, seek, pause/resume, next, previous (restart and go back), volume slider
- **Manually tested:** NO

### P-0.3 Audio streaming with seeking and cover art
`GET /api/library/:id/stream` supports HTTP Range; `/cover` returns the embedded picture or 404.
- **Status:** Done
- **Automated tests:** ⚠️ checked by hand with curl during development; no committed test yet (see P-9.3)
- **Manually tested:** NO

### P-0.4 Media Session (media keys / "now playing" info)
Title, artist, album, artwork and play/pause/next/previous/seek handlers are registered.
- **Status:** Done
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

---

## P-1 Pages and navigation

### P-1.1 The main page is the Listen page
Opening the app shows the song list first (this is the home page). "All songs" is shown as the playlist title with the song
count. Downloading is no longer the first thing on the page.
- **Status:** Todo (today the download card sits on top of the list)
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-1.2 "Add music" is a dialog opened from a button
A "+ Add music" button in the page header (floating "+" on phones, like Harmony's FAB) opens the existing download form in a dialog.
Esc / the close button / clicking outside closes it. Closing it never stops a running download.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-1.3 Downloads keep running while you listen
Download state moves out of the dialog component into an app-wide service, so closing the dialog (or anything else) does not lose
progress. While a download runs and the dialog is closed, a small progress chip in the header shows `done / total` and opens the dialog on
click (Harmony's global widget idea). When it finishes the song list refreshes by itself (already true today).
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-1.4 The player never interrupts navigation
Opening/closing the dialog or the full-screen player never pauses or restarts the music.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

---

## P-2 "All songs" as a playlist (queue behaviour)

### P-2.1 The queue is the list as shown
Playing a song makes the **currently displayed order** the queue (full library, or the search results if a search is active).
Order today: artist A→Z, then title.
- **Status:** Done
- **Automated tests:** ⚠️ `ui-check.mjs` › "next plays the following song" covers the order; search-scoped queue is not tested
- **Manually tested:** NO

### P-2.2 Auto-advance
When a song ends, the next song in the queue starts by itself. No pause, no click.
- **Status:** Done in code (`ended` → `next()`), **never tested**
- **Automated tests:** ❌ not yet (needs short fixture songs, see P-9.2)
- **Manually tested:** NO

### P-2.3 End of the queue
Repeat off: after the last song ends the player **stops and goes back to the first song, paused** (Feishin/Spotify behaviour).
Repeat all: it carries on with the first song. Repeat one: see P-5.
- **Status:** Partial (stops today; no wrap and it stays on the last song)
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-2.4 Unplayable song is skipped
If a song fails to load (file deleted, corrupt) a short message is shown and the player moves on to the next song. Never an endless
skip loop: if every song in a row fails (limit: the queue length) it stops with the message.
- **Status:** Todo (today it shows a message and stays)
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-2.5 Library changes while playing
A download that adds songs refreshes the list but does **not** interrupt the current song; the queue keeps its order and the new
songs join it. If the playing song is removed from disk, P-2.4 applies.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

---

## P-3 Mini player (Deezer-style small bar)

### P-3.1 Appears when a song starts, hidden before
Slides up from the bottom when the first song is played (fade + slide, 250–350 ms, like Harmony's mini widget; no animation if the
user prefers reduced motion). Hidden until then.
- **Status:** Partial (appears without animation)
- **Automated tests:** ⚠️ `ui-check.mjs` › "player bar hidden before anything plays" and "appears with the clicked song"
- **Manually tested:** NO

### P-3.2 Content and controls
Small cover, title and artist (one line each, ellipsis), **play/pause** and **next** buttons, and a thin progress line along the top edge.
Previous, seek bar and volume are **not** in the mini bar on phones; on wide screens they may stay (today's bar) – owner to confirm.
- **Status:** Partial (today's bar has everything, no progress line)
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-3.3 Tap/click opens the full-screen player
Clicking the cover or the title area opens P-4. The buttons keep their own action and do **not** open full screen.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-3.4 Stays visible and in sync everywhere
Always at the bottom, above the list, over the dialog's backdrop. Play/pause state, title and progress match the full-screen player at all times.
- **Status:** Partial
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

---

## P-4 Full-screen player

### P-4.1 Opening and closing
Opens from the mini bar (P-3.3) with a slide-up; closes with a down-chevron button, the **Esc** key, or the browser Back button.
The song keeps playing without a glitch. It is an ARIA dialog; focus moves inside when it opens and returns to the mini bar when it closes.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-4.2 What it shows
Large square cover (`aspect-ratio: 1/1`, placeholder note if none), the **full title** (wraps over several lines, never cut off),
the artist, the album, and a background tinted/blurred from the cover.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-4.3 Controls
Layout copied from the mobile full-screen players of Feishin/Spotify: header row with a close (down-chevron) button, big cover,
title and artist, seek slider with elapsed and total time (jump to any moment; dragging shows the time live and only jumps on
release), then the main row **previous · −10 s · play/pause · +10 s · next**, then a bottom row **shuffle · repeat**, and volume
(desktop only). A "queue" button is *not* part of this spec (queue editing is out of scope).
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-4.4 Keyboard shortcuts (while the full-screen player is open)
Space = play/pause, ←/→ = back/forward 5 s, Shift+←/→ = previous/next song, ↑/↓ = volume, Esc = close.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

---

## P-5 Shuffle and repeat

### P-5.1 Shuffle
Toggle in the full-screen player (and visible state in the mini bar). Implementation (from Feishin): the queue itself is never
reordered; a separate **permutation of positions** (Fisher–Yates, secure random) says which comes next, with the current song first,
so nothing jumps. "Previous" goes back through what was actually played (history), not through the random order. Every song plays
once before any repeats (a full pass). When turned off: the list order returns and playback continues from the current song's
position in it. Playing a different song from the list while shuffle is on reshuffles with that song first. Songs added to the
library meanwhile are shuffled into the part after the current song.
- **Status:** Todo
- **Automated tests:** ❌ not yet (planned as pure unit tests on the queue module, P-9.1)
- **Manually tested:** NO

### P-5.2 Repeat (three states)
One button cycling **off → all → one → off**, with a different icon/label for each state.
- off: stops after the last song and returns to the first, paused (P-2.3). Previous on the first song just restarts it.
- all: after the last song it starts again from the first (a new reshuffle if shuffle is on). Previous on the first song goes to the last.
- one: the current song restarts when it ends. The **Next** and **Previous** buttons still move to another song manually.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-5.3 Shuffle and repeat together
All combinations work: shuffle+all keeps going forever without repeating before a full pass is done; shuffle+one repeats the same song.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

---

## P-6 Media keys, lock screen

### P-6.1 Media Session stays accurate
Keyboard media keys and the OS "now playing" control work for play/pause/next/previous/seek, with title, artist, album, cover; position
state is published so the OS seek bar moves. Required later for Android background playback.
- **Status:** Partial (see P-0.4; no position state)
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

---

## P-7 Remembered settings (durable state)

### P-7.1 Volume, shuffle and repeat persist
Saved in the browser's `localStorage` (every access wrapped in try/catch; works without it). Restored at startup.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-7.2 Last song is remembered
After a reload the mini player shows the last song at its last position, **paused** (never auto-plays on load; browsers forbid it anyway).
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

---

## P-8 Look, accessibility, responsiveness

### P-8.1 Responsive
Usable from 360 px wide (phone) to desktop. List rows, mini bar and full screen each have a phone layout. Touch targets ≥ 44 px.
- **Status:** Partial (list and bar have a phone layout; full screen does not exist yet)
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-8.2 Accessibility
Everything reachable and usable with the keyboard, visible focus, buttons have labels (`aria-label`), sliders have names and values,
changes of state announced politely (`aria-live`), animations off under `prefers-reduced-motion`.
- **Status:** Partial
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-8.3 Empty and error states
Empty library ("paste a link to add music"), server unreachable message, no search results: all exist already.
- **Status:** Done
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

---

## P-9 Automated tests (the plan)

Four layers, all runnable offline with one command each. No test touches the owner's real library or internet.

### P-9.1 Unit tests of the queue logic (fast, no browser)
Move the "what plays next" rules out of the player into a **pure module** (`core/queue.ts`): `nextIndex`, `previousIndex`,
`shuffleOrder`, repeat handling. Tested with Vitest (`ng test`), including: end of queue, repeat all/one, shuffle keeps the current
song first, a full shuffle pass has no repeats, history-based previous, toggling shuffle off restores order, reshuffle on new pick.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-9.2 Player service and components with a fake audio element
`PlayerService` gets its audio element through an injection token, so tests can use a fake (`play`, `pause`, `currentTime`, events
`ended`/`error`/`timeupdate`). Tests: auto-advance on `ended`, skip on `error` with the loop limit, persisted settings, Media Session calls;
component tests for mini bar, full-screen open/close/Esc, buttons and aria labels.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-9.3 Server tests (`node --test`)
List endpoint order, `stream` full + Range (206, 416, suffix ranges), `cover` 200/404, unknown id 404, library scan add/remove, duplicate
detection (`findDuplicate`), against a temporary folder and database.
- **Status:** Todo
- **Automated tests:** ❌ not yet
- **Manually tested:** NO

### P-9.4 Real-browser end-to-end tests (extends `ui-check.mjs`)
A script starts its **own** server on another port with a **temporary** music folder holding 3–4 tiny generated MP3s
(a few seconds each, made by the bundled ffmpeg) and a temporary database, then drives Chrome:
song ends → next plays by itself, last song ends (repeat off/all/one), shuffle order and history, mini → full screen → close,
Esc and Back, keyboard shortcuts, remembered settings after reload, skip of a broken file. The Angular app needs a way to point at
that server (a `?api=` URL parameter). The existing 13 checks stay.
- **Status:** Partial (13 checks exist against the real library; fixture-based tests do not)
- **Automated tests:** ⚠️ `ui-check.mjs` (13/13 passed on 2026-11-15)
- **Manually tested:** NO

### P-9.5 Manual test sheet
At the end of the work Claude produces a checklist of the above for the owner to walk through, in a phone-sized and a desktop-sized window.
Only the owner changes "Manually tested" to YES.

---

## Build order (one feature at a time, each ends with tests)

1. **Queue module + player refactor** (pure logic, fake audio, server tests) – no visible change, makes everything else testable. P-9.1–9.3, P-2.2–2.4.
2. **Repeat and shuffle** in the player logic. P-5.
3. **Listen page + dialog + app-wide download service.** P-1.
4. **Mini player redesign.** P-3.
5. **Full-screen player** with seek, shuffle, repeat, shortcuts. P-4.
6. **Remembered settings, Media Session position.** P-7, P-6.
7. **Fixture-based browser tests and the manual test sheet.** P-9.4–9.5.

## Open questions for the owner

0. **Licensing, FYI:** I copy code only from the MIT project (angular-spotify). Feishin is GPL-3, so I only reproduce its *behaviour*. OK?
1. **Add music as a dialog (my proposal) or as a separate page** (`/add`) with a top menu? The dialog keeps the listening page the one and only page.
2. **Mini player on desktop:** only cover, title, play/pause, next, progress line (Deezer-like), or keep the full set of controls (previous, seek, volume) there?
3. **Shuffle "previous":** go back through what really played (my proposal, like Spotify) – OK?
4. **Refactor for testability** (queue module + audio injection) before building the visible features – OK?
5. **Repeat default** is off; shuffle default is off – OK?
