"""librosa.filters.mel (Slaney mel scale, Slaney area normalisation), copied so the engine does not need librosa.

librosa pulls in numba, whose compiled files Windows Smart App Control can block. Only this function was used
(by MelBandRoformer, to group frequencies into bands). Source: librosa/filters.py + librosa/core/convert.py (ISC).
"""
from __future__ import annotations

import numpy as np

_F_SP = 200.0 / 3                     # Slaney: linear below 1 kHz ...
_MIN_LOG_HZ = 1000.0
_MIN_LOG_MEL = _MIN_LOG_HZ / _F_SP    # = 15
_LOGSTEP = np.log(6.4) / 27.0         # ... logarithmic above


def hz_to_mel(frequencies):
    frequencies = np.asanyarray(frequencies, dtype=np.float64)
    mels = frequencies / _F_SP
    log_t = frequencies >= _MIN_LOG_HZ
    return np.where(log_t, _MIN_LOG_MEL + np.log(np.maximum(frequencies, 1e-10) / _MIN_LOG_HZ) / _LOGSTEP, mels)


def mel_to_hz(mels):
    mels = np.asanyarray(mels, dtype=np.float64)
    freqs = _F_SP * mels
    log_t = mels >= _MIN_LOG_MEL
    return np.where(log_t, _MIN_LOG_HZ * np.exp(_LOGSTEP * (mels - _MIN_LOG_MEL)), freqs)


def mel(*, sr: float, n_fft: int, n_mels: int = 128, fmin: float = 0.0, fmax: float | None = None,
        dtype=np.float32) -> np.ndarray:
    """Mel filter bank, shape (n_mels, 1 + n_fft // 2); same values as librosa.filters.mel defaults."""
    if fmax is None:
        fmax = float(sr) / 2
    fftfreqs = np.fft.rfftfreq(n=n_fft, d=1.0 / sr)
    mel_f = mel_to_hz(np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2))
    fdiff = np.diff(mel_f)
    ramps = np.subtract.outer(mel_f, fftfreqs)
    weights = np.zeros((n_mels, len(fftfreqs)), dtype=dtype)
    for i in range(n_mels):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))
    enorm = 2.0 / (mel_f[2:n_mels + 2] - mel_f[:n_mels])  # Slaney-style: constant energy per channel
    weights *= enorm[:, np.newaxis]
    return weights
