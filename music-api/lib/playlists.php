<?php
// Shared playlists, in the same playlists.json the laptops sync (backend/modules/cloud/playlistSync.mjs).

/** GET /playlists: live playlists only; each song carries the id of the matching cloud song (or null). */
function list_playlists(array $config): void
{
    // ?raw=1: the entries as stored, delete markers included (the laptops' sync needs them).
    if (($_GET['raw'] ?? '') === '1') {
        json_out(['playlists' => read_playlists($config['dataDir'])['playlists']]);
        return;
    }
    $songs = read_library($config['dataDir'])['songs'];
    $out = [];
    foreach (read_playlists($config['dataDir'])['playlists'] as $p) {
        if (!empty($p['deleted'])) continue;
        $out[] = playlist_view($p, $songs);
    }
    json_out(['playlists' => $out]);
}

function playlist_view(array $p, array $cloudSongs): array
{
    $songs = [];
    foreach ($p['songs'] ?? [] as $entry) {
        $match = null;
        foreach ($cloudSongs as $song) {
            if (same_identity($entry, $song)) { $match = $song['id']; break; }
        }
        $songs[] = $entry + ['songId' => $match];
    }
    return ['id' => $p['uid'], 'name' => $p['name'] ?? '', 'owner' => $p['owner'] ?? '',
        'updatedAt' => $p['updatedAt'] ?? 0, 'songs' => $songs];
}

/**
 * The songs of a playlist body, stored like the laptops store them: { id } is a cloud song (copied as title,
 * artist, album, duration, isrc, key); a full entry is kept as it is, so songs not on the cloud survive an edit.
 */
function playlist_songs(mixed $items, array $index): array
{
    if (!is_array($items) || !array_is_list($items)) fail(400, '"songs" must be a list.');
    $out = [];
    foreach ($items as $item) {
        if (!is_array($item)) fail(400, 'Each song is { "id": ... } or { "title": ..., "artist": ... }.');
        if (array_key_exists('id', $item)) {
            $song = is_int($item['id']) ? find_song($index, $item['id']) : null;
            if (!$song) fail(400, 'Unknown song ' . json_encode($item['id']) . '.');
            $item = $song;
        } elseif (text($item['title'] ?? null, 'title') === '') {
            fail(400, 'Each song is { "id": ... } or { "title": ..., "artist": ... }.');
        }
        $title = text($item['title'], 'title');
        $artist = text($item['artist'] ?? null, 'artist');
        $out[] = [
            'title' => $title, 'artist' => $artist, 'album' => text($item['album'] ?? null, 'album'),
            'duration' => clean_duration($item['duration'] ?? 0), 'isrc' => clean_isrc($item['isrc'] ?? null),
            'key' => text($item['key'] ?? null, 'key') ?: track_key($artist, $title),
        ];
    }
    return $out;
}

function playlist_name(mixed $name): string
{
    $name = text($name, 'name');
    if ($name === '' || mb_strlen($name) > 100) fail(400, 'A playlist name is 1 to 100 characters.');
    return $name;
}

/** UUID version 4, like the laptops' crypto.randomUUID(). */
function new_uid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

/** POST /playlists: { name, owner?, songs? } */
function create_playlist(array $config): void
{
    $body = read_json_body();
    $name = playlist_name($body['name'] ?? '');
    $owner = text($body['owner'] ?? null, 'owner') ?: $config['defaultAddedBy'];
    $dataDir = $config['dataDir'];
    $view = with_lock($dataDir, function () use ($dataDir, $body, $name, $owner) {
        $index = read_library($dataDir);
        $playlist = ['uid' => new_uid(), 'name' => $name, 'owner' => $owner, 'updatedAt' => now_ms(),
            'songs' => playlist_songs($body['songs'] ?? [], $index)];
        $doc = read_playlists($dataDir);
        $doc['playlists'][] = $playlist;
        write_playlists($dataDir, $doc);
        return playlist_view($playlist, $index['songs']);
    });
    json_out($view, 201);
}

