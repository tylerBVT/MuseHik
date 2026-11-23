# Cloud extras: design (2026-11-23)

Follow-up to the first real test on the LWS hosting (upload and playback worked).

## Why
- Her hosting has no traffic limit: the 10 GB/month cap only gets in the way. Storage (30 GB) stays capped.
- Songs put in `music/songs/` with FileZilla (by her) are invisible in the app, because the app only shows `library.json`.
- With more songs, the lists need sorting and a date filter; the date a song arrived should be kept.
- Sending a fresh download to the cloud takes two trips through the app today.

## Decisions (agreed in the conversation)
1. **No monthly cap.** The setting, the check and the traffic bar go. Traffic is still counted and shown as a plain
   line ("Moved this month: 1.2 GB"). The bar shows storage (of 30 GB), warning from 80 %.
2. **Hand-added songs show up (option 1).** Opening the Cloud page compares `music/songs/` with the list: audio files
   the list lacks are added (title and artist from the file name, split at " - "; date = the file's date on the server,
   or now), entries whose file is gone are dropped. `library.json` is only written when something changed.
   Only `music/songs/` is looked at. Uploads check the folder too, so they never overwrite a file added by hand.
   The first time such a song is played (downloaded to the cache), its tags fill in the real title, artist, album and
   length in the list. Deleting from the app works on them like on any song (it deletes the file).
3. **Sort and filter** on the Library and Cloud pages: sort by default order, title, artist, newest, oldest;
   filter by Any time, Last 7 days, Last 30 days, Last 12 months; the existing text search stays. The date shows in each row.
   Not on playlist pages (their order is the playlist's).
4. **Download dates in the library.** Each library song gets the date its file appeared on this laptop (file creation
   time, read once and kept). Songs copied in from another folder show the copy date.
5. **"Also send to the cloud" in the downloader.** A tick box, shown when the cloud is set up. When the download ends
   (done or stopped), the new songs plus the ones skipped as "already in your library" are uploaded (the upload skips
   what the cloud already has). If an upload is already running, they wait and go right after it. The songs stay
   on the laptop. The page says the upload started and links to the Cloud upload page.

## Approaches considered
- Hand-added songs: automatic on page open (picked: cheap, nobody has to remember) / a button / nothing.
- Monthly cap: remove (picked: she has no limit; git keeps it) / keep with 0 = none (a setting nobody needs).
- Download date: file creation time (picked: right for the 1000+ songs already there) / first-indexed time (all old
  songs would get the same day).

## Left to the builder
Exact wording and layout, within the existing page styles.
