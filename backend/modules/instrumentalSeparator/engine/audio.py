"""Audio in / out through ffmpeg pipes (float32, 44.1 kHz stereo). No other audio library needed."""
from __future__ import annotations

import subprocess

import numpy as np

SAMPLE_RATE = 44100


def decode(ffmpeg: str, path: str) -> np.ndarray:
    """Any audio file -> float32 array of shape (2, samples) at 44.1 kHz."""
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-i", path, "-map", "0:a:0", "-f", "f32le", "-ac", "2", "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def safe_peak(wave: np.ndarray) -> np.ndarray:
    """Lower the whole track (never clip) if it would go over full scale."""
    peak = float(np.abs(wave).max()) if wave.size else 0.0
    return wave * (0.999 / peak) if peak > 0.999 else wave


def encode(ffmpeg: str, wave: np.ndarray, out_path: str, tags_from: str | None = None, title: str | None = None) -> None:
    """(2, samples) float -> MP3 320k (tags + cover art copied from `tags_from`), or WAV when the name ends in .wav."""
    pcm = np.ascontiguousarray(safe_peak(wave).T, dtype=np.float32).tobytes()
    cmd = [ffmpeg, "-v", "error", "-y", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", "-i", "pipe:0"]
    if out_path.lower().endswith(".wav"):
        cmd += ["-c:a", "pcm_f32le", out_path]
    else:
        if tags_from:
            cmd += ["-i", tags_from, "-map", "0:a", "-map", "1:v?", "-map_metadata", "1", "-c:v", "copy"]
        cmd += ["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"]
        if title:
            cmd += ["-metadata", f"title={title}"]
        if tags_from:
            # The ISRC names the original recording; an instrumental is a different one. Keeping it would make the
            # downloader think the instrumental IS the song ("already in your library").
            cmd += ["-metadata", "isrc=", "-metadata", "TSRC="]
        cmd += [out_path]
    subprocess.run(cmd, input=pcm, check=True, capture_output=True)


def fit_length(wave: np.ndarray, length: int) -> np.ndarray:
    if wave.shape[-1] >= length:
        return wave[..., :length]
    return np.pad(wave, [(0, 0)] * (wave.ndim - 1) + [(0, length - wave.shape[-1])])
