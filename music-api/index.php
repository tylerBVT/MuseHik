<?php
// MuseHik music API: the phone's way into the cloud folder the laptops fill over FTP. Every request comes here
// (.htaccess on Apache, router.php under `php -S`). Config, key, CORS, routing and errors are handled once, here;
// each action is a small function in lib/.
declare(strict_types=1);

// LWS puts a cache in front of the site: without this it keeps answers given with the key and serves them to anyone.
header('Cache-Control: private, no-store');
ini_set('display_errors', '0'); // a PHP warning must never end up inside a JSON answer or an audio file
// Warnings become errors (a clean JSON 500), but "deprecated" notices from a newer PHP on the hosting must not
// break requests that work.
set_error_handler(function (int $no, string $message, string $file, int $line): bool {
    throw new ErrorException($message, 0, $no, $file, $line);
}, E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);

require __DIR__ . '/lib/http.php';
require __DIR__ . '/lib/rules.php';
require __DIR__ . '/lib/store.php';
require __DIR__ . '/lib/songs.php';
require __DIR__ . '/lib/playlists.php';

/** [method, path pattern, handler]. HEAD is answered by the GET route of the same path. */
const ROUTES = [
    ['GET', '#^/status$#', 'cloud_status'],
    ['GET', '#^/songs$#', 'list_songs'],
    ['POST', '#^/songs$#', 'upload_song'],
    ['GET', '#^/songs/(?<id>\d{1,9})/file$#', 'song_file'],
    ['PATCH', '#^/songs/(?<id>\d{1,9})$#', 'edit_song'],
    ['DELETE', '#^/songs/(?<id>\d{1,9})$#', 'delete_song'],
    ['GET', '#^/playlists$#', 'list_playlists'],
    ['POST', '#^/playlists$#', 'create_playlist'],
    ['PATCH', '#^/playlists/(?<uid>[A-Za-z0-9-]{1,64})$#', 'update_playlist'],
    ['PUT', '#^/playlists/(?<uid>[A-Za-z0-9-]{1,64})$#', 'put_playlist'],
    ['DELETE', '#^/playlists/(?<uid>[A-Za-z0-9-]{1,64})$#', 'delete_playlist'],
];

function load_config(): array
{
    $file = getenv('MUSIC_API_CONFIG') ?: __DIR__ . '/config.php';
    if (!is_file($file)) fail(500, 'The API is not configured (config.php missing).');
    $config = require $file;
    if (!extension_loaded('mbstring')) fail(500, 'The server needs the PHP mbstring extension.');
    $key = (string) ($config['apiKey'] ?? '');
    if (strlen($key) < 8 || str_starts_with($key, 'change-me')) fail(500, 'Set a real apiKey in config.php.');
    if (!is_dir((string) ($config['dataDir'] ?? ''))) fail(500, 'The dataDir in config.php is not a folder.');
    return $config + ['maxUploadMB' => 200, 'storageLimitGB' => 30, 'defaultAddedBy' => 'phone', 'allowedOrigins' => []];
}

/** The path after the API's own folder ("/songs"), decoded. */
function route_path(): string
{
    $path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    $base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    if ($base !== '' && str_starts_with($path, $base)) $path = substr($path, strlen($base));
    return '/' . trim(rawurldecode($path), '/');
}

function main(): void
{
    $config = load_config();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (handle_cors($config, $method)) return;

    $given = $_SERVER['HTTP_X_API_KEY'] ?? $_GET['key'] ?? '';
    if (!is_string($given)) $given = '';
    if ($given === '' || !hash_equals((string) $config['apiKey'], $given)) fail(401, 'Missing or wrong API key.');

    $path = route_path();
    $allowed = [];
    foreach (ROUTES as [$routeMethod, $pattern, $handler]) {
        if (!preg_match($pattern, $path, $params)) continue;
        $allowed[] = $routeMethod;
        if ($routeMethod === $method || ($method === 'HEAD' && $routeMethod === 'GET')) {
            $handler($config, $params);
            return;
        }
    }
    if ($allowed) {
        header('Allow: ' . implode(', ', array_unique([...$allowed, ...(in_array('GET', $allowed, true) ? ['HEAD'] : []), 'OPTIONS'])));
        fail(405, "$method is not allowed here.");
    }
    fail(404, 'Not found.');
}

try {
    main();
} catch (ConflictError $e) {
    json_out(['error' => $e->getMessage(), 'song' => $e->song], $e->status);
} catch (ApiError $e) {
    json_out(['error' => $e->getMessage()], $e->status);
} catch (Throwable $e) {
    error_log('music-api: ' . $e);
    if (!headers_sent()) json_out(['error' => 'Server error.'], 500);
}
