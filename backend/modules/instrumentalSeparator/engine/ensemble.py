"""Combining several results of the same stem into one.

From UVR (lib_v5/spec_utils.py ensembling(), MAX_SPEC / MIN_SPEC, AVERAGE) as reused by python-audio-separator's
Ensembler:
  average   : sample-by-sample mean of the waveforms (optionally weighted). Best overall score in most tests.
  max_spec  : in the spectrogram, keep for every time/frequency point the result with the LOUDEST value:
              fullest sound, but keeps any vocal leak any one model left.
  min_spec  : keep the QUIETEST value: cleanest (least vocal leak), but can sound thinner.
"""
from __future__ import annotations

import numpy as np
import torch

N_FFT = 2048
HOP = 1024  # UVR's wave_to_spectrogram_no_mp defaults


def average(waves: list[np.ndarray], weights: list[float] | None = None) -> np.ndarray:
    w = np.ones(len(waves)) if weights is None else np.asarray(weights, dtype=np.float64)
    return sum(wave * weight for wave, weight in zip(waves, w)) / w.sum()


def _stft(wave: np.ndarray) -> torch.Tensor:
    return torch.stft(torch.from_numpy(np.ascontiguousarray(wave)), N_FFT, HOP, window=torch.hann_window(N_FFT),
                      return_complex=True)


def _spec_pick(waves: list[np.ndarray], loudest: bool) -> np.ndarray:
    length = waves[0].shape[-1]
    result = _stft(waves[0])
    for wave in waves[1:]:
        spec = _stft(wave)
        take = spec.abs() >= result.abs() if loudest else spec.abs() <= result.abs()
        result = torch.where(take, spec, result)
    return torch.istft(result, N_FFT, HOP, window=torch.hann_window(N_FFT), length=length).numpy()


def max_spec(waves: list[np.ndarray]) -> np.ndarray:
    return _spec_pick(waves, loudest=True)


def min_spec(waves: list[np.ndarray]) -> np.ndarray:
    return _spec_pick(waves, loudest=False)


METHODS = {"average": average, "max_spec": max_spec, "min_spec": min_spec}
