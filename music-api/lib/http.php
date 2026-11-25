<?php
// Requests and answers: JSON, errors, CORS for the phone app, and audio files sent whole or by byte range.

/** A refusal with its HTTP status; index.php turns it into { "error": message }. */
class ApiError extends Exception
{
    public function __construct(public int $status, string $message)
    {
        parent::__construct($message);
    }
}

function fail(int $status, string $message): never
{
    throw new ApiError($status, $message);
}

function json_out(mixed $data, int $status = 200): void
{
    http_response_code($status);
    if ($status === 204) return;
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/**
 * A text field from a body or a form, trimmed: null gives $default, numbers become text, anything else (a list, an
 * object, true/false) is a 400 rather than a PHP warning turned into a 500.
 */
function text(mixed $value, string $name, string $default = ''): string
{
    if ($value === null) return $default;
    if (!is_string($value) && !is_int($value) && !is_float($value)) fail(400, "\"$name\" must be text.");
    return trim((string) $value);
}

/** The request body as an object; an empty body is an empty object. */
function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) fail(400, 'The body is not valid JSON.');
    return $data;
}

/**
 * CORS: the app runs inside the phone at https://localhost, so the WebView asks permission before calls that carry
 * X-API-Key. Allowed origins get the headers; a preflight (OPTIONS) is answered here, without a key. Returns true
 * when the request was a preflight (nothing more to do).
 */
function handle_cors(array $config, string $method): bool
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $allowed = $origin !== '' && in_array($origin, $config['allowedOrigins'] ?? [], true);
    if ($allowed) {
        header("Access-Control-Allow-Origin: $origin");
        header('Vary: Origin');
        header('Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges');
    }
    if ($method !== 'OPTIONS') return false;
    if ($allowed) {
        header('Access-Control-Allow-Methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: X-API-Key, Content-Type, Range');
        header('Access-Control-Max-Age: 600');
    }
    http_response_code(204);
    return true;
}

const AUDIO_TYPES = [
    'mp3' => 'audio/mpeg', 'm4a' => 'audio/mp4', 'opus' => 'audio/ogg', 'ogg' => 'audio/ogg',
    'flac' => 'audio/flac', 'wav' => 'audio/wav',
];

/** Sends a file, whole or one byte range ("bytes=0-99", "bytes=500-", "bytes=-100"), so players can seek. */
function send_file_range(string $path, string $method): void
{
    $size = filesize($path);
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    header('Accept-Ranges: bytes');
    header('Content-Type: ' . (AUDIO_TYPES[$ext] ?? 'application/octet-stream'));

    $start = 0;
    $end = $size - 1;
    $range = $_SERVER['HTTP_RANGE'] ?? '';
    // Several ranges at once are not supported: those requests get the whole file, which the HTTP rules allow.
    if (preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $m) && ($m[1] !== '' || $m[2] !== '')) {
        if ($m[1] === '') {
            $start = max(0, $size - (int) $m[2]);
            $ok = (int) $m[2] > 0;
        } else {
            $start = (int) $m[1];
            if ($m[2] !== '') $end = min((int) $m[2], $size - 1);
            $ok = $start < $size && $start <= $end;
        }
        if (!$ok) {
            http_response_code(416);
            header("Content-Range: bytes */$size");
            return;
        }
        http_response_code(206);
        header("Content-Range: bytes $start-$end/$size");
    }
    $length = $end - $start + 1;
    header("Content-Length: $length");
    if ($method === 'HEAD' || $length <= 0) return;

    set_time_limit(0);
    $handle = fopen($path, 'rb');
    fseek($handle, $start);
    while ($length > 0 && !connection_aborted()) {
        $chunk = fread($handle, min(65536, $length));
        if ($chunk === false || $chunk === '') break;
        echo $chunk;
        flush();
        $length -= strlen($chunk);
    }
    fclose($handle);
}
