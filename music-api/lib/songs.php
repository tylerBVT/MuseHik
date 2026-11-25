<?php
// Songs: list, stream, upload, rename, delete. Same rules as the laptops' cloud code (backend/modules/cloud/store.mjs).

const AUDIO_EXTS = ['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav'];

/** The same song is already on the cloud: 409, and the answer carries that song. */
class ConflictError extends ApiError
{
    public function __construct(public array $song)
    {
        parent::__construct(409, 'This song is already on the cloud.');
    }
}

/** A php.ini size ("8M", "1G", "512K") in bytes (PHP 8.1 has no ini_parse_quantity). */
function ini_bytes(string $value): int
{
    $value = trim($value);
    $unit = strtoupper(substr($value, -1));
    $n = (int) $value;
    return match ($unit) { 'G' => $n << 30, 'M' => $n << 20, 'K' => $n << 10, default => $n };
}

/** The path of a song's file inside songs/, refusing any name that could leave the folder. */
function song_path(string $dataDir, array $song): string
{
    $file = (string) ($song['file'] ?? '');
    if ($file === '' || $file === '.' || $file === '..' || strpbrk($file, "/\\\0") !== false) {
        fail(404, 'The song file is missing on the server.');
    }
    return data_file($dataDir, 'songs/' . $file);
}

/** Who "added" a song found in songs/ that no device uploaded (put there with FileZilla or the hosting's panel). */
const BY_HAND = 'added by hand';

/**
 * Brings library.json in line with the songs/ folder (the laptops' syncFolder): audio files it lacks join with what
 * their name says ("Artist - Title.mp3") and no length yet; entries whose file is gone leave. Unfinished uploads
 * (*.part.*) are ignored. An empty folder changes nothing (more likely a hiccup than every song deleted).
 * Returns [index, ['added' => n, 'removed' => n]].
 */
function sync_folder(string $dataDir): array
{
    return with_lock($dataDir, function () use ($dataDir) {
        $index = read_library($dataDir);
        $dir = data_file($dataDir, 'songs');
        $files = [];
        foreach (is_dir($dir) ? scandir($dir) : [] as $name) {
            $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
            if (!in_array($ext, AUDIO_EXTS, true) || preg_match('/\.part\.\w+$/i', $name)) continue;
            if (is_file("$dir/$name")) $files[$name] = "$dir/$name";
        }
        $counts = ['added' => 0, 'removed' => 0];
        if (!$files) return [$index, $counts];

        $kept = array_values(array_filter($index['songs'], fn ($s) => isset($files[(string) ($s['file'] ?? '')])));
        $counts['removed'] = count($index['songs']) - count($kept);
        $known = array_flip(array_map(fn ($s) => (string) $s['file'], $kept));
        foreach ($files as $name => $path) {
            if (isset($known[$name])) continue;
            $base = substr($name, 0, -strlen(pathinfo($name, PATHINFO_EXTENSION)) - 1);
            $dash = strpos($base, ' - ');
            $artist = $dash > 0 ? substr($base, 0, $dash) : '';
            $title = $dash > 0 ? substr($base, $dash + 3) : $base;
            $kept[] = [
                'id' => $index['nextId']++, 'file' => $name, 'title' => $title, 'artist' => $artist, 'album' => '',
                'duration' => 0, 'isrc' => null, 'key' => track_key($artist, $title), 'size' => filesize($path),
                'addedBy' => BY_HAND, 'addedAt' => gmdate('Y-m-d\TH:i:s', filemtime($path)) . '.000Z',
            ];
            $counts['added']++;
        }
        if ($counts['added'] || $counts['removed']) {
            $index['songs'] = $kept;
            write_library($dataDir, $index);
        }
        return [$index, $counts];
    });
}

/** GET /songs: the list, after picking up songs added or deleted by hand. */
function list_songs(array $config): void
{
    [$index, $synced] = sync_folder($config['dataDir']);
    json_out(['songs' => $index['songs'], 'synced' => $synced]);
}

