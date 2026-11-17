"""Runs yt-dlp with its own DNS fallback for YouTube hostnames.

Why: the owner blocks YouTube for the whole PC through the Windows hosts file (a self-control rule for
browsers). That also blocks this downloader. Only inside THIS process, when the system resolver gives no
usable answer for a YouTube-related hostname, we ask a public DNS-over-HTTPS server instead. The hosts
file and every other program (Chrome, ...) are untouched, so YouTube stays blocked everywhere else.

Usage: python ytdlp_launcher.py <yt-dlp arguments>
"""
import json
import runpy
import socket
import sys
import urllib.request

YOUTUBE_SUFFIXES = (
    "youtube.com", "youtu.be", "youtube-nocookie.com", "ytimg.com",
    "googlevideo.com", "youtubei.googleapis.com", "ggpht.com",
)
# Queried by IP address, so no DNS is needed to reach them.
DOH_SERVERS = (
    "https://1.1.1.1/dns-query?name={name}&type=A",
    "https://8.8.8.8/resolve?name={name}&type=A",
)
UNUSABLE = {"0.0.0.0", "127.0.0.1", "::", "::1"}

_original_getaddrinfo = socket.getaddrinfo
_cache = {}


def _is_youtube(host):
    host = host.lower().rstrip(".")
    return any(host == s or host.endswith("." + s) for s in YOUTUBE_SUFFIXES)


def _doh_lookup(host):
    if host in _cache:
        return _cache[host]
    for template in DOH_SERVERS:
        try:
            request = urllib.request.Request(
                template.format(name=host), headers={"accept": "application/dns-json"}
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                answers = json.load(response).get("Answer", [])
            ips = [a["data"] for a in answers if a.get("type") == 1 and a["data"] not in UNUSABLE]
            if ips:
                _cache[host] = ips
                return ips
        except Exception:
            continue
    return []


def _getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if isinstance(host, str) and _is_youtube(host):
        try:
            results = _original_getaddrinfo(host, port, family, type, proto, flags)
            if any(r[4][0] not in UNUSABLE for r in results):
                return results
        except socket.gaierror:
            pass
        ips = _doh_lookup(host)
        if ips:
            out = []
            for ip in ips:
                out.extend(_original_getaddrinfo(ip, port, socket.AF_INET, type, proto, flags))
            return out
    return _original_getaddrinfo(host, port, family, type, proto, flags)


socket.getaddrinfo = _getaddrinfo

if __name__ == "__main__":
    sys.argv[0] = "yt-dlp"
    runpy.run_module("yt_dlp", run_name="__main__", alter_sys=True)
