"""The three ways of making an instrumental (described in ../methods.json, which the web page also shows).

  fast     one model, one pass
  best     three models x three TTA passes, averaged (UVR Average ensemble)
  backing  karaoke-gen's method: clean instrumental, then the removed voice is split into lead and backing
           by a karaoke model, and the backing vocals are added back
"""
from __future__ import annotations

import gc
import json
import os

import numpy as np
import torch

from . import ensemble
from .inference import count_chunks, demix, instrumental_from, passes, vocals_from
from .models import CATALOGUE, ensure_model, is_downloaded, load_config, load_model

METHODS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "methods.json")


def load_methods() -> dict[str, dict]:
    with open(METHODS_FILE, encoding="utf-8") as f:
        return {m["id"]: m for m in json.load(f)}


def _free(model) -> None:
    del model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def run(method_id: str, mix: np.ndarray, models_dir: str, device: torch.device, report) -> np.ndarray:
    """mix (2, n) -> instrumental (2, n). report(stage: str, progress: float 0..1) is called as work advances."""
    method = load_methods()[method_id]
    steps = method["steps"]

    # 1. Models: download what is missing (only the first time).
    for key in method["models"]:
        if not is_downloaded(key, models_dir):
            label = CATALOGUE[key].label
            report(f"Downloading {label} (first time only)", 0.0)
            ensure_model(key, models_dir, on_bytes=lambda done, total, label=label:
                         report(f"Downloading {label} (first time only)", done / total if total else 0.0))

    # 2. Progress = model calls done / model calls planned, over all steps.
    length = mix.shape[-1]
    planned = sum(step["passes"] * count_chunks(load_config(os.path.join(models_dir, CATALOGUE[step["model"]].config)),
                                                length, step["overlap"]) for step in steps)
    done = 0

    def runner(model, config, step, label):
        def run_once(audio: np.ndarray) -> dict[str, np.ndarray]:
            def tick():
                nonlocal done
                done += 1
                report(label, done / planned)
            return demix(model, config, audio, device, num_overlap=step["overlap"], on_chunk=tick)
        return run_once

    # 3. The steps.
    results: list[np.ndarray] = []
    instrumental = None
    for index, step in enumerate(steps):
        info = CATALOGUE[step["model"]]
        label = f"Step {index + 1}/{len(steps)}: {info.label}" + (f" ({step['passes']} passes)" if step["passes"] > 1 else "")
        report(label, done / planned)
        model, config = load_model(step["model"], models_dir, device)
        run_once = runner(model, config, step, label)

        if step.get("input") == "vocals":
            # karaoke-gen: split the removed voice into lead + backing, add the backing back.
            vocals = mix - instrumental
            lead = passes(lambda audio: vocals_from(run_once(audio), audio), vocals, tta=step["passes"] > 1)
            backing = vocals - lead
            instrumental = instrumental + backing
        else:
            result = passes(lambda audio: instrumental_from(run_once(audio), audio), mix, tta=step["passes"] > 1)
            results.append(result)
            instrumental = result
        _free(model)

    if len(results) > 1:
        report("Combining the results", 1.0)
        instrumental = ensemble.METHODS[method.get("combine", "average")](results)
    return instrumental
