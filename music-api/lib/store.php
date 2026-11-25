<?php
// The cloud folder the laptops fill over FTP: library.json (every song), playlists.json (shared playlists) and
// songs/. These functions are the only place that touches the two JSON files, so a database could replace them.
//
// Every change re-reads the file inside an exclusive lock, so two API requests never overwrite each other, and
// writes a temporary file then renames it, so a laptop reading over FTP never sees half a file. The laptops write
// over FTP without locks, but they also re-read just before writing (same risk as between the two laptops today).

function data_file(string $dataDir, string $name): string
{
    return rtrim($dataDir, '/\\') . '/' . $name;
}

/** Runs $fn while holding the cloud folder's write lock; returns what $fn returns. */
function with_lock(string $dataDir, callable $fn): mixed
{
    $handle = fopen(data_file($dataDir, '.music-api.lock'), 'c');
    if ($handle === false) throw new RuntimeException('Cannot open the lock file in the cloud folder.');
    flock($handle, LOCK_EX);
    try {
        return $fn();
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function read_json_file(string $path, array $empty): array
{
    if (!is_file($path)) return $empty;
    $raw = file_get_contents($path);
    if ($raw === false || trim($raw) === '') return $empty;
    $data = json_decode($raw, true);
    if (!is_array($data)) fail(500, basename($path) . ' on the server is damaged (not valid JSON).');
    return $data;
}

function write_json_file(string $path, array $data): void
{
    // Same text as the laptops' JSON.stringify: no escaped slashes or accents.
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    $temp = $path . '.tmp-' . bin2hex(random_bytes(4));
    if (file_put_contents($temp, $json) === false) throw new RuntimeException('Cannot write ' . basename($path) . '.');
    if (!rename($temp, $path)) {
        @unlink($temp);
        throw new RuntimeException('Cannot replace ' . basename($path) . '.');
    }
}

/** library.json: { version, nextId, songs: [...] }. */
function read_library(string $dataDir): array
{
    $index = read_json_file(data_file($dataDir, 'library.json'), ['version' => 1, 'nextId' => 1, 'songs' => []]);
    $index['songs'] = array_values($index['songs'] ?? []);
    $index['nextId'] ??= 1;
    return $index;
}

function write_library(string $dataDir, array $index): void
{
    $index['songs'] = array_values($index['songs']);
    write_json_file(data_file($dataDir, 'library.json'), $index);
}

/** playlists.json: { version, playlists: [ { uid, name, owner, updatedAt, songs } | { uid, deleted, updatedAt } ] }. */
function read_playlists(string $dataDir): array
{
    $doc = read_json_file(data_file($dataDir, 'playlists.json'), ['version' => 1, 'playlists' => []]);
    $doc['playlists'] = array_values($doc['playlists'] ?? []);
    return $doc;
}

function write_playlists(string $dataDir, array $doc): void
{
    $doc['playlists'] = array_values($doc['playlists']);
    write_json_file(data_file($dataDir, 'playlists.json'), $doc);
}

/** The index entry with this id, or null. */
function find_song(array $index, int $id): ?array
{
    foreach ($index['songs'] as $song) {
        if (($song['id'] ?? null) === $id) return $song;
    }
    return null;
}

/** Milliseconds since 1970, like the laptops' Date.now(). */
function now_ms(): int
{
    return (int) round(microtime(true) * 1000);
}
