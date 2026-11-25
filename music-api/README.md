# MuseHik music API (PHP)

The only way into the cloud, for the laptops and the phone (since 2026-11-24 the laptops no longer use FTP). It
serves and edits the cloud folder (`library.json`, `playlists.json`, `songs/`) over HTTPS, with the same rules as
the laptops (`backend/core/lib.mjs`); the laptops' client is `backend/modules/cloud/api.mjs`. Plain PHP 8.1+ (json, mbstring; intl used when present), no
Composer, no database. Design: `docs/superpowers/specs/2026-11-24-music-api-design.md`.

## Files

| File | What |
|---|---|
| `index.php` | the only entry point: config, API key, CORS, routes, errors |
| `lib/` | `http.php` (JSON, CORS, byte ranges), `store.php` (the JSON files, locked), `rules.php` (song keys and file names), `songs.php`, `playlists.php` |
| `.htaccess` | Apache: every request → `index.php`; config, `lib/` and dot files never served |
| `router.php` | the same routing for PHP's built-in server (local tests) |
| `config.example.php` | copy to `config.php` (git-ignored) and fill in |
| `deploy.mjs` | uploads to LWS over FTP (TLS) and checks the live API (see below) |

## Endpoints

Every request needs the key: header `X-API-Key: <key>`, or `?key=<key>` (for `<audio>` elements, which cannot send
headers). Answers are JSON; errors are `{ "error": "..." }` with a real status code.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/status` | | `200 { storedBytes, storageLimitBytes, songs }` (storage bar, "Test connection") |
| GET | `/songs` | | `200 { songs: [...], synced: { added, removed } }`: audio files put in `songs/` by hand join first ("added by hand"), entries whose file is gone leave |
| GET, HEAD | `/songs/{id}/file` | `Range: bytes=...` optional | `200` / `206` audio, `416` bad range |
| POST | `/songs` | multipart `file` (+ `title`, `artist`, `album`, `duration`, `isrc`, `addedBy`) | `201` the song; `409 { error, song }` already there; `413` too big / cloud full; `415` not audio |
| PATCH | `/songs/{id}` | `{ title?, artist?, genre?, album?, duration?, isrc? }` | `200` the song (file renamed "Artist - Title", playlists follow) |
| DELETE | `/songs/{id}` | | `204` |
| GET | `/playlists` | | `200 { playlists: [ { id, name, owner, updatedAt, songs: [ {..., songId} ] } ] }` |
| GET | `/playlists?raw=1` | | `200 { playlists: [...] }` as stored (`uid`), delete markers `{ uid, deleted: true, updatedAt }` included (the laptops' sync) |
| PUT | `/playlists/{uid}` | `{ name, owner, updatedAt, songs }` or `{ deleted: true, updatedAt }` | `200 { applied, playlist }`: kept only when newer than the stored one ("last change wins", decided under the lock) |
| POST | `/playlists` | `{ name, owner?, songs?: [ {id} or {title, artist, ...} ] }` | `201` the playlist |
| PATCH | `/playlists/{id}` | `{ name?, songs? }` | `200` the playlist |
| DELETE | `/playlists/{id}` | | `204` (the laptops drop it at their next sync) |

## Run it on the laptop

```
cd backend
node tests/music-api-dev.mjs
```

It uses `%USERPROFILE%\MuseHikData\music-api-dev\music` as the cloud folder (filled on the first run with 5 songs of
your library and one playlist, through the laptops' real cloud code), PHP from `%USERPROFILE%\MuseHikData\php-8.1`
(or `MUSEHIK_PHP`), listens on port 8000 on the wifi too, and prints the address and the key. Your real cloud
settings are never touched. Delete the `music-api-dev` folder to start again.

The automated tests (`cd backend && npm test`, file `tests/music-api.test.mjs`) run the API against the laptops'
own code both ways; they are skipped when no PHP is found.

## Try every endpoint (PowerShell)

```powershell
$k = "<key printed by the dev script>"; $u = "http://127.0.0.1:8000"
curl.exe -H "X-API-Key: $k" "$u/songs"
curl.exe -H "X-API-Key: $k" -o song.mp3 "$u/songs/1/file"
curl.exe -H "X-API-Key: $k" -H "Range: bytes=0-99" -i "$u/songs/1/file" -o NUL
curl.exe -H "X-API-Key: $k" -F "file=@C:\path\Artist - Title.mp3" -F "addedBy=Tyler phone" "$u/songs"
curl.exe -H "X-API-Key: $k" -X PATCH -H "Content-Type: application/json" -d '{\"title\":\"New title\"}' "$u/songs/6"
curl.exe -H "X-API-Key: $k" -X DELETE "$u/songs/6"
curl.exe -H "X-API-Key: $k" "$u/playlists"
curl.exe -H "X-API-Key: $k" -H "Content-Type: application/json" -d '{\"name\":\"Road trip\",\"songs\":[{\"id\":1},{\"id\":2}]}' "$u/playlists"
curl.exe -H "X-API-Key: $k" -X PATCH -H "Content-Type: application/json" -d '{\"name\":\"Summer\"}' "$u/playlists/<id>"
curl.exe -H "X-API-Key: $k" -X DELETE "$u/playlists/<id>"
curl.exe "$u/songs"   # no key: 401
```

## On LWS (live since 2026-11-24)

`https://www.waixera.com/music-api`, next to the cloud folder `/music/` (denied to the web by its own `.htaccess`).
Hosting: PHP 8.5, mbstring, intl, upload limit 288 MB. Deploy or redeploy with:

```
cd backend && MUSEHIK_PHP=%USERPROFILE%MuseHikDataphp-8.5php.exe npm test   # the hosting's PHP version
node music-api/deploy.mjs            # --check: only check; --show-key: print the key; --new-config: new key
```

It reads the FTP credentials and the API key from `%USERPROFILE%MuseHikDatalws-deploy.json` (never committed),
uses FTP over TLS only (LWS's certificate is `*.lwspanel.com`, checked as such), writes `config.php` only on the
first deploy (a redeploy keeps the key), and ends with live checks.

LWS puts an edge cache in front of the site. Every answer sends `Cache-Control: private, no-store` (index.php and
.htaccess); without it the cache handed answers given with the key to requests without it. The deploy's live checks
test exactly that.