/** GET /status: what the storage bar shows (also the laptops' "Test connection"). */
function cloud_status(array $config): void
{
    $index = read_library($config['dataDir']);
    $limit = $config['storageLimitGB'] * 1e9;
    json_out([
        'storedBytes' => array_sum(array_map(fn ($s) => (int) ($s['size'] ?? 0), $index['songs'])),
        'storageLimitBytes' => $limit == (int) $limit ? (int) $limit : $limit,
        'songs' => count($index['songs']),
    ]);
}

/** An ISRC from a form or a body: null when empty, 400 when it cannot be one. */
function clean_isrc(mixed $value): ?string
{
    if ($value === null) return null;
    if (!is_string($value)) fail(400, 'An ISRC is a short code like "FR10S2000001".');
    $value = trim($value);
    if ($value === '') return null;
    if (strlen($value) > 20) fail(400, 'That is too long.');
    return $value;
}

/** A length in seconds (whole numbers stay whole, like the laptops write them); 400 when it is not one. */
function clean_duration(mixed $value): int|float
{
    if (is_string($value) && is_numeric(trim($value))) $value = (float) trim($value);
    if (!is_int($value) && !is_float($value) || $value < 0 || !is_finite((float) $value)) {
        fail(400, 'The length must be a number of seconds.');
    }
    return $value == (int) $value ? (int) $value : (float) $value;
}

/** GET|HEAD /songs/{id}/file */
function song_file(array $config, array $params): void
{
    $song = find_song(read_library($config['dataDir']), (int) $params['id']);
    if (!$song) fail(404, 'No such song.');
    $path = song_path($config['dataDir'], $song);
    if (!is_file($path)) fail(404, 'The song file is missing on the server.');
    send_file_range($path, $_SERVER['REQUEST_METHOD']);
}

/** Length as JavaScript counts it (UTF-16 units), so limits match the laptops'. */
function js_length(string $s): int
{
    $n = 0;
    foreach (mb_str_split($s) as $c) $n += mb_ord($c) > 0xFFFF ? 2 : 1;
    return $n;
}

/** Like JavaScript's new Date().toISOString(): 2026-11-24T10:54:12.488Z */
function iso_now(): string
{
    $ms = now_ms();
    return gmdate('Y-m-d\TH:i:s', intdiv($ms, 1000)) . sprintf('.%03dZ', $ms % 1000);
}

/** "$base$ext", or "$base (2)$ext", "$base (3)$ext"... whichever is free (names compared ignoring case). */
function free_file_name(string $base, string $ext, array $takenLower): string
{
    $name = $base . $ext;
    for ($n = 2; isset($takenLower[mb_strtolower($name)]); $n++) $name = "$base ($n)$ext";
    return $name;
}

/** Every file name in use: the index's (except $exceptId's) and the files in songs/, lowercased as keys. */
function taken_names(string $dataDir, array $index, ?int $exceptId = null): array
{
    $taken = [];
    foreach ($index['songs'] as $song) {
        if ($song['id'] !== $exceptId) $taken[mb_strtolower((string) $song['file'])] = true;
    }
    $own = $exceptId === null ? null : mb_strtolower((string) (find_song($index, $exceptId)['file'] ?? ''));
    // scandir, not glob: glob reads [ ] in the folder's own path as a pattern and then finds nothing.
    $dir = data_file($dataDir, 'songs');
    foreach (is_dir($dir) ? array_diff(scandir($dir), ['.', '..']) : [] as $file) {
        $name = mb_strtolower($file);
        if ($name !== $own) $taken[$name] = true;
    }
    return $taken;
}

