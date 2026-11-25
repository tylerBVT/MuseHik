<?php
// For testing on the laptop with PHP's built-in server (`php -S 0.0.0.0:8000 router.php`, from this folder):
// every request goes to index.php, like .htaccess does on Apache. No file of this folder is ever served as is.
$_SERVER['SCRIPT_NAME'] = '/index.php';
require __DIR__ . '/index.php';
