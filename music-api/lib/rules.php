<?php
// The laptops' song rules (backend/core/lib.mjs), ported so the API names files and recognises songs exactly as the
// laptops do. backend/tests/music-api.test.mjs checks both give the same results, with and without the intl
// extension (some hostings lack it).

// JavaScript's \s, and its \b in non-Unicode mode (word characters are ASCII only).
const JS_SPACE = '[\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]';
const JS_B = '(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))';

/** Characters intl's NFKD/NFKC would change, for hostings without intl (Latin letters, ligatures, full width). */
function compat_map(): array
{
    static $map = null;
    if ($map !== null) return $map;
    $groups = [
        'a' => 'àáâãäåāăąª', 'c' => 'çćĉċč', 'd' => 'ď', 'e' => 'èéêëēĕėęě', 'g' => 'ĝğġģ', 'h' => 'ĥ',
        'i' => 'ìíîïĩīĭįİ', 'j' => 'ĵ', 'k' => 'ķ', 'l' => 'ĺļľŀ', 'n' => 'ñńņňŉ', 'o' => 'òóôõöōŏőº',
        'r' => 'ŕŗř', 's' => 'śŝşšſ', 't' => 'ţť', 'u' => 'ùúûüũūŭůűų', 'w' => 'ŵ', 'y' => 'ýÿŷ',
        'z' => 'źżž', '1' => '¹', '2' => '²', '3' => '³',
    ];
    $map = ['ﬀ' => 'ff', 'ﬁ' => 'fi', 'ﬂ' => 'fl', 'ﬃ' => 'ffi', 'ﬄ' => 'ffl', 'ﬅ' => 'st', 'ﬆ' => 'st', 'ĳ' => 'ij',
        'Ĳ' => 'IJ', "\u{A0}" => ' '];
    foreach ($groups as $to => $chars) {
        foreach (mb_str_split($chars) as $c) $map[$c] = $to;
    }
    for ($cp = 0xFF01; $cp <= 0xFF5E; $cp++) $map[mb_chr($cp)] = chr($cp - 0xFEE0); // full width → ASCII
    return $map;
}

/** NFKD when intl exists; otherwise the letters that matter for song keys, mapped to their base letter. */
function nfkd(string $s): string
{
    if (class_exists('Normalizer')) return Normalizer::normalize($s, Normalizer::FORM_KD) ?: $s;
    return strtr($s, compat_map());
}

/** NFKC when intl exists; otherwise ligatures, full-width letters and no-break spaces only. */
function nfkc(string $s): string
{
    if (class_exists('Normalizer')) return Normalizer::normalize($s, Normalizer::FORM_KC) ?: $s;
    static $small = null;
    $small ??= array_filter(compat_map(), fn ($to, $from) => strlen($to) > 1 || $from === "\u{A0}"
        || (mb_ord($from) >= 0xFF01 && mb_ord($from) <= 0xFF5E), ARRAY_FILTER_USE_BOTH);
    return strtr($s, $small);
}

/** The first $max UTF-16 units of $s (JavaScript's slice), never cutting a character in two. */
function js_slice(string $s, int $max): string
{
    $out = '';
    $units = 0;
    foreach (mb_str_split($s) as $c) {
        $units += mb_ord($c) > 0xFFFF ? 2 : 1;
        if ($units > $max) break;
        $out .= $c;
    }
    return $out;
}

/** A name safe for a file on Windows and Linux (lib.mjs safeName). */
function safe_name(?string $s): string
{
    $s = ($s === null || $s === '') ? 'Untitled' : $s;
    $s = preg_replace('/[\x00-\x1f\/\\\\:*?"<>|%]/u', '_', nfkc($s));
    $s = preg_replace('/^\.+/u', '', $s);
    $s = preg_replace('/[ .]+$/uD', '', $s);
    $s = js_slice($s, 100);
    return $s === '' ? 'Untitled' : $s;
}

/** "Artist - Title" (or "Title"), made safe (lib.mjs fileBase). */
function file_base(string $artist, string $title): string
{
    return safe_name($artist !== '' ? "$artist - $title" : $title);
}

/** Lowercase words without accents, ASCII letters and digits only (lib.mjs words). */
function key_words(string $s): array
{
    $s = preg_replace('/[\x{300}-\x{36F}]/u', '', nfkd(mb_strtolower($s, 'UTF-8')));
    preg_match_all('/[a-z0-9]+/', $s, $m);
    return $m[0];
}

/** The song's identity key "artist words|title words": main artist only, "feat." credits dropped (lib.mjs trackKey). */
function track_key(string $artist, string $title): string
{
    $s = JS_SPACE;
    $b = JS_B;
    $title = preg_replace("/[(\\[]$s*(?:feat\\.?|ft\\.?|featuring|with)$b" . '[^)\]]*[)\]]/iu', '', $title);
    $title = preg_replace("/$s(?:feat\\.?|ft\\.?|featuring)$s" . '[^\n\r\x{2028}\x{2029}]*\z/iu', '', $title);
    $primary = preg_split("/,|&|{$b}feat\\.?$b|{$b}ft\\.?$b/iu", $artist)[0];
    return implode(' ', key_words($primary)) . '|' . implode(' ', key_words($title));
}

/** Same song: same ISRC, or same key with lengths within 6 s; an unknown length never blocks (lib.mjs sameIdentity). */
function same_identity(array $a, array $b): bool
{
    $isrcA = (string) ($a['isrc'] ?? '');
    $isrcB = (string) ($b['isrc'] ?? '');
    if ($isrcA !== '' && $isrcB !== '' && strtolower($isrcA) === strtolower($isrcB)) return true;
    $key = fn (array $s) => ($s['key'] ?? '') !== '' ? $s['key'] : track_key((string) ($s['artist'] ?? ''), (string) ($s['title'] ?? ''));
    if ($key($a) !== $key($b)) return false;
    $da = (float) ($a['duration'] ?? 0);
    $db = (float) ($b['duration'] ?? 0);
    return !$da || !$db || abs($da - $db) <= 6;
}