/** POST /songs (multipart: file, and optional title, artist, album, duration, addedBy). */
function upload_song(array $config): void
{
    $upload = $_FILES['file'] ?? null;
    if (!$upload) {
        $limit = ini_bytes((string) ini_get('post_max_size'));
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $limit && $limit > 0) fail(413, 'The file is too big for the server.');
        fail(400, 'Send the song in a "file" field.');
    }
    if (in_array($upload['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) fail(413, 'The file is too big for the server.');
    if ($upload['error'] !== UPLOAD_ERR_OK) fail(400, 'The upload did not arrive complete. Try again.');

    $original = (string) $upload['name'];
    $ext = strtolower(pathinfo($original, PATHINFO_EXTENSION));
    if (!in_array($ext, AUDIO_EXTS, true)) fail(415, 'Only audio files (.' . implode(', .', AUDIO_EXTS) . ') can be uploaded.');
    $size = (int) $upload['size'];
    if ($size > $config['maxUploadMB'] * 1e6) fail(413, "The song is bigger than {$config['maxUploadMB']} MB.");

    // Title and artist: from the form, else from the file name "Artist - Title.mp3" (like songs added by hand).
    $base = pathinfo($original, PATHINFO_FILENAME);
    $dash = strpos($base, ' - ');
    $title = text($_POST['title'] ?? null, 'title');
    $artist = text($_POST['artist'] ?? null, 'artist');
    $album = text($_POST['album'] ?? null, 'album');
    if ($title === '') {
        $title = $dash > 0 ? substr($base, $dash + 3) : $base;
        if ($artist === '' && $dash > 0) $artist = substr($base, 0, $dash);
    }
    if (js_length($title) > 200 || js_length($artist) > 200) fail(400, 'That is too long.');
    $duration = clean_duration($_POST['duration'] ?? 0);
    $isrc = clean_isrc($_POST['isrc'] ?? null);
    $addedBy = text($_POST['addedBy'] ?? null, 'addedBy') ?: $config['defaultAddedBy'];

    $dataDir = $config['dataDir'];
    $song = with_lock($dataDir, function () use ($dataDir, $config, $upload, $ext, $size, $title, $artist, $album, $duration, $isrc, $addedBy) {
        $index = read_library($dataDir);
        $candidate = ['title' => $title, 'artist' => $artist, 'duration' => $duration, 'isrc' => $isrc];
        foreach ($index['songs'] as $existing) {
            if (same_identity($candidate, $existing)) {
                throw new ConflictError($existing);
            }
        }
        $stored = array_sum(array_map(fn ($s) => (int) ($s['size'] ?? 0), $index['songs']));
        $limit = $config['storageLimitGB'] * 1e9;
        if ($stored + $size > $limit) {
            fail(413, sprintf('Not enough cloud storage: %.2f GB free of %s GB.', max(0, $limit - $stored) / 1e9, $config['storageLimitGB']));
        }

        if (!is_dir(data_file($dataDir, 'songs'))) mkdir(data_file($dataDir, 'songs'), 0775, true);
        $file = free_file_name(file_base($artist, $title), ".$ext", taken_names($dataDir, $index));
        // Written as "*.part.<ext>" first: the laptops ignore those until the rename makes the song appear whole.
        $part = data_file($dataDir, 'songs/' . substr($file, 0, -strlen(".$ext")) . ".part.$ext");
        if (!move_uploaded_file($upload['tmp_name'], $part)) throw new RuntimeException('Cannot store the upload.');
        if (!rename($part, data_file($dataDir, "songs/$file"))) {
            @unlink($part);
            throw new RuntimeException('Cannot store the upload.');
        }

        $song = [
            'id' => $index['nextId'], 'file' => $file, 'title' => $title, 'artist' => $artist,
            'album' => $album, 'duration' => $duration, 'isrc' => $isrc,
            'key' => track_key($artist, $title), 'size' => $size, 'addedBy' => $addedBy, 'addedAt' => iso_now(),
        ];
        $index['songs'][] = $song;
        $index['nextId'] = max($index['nextId'], $song['id']) + 1;
        write_library($dataDir, $index);
        return $song;
    });
    json_out($song, 201);
}

/**
 * PATCH /songs/{id}: { title?, artist?, genre? }, the laptops' editSong rules. A new title or artist renames the
 * file "Artist - Title" (never over another file), and shared playlists holding the song follow the new name.
 */
function edit_song(array $config, array $params): void
{
    $id = (int) $params['id'];
    $body = read_json_body();
    $dataDir = $config['dataDir'];
    $song = with_lock($dataDir, function () use ($dataDir, $id, $body) {
        $index = read_library($dataDir);
        $before = find_song($index, $id);
        if (!$before) fail(404, 'No such song.');
        $title = text($body['title'] ?? null, 'title', (string) $before['title']);
        $artist = text($body['artist'] ?? null, 'artist', (string) ($before['artist'] ?? ''));
        $genre = text($body['genre'] ?? null, 'genre', (string) ($before['genre'] ?? ''));
        if ($title === '') fail(400, 'A song needs a title.');
        if (js_length($title) > 200 || js_length($artist) > 200 || js_length($genre) > 60) fail(400, 'That is too long.');

        $file = $before['file'];
        if ($title !== $before['title'] || $artist !== ($before['artist'] ?? '')) {
            $dot = strrpos($before['file'], '.');
            $ext = $dot === false ? '' : substr($before['file'], $dot);
            $file = free_file_name(file_base($artist, $title), $ext, taken_names($dataDir, $index, $id));
            if ($file !== $before['file']) {
                $from = song_path($dataDir, $before);
                if (!is_file($from)) fail(404, 'The song file is missing on the server.');
                if (!rename($from, data_file($dataDir, "songs/$file"))) throw new RuntimeException('Cannot rename the file.');
            }
        }
        $after = array_merge($before, ['title' => $title, 'artist' => $artist, 'genre' => $genre, 'file' => $file,
            'key' => track_key($artist, $title)]);
        // Filled in by a laptop once it has the file of a song added by hand (its tags).
        if (array_key_exists('album', $body)) {
            $after['album'] = text($body['album'], 'album');
            if (js_length($after['album']) > 200) fail(400, 'That is too long.');
        }
        if (array_key_exists('duration', $body)) $after['duration'] = clean_duration($body['duration']);
        if (array_key_exists('isrc', $body)) $after['isrc'] = clean_isrc($body['isrc']);
        foreach ($index['songs'] as $i => $s) {
            if ($s['id'] === $id) $index['songs'][$i] = $after;
        }
        write_library($dataDir, $index);

        $doc = read_playlists($dataDir);
        [$doc, $changed] = rename_in_playlists($doc, $before, $after);
        if ($changed) write_playlists($dataDir, $doc);
        return $after;
    });
    json_out($song);
}

/** Playlist entries that were $before get $after's title, artist and key; changed playlists get a new updatedAt. */
function rename_in_playlists(array $doc, array $before, array $after): array
{
    $changed = false;
    foreach ($doc['playlists'] as $p => $playlist) {
        if (!empty($playlist['deleted'])) continue;
        $touched = false;
        foreach ($playlist['songs'] ?? [] as $i => $entry) {
            if (!same_identity($entry, $before)) continue;
            $doc['playlists'][$p]['songs'][$i] = array_merge($entry,
                ['title' => $after['title'], 'artist' => $after['artist'], 'key' => $after['key']]);
            $touched = true;
        }
        if ($touched) {
            $doc['playlists'][$p]['updatedAt'] = now_ms();
            $changed = true;
        }
    }
    return [$doc, $changed];
}

/** DELETE /songs/{id}: the file and the entry go; playlists keep the song (shown "not available"), like the laptops. */
function delete_song(array $config, array $params): void
{
    $id = (int) $params['id'];
    $dataDir = $config['dataDir'];
    with_lock($dataDir, function () use ($dataDir, $id) {
        $index = read_library($dataDir);
        $song = find_song($index, $id);
        if (!$song) fail(404, 'No such song.');
        $path = song_path($dataDir, $song);
        if (is_file($path) && !unlink($path)) throw new RuntimeException('Cannot delete the file.');
        $index['songs'] = array_filter($index['songs'], fn ($s) => $s['id'] !== $id);
        write_library($dataDir, $index);
    });
    json_out(null, 204);
}
