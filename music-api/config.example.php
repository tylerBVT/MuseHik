<?php
// Copy this file to config.php (never committed) and fill it in.
return [
    // The cloud folder the laptops fill over FTP: it holds library.json, playlists.json and songs/.
    // On LWS, an absolute path like '/home/<account>/music' (outside public_html if possible).
    'dataDir' => '/home/ACCOUNT/music',

    // The secret the app sends in the X-API-Key header. Long and random, e.g. from `php -r "echo bin2hex(random_bytes(24));"`.
    'apiKey' => 'change-me-to-a-long-random-string',

    // Biggest song the phone may upload, and the cap for everything on the cloud (same default as the laptops).
    'maxUploadMB' => 200,
    'storageLimitGB' => 30,

    // Shown as "added by" when an upload does not say who sent it.
    'defaultAddedBy' => 'phone',

    // Where the app runs: inside the phone (Capacitor) and `ng serve` for development.
    'allowedOrigins' => ['https://localhost', 'http://localhost', 'capacitor://localhost', 'http://localhost:4200'],
];
