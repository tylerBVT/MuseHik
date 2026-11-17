"""Running a model on a whole song.

demix(): ZFTurbo's Music-Source-Separation-Training utils/model_utils.py demix(), "generic" mode:
  the song is cut in chunks of the model's size that overlap (step = chunk / num_overlap); each chunk's output is
  weighted by a window with linear fades and added up, then divided by the summed weights (overlap-add). The song is
  reflect-padded at both ends so the first and last chunks are as good as the middle ones.
passes(): ZFTurbo's apply_tta(): run again on the left/right-swapped song and on the polarity-flipped song,
  undo the change on the output, and average. The model's random errors differ between passes and partly cancel.
"""
from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn.functional as F

from .models import target_stems


def _windowing_array(window_size: int, fade_size: int) -> torch.Tensor:
    window = torch.ones(window_size)
    window[-fade_size:] = torch.linspace(1, 0, fade_size)
    window[:fade_size] = torch.linspace(0, 1, fade_size)
    return window


def chunk_size_of(config: dict) -> int:
    inference = config.get("inference", {}) or {}
    return int(inference.get("chunk_size") or config["audio"]["chunk_size"])


def count_chunks(config: dict, length: int, num_overlap: int) -> int:
    """How many model calls demix() makes for a song of `length` samples (for the progress bar)."""
    chunk_size = chunk_size_of(config)
    step = chunk_size // num_overlap
    border = chunk_size - step
    padded = length + 2 * border if length > 2 * border and border > 0 else length
    return math.ceil(padded / step)


@torch.no_grad()
def demix(model, config: dict, mix: np.ndarray, device: torch.device, num_overlap: int = 2, batch_size: int = 1,
          on_chunk=None) -> dict[str, np.ndarray]:
    """mix (2, n) -> {stem name: (2, n)} for the stems the model outputs."""
    chunk_size = chunk_size_of(config)
    stems = target_stems(config)
    use_amp = bool(config.get("training", {}).get("use_amp", True)) and device.type == "cuda"

    mix_t = torch.tensor(mix, dtype=torch.float32, device=device)
    fade_size = chunk_size // 10
    step = chunk_size // num_overlap
    border = chunk_size - step
    length_init = mix_t.shape[-1]
    windowing_array = _windowing_array(chunk_size, fade_size).to(device)
    if length_init > 2 * border and border > 0:
        mix_t = F.pad(mix_t, (border, border), mode="reflect")

    result = torch.zeros((len(stems),) + tuple(mix_t.shape), dtype=torch.float32, device=device)
    counter = torch.zeros(mix_t.shape[-1], dtype=torch.float32, device=device)

    with torch.autocast(device_type=device.type, enabled=use_amp):
        i = 0
        batch_data, batch_locations = [], []
        while i < mix_t.shape[1]:
            part = mix_t[:, i:i + chunk_size]
            chunk_len = part.shape[-1]
            pad_mode = "reflect" if chunk_len > chunk_size // 2 else "constant"
            part = F.pad(part, (0, chunk_size - chunk_len), mode=pad_mode, value=0) if chunk_len < chunk_size else part
            batch_data.append(part)
            batch_locations.append((i, chunk_len))
            i += step

            if len(batch_data) >= batch_size or i >= mix_t.shape[1]:
                x = model(torch.stack(batch_data, dim=0)).to(torch.float32)
                if x.ndim == 3:  # one stem: (batch, channels, time) -> (batch, 1, channels, time)
                    x = x.unsqueeze(1)
                for j, (start, seg_len) in enumerate(batch_locations):
                    first = start == 0
                    last = start + step >= mix_t.shape[1]
                    window = windowing_array.clone() if (first or last) else windowing_array
                    if first:
                        window[:fade_size] = 1
                    if last:
                        window[-fade_size:] = 1
                    result[..., start:start + seg_len] += x[j, ..., :seg_len] * window[:seg_len]
                    counter[start:start + seg_len] += window[:seg_len]
                    if on_chunk:
                        on_chunk()
                batch_data.clear()
                batch_locations.clear()

    estimated = result.div_(counter)
    if length_init > 2 * border and border > 0:
        estimated = estimated[..., border:-border]
    out = np.nan_to_num(estimated.cpu().numpy())
    return {name: out[k] for k, name in enumerate(stems)}


VOCAL_NAMES = {"vocals", "vocal", "voice", "lead", "lead vocals"}


def instrumental_from(stems: dict[str, np.ndarray], mix: np.ndarray) -> np.ndarray:
    """The instrumental from a model's output: its instrumental stem, or song - vocals."""
    for name, wave in stems.items():
        if name.lower() not in VOCAL_NAMES:
            return wave
    return mix - next(iter(stems.values()))


def vocals_from(stems: dict[str, np.ndarray], mix: np.ndarray) -> np.ndarray:
    for name, wave in stems.items():
        if name.lower() in VOCAL_NAMES:
            return wave
    return mix - next(iter(stems.values()))


def passes(run, mix: np.ndarray, tta: bool) -> np.ndarray:
    """run(mix) -> (2, n). Returns the average over the TTA passes (one pass when tta is False)."""
    total = run(mix)
    if not tta:
        return total
    total = total + run(np.ascontiguousarray(mix[::-1]))[::-1]   # left/right swapped, swapped back
    total = total - run(-mix)                                      # polarity flipped, flipped back
    return total / 3