/** The position of a live playlist in playlists.json, or 404. */
function playlist_position(array $doc, string $uid): int
{
    foreach ($doc['playlists'] as $i => $p) {
        if (($p['uid'] ?? null) === $uid && empty($p['deleted'])) return $i;
    }
    fail(404, 'No such playlist.');
}

/** PATCH /playlists/{uid}: { name?, songs? } */
function update_playlist(array $config, array $params): void
{
    $body = read_json_body();
    $dataDir = $config['dataDir'];
    $view = with_lock($dataDir, function () use ($dataDir, $body, $params) {
        $index = read_library($dataDir);
        $doc = read_playlists($dataDir);
        $i = playlist_position($doc, $params['uid']);
        if (array_key_exists('name', $body)) $doc['playlists'][$i]['name'] = playlist_name($body['name']);
        if (array_key_exists('songs', $body)) $doc['playlists'][$i]['songs'] = playlist_songs($body['songs'], $index);
        $doc['playlists'][$i]['updatedAt'] = max(now_ms(), ($doc['playlists'][$i]['updatedAt'] ?? 0) + 1);
        write_playlists($dataDir, $doc);
        return playlist_view($doc['playlists'][$i], $index['songs']);
    });
    json_out($view);
}

/**
 * PUT /playlists/{uid}: a laptop's sync sends a whole entry { name, owner, updatedAt, songs } or a delete marker
 * { deleted: true, updatedAt }. It is stored only when newer than what is here: "last change wins", decided under
 * the lock, so two laptops syncing at once never lose a change. Answers { applied, playlist } (what is stored now).
 */
function put_playlist(array $config, array $params): void
{
    $body = read_json_body();
    $updatedAt = $body['updatedAt'] ?? null;
    if (!is_int($updatedAt) || $updatedAt <= 0) fail(400, 'updatedAt must be a time in milliseconds.');
    $uid = $params['uid'];
    $dataDir = $config['dataDir'];
    $result = with_lock($dataDir, function () use ($dataDir, $body, $uid, $updatedAt) {
        if (($body['deleted'] ?? false) === true) {
            $entry = ['uid' => $uid, 'deleted' => true, 'updatedAt' => $updatedAt];
        } else {
            $entry = ['uid' => $uid, 'name' => playlist_name($body['name'] ?? ''),
                'owner' => text($body['owner'] ?? null, 'owner'), 'updatedAt' => $updatedAt,
                'songs' => playlist_songs($body['songs'] ?? null, read_library($dataDir))];
        }
        $doc = read_playlists($dataDir);
        foreach ($doc['playlists'] as $i => $existing) {
            if (($existing['uid'] ?? null) !== $uid) continue;
            if (($existing['updatedAt'] ?? 0) >= $updatedAt) return ['applied' => false, 'playlist' => $existing];
            $doc['playlists'][$i] = $entry;
            write_playlists($dataDir, $doc);
            return ['applied' => true, 'playlist' => $entry];
        }
        $doc['playlists'][] = $entry;
        write_playlists($dataDir, $doc);
        return ['applied' => true, 'playlist' => $entry];
    });
    json_out($result);
}

/** DELETE /playlists/{uid}: leaves { uid, deleted: true, updatedAt } so the laptops drop their copy too. */
function delete_playlist(array $config, array $params): void
{
    $dataDir = $config['dataDir'];
    with_lock($dataDir, function () use ($dataDir, $params) {
        $doc = read_playlists($dataDir);
        $i = playlist_position($doc, $params['uid']);
        $doc['playlists'][$i] = ['uid' => $params['uid'], 'deleted' => true,
            'updatedAt' => max(now_ms(), ($doc['playlists'][$i]['updatedAt'] ?? 0) + 1)];
        write_playlists($dataDir, $doc);
    });
    json_out(null, 204);
}
