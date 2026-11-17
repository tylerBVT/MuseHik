"""The separation models we use: where to download them, and how to build + load them.

Download: same mirrors as python-audio-separator (Separator.download_model_files): its GitHub release mirror first,
then the original UVR model repo. Downloads resume after a network drop (.part file + HTTP Range).
Loading: python-audio-separator's RoformerLoader (roformer_loader.py) simplified: read the model's YAML, build
BSRoformer or MelBandRoformer with the arguments it accepts, load the checkpoint's weights.
"""
from __future__ import annotations

import inspect
import os
import time
import urllib.request
from dataclasses import dataclass

import yaml

MIRROR = "https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs"
UPSTREAM = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models"


@dataclass(frozen=True)
class ModelInfo:
    key: str
    label: str
    checkpoint: str
    config: str
    size_mb: int  # approximate, for the UI


CATALOGUE: dict[str, ModelInfo] = {m.key: m for m in [
    ModelInfo("resurrection_inst", "BS-RoFormer Resurrection Inst (unwa)",
              "bs_roformer_instrumental_resurrection_unwa.ckpt", "config_bs_roformer_instrumental_resurrection_unwa.yaml", 200),
    ModelInfo("becruily_inst", "Mel-Band RoFormer Instrumental (becruily)",
              "mel_band_roformer_instrumental_becruily.ckpt", "config_mel_band_roformer_instrumental_becruily.yaml", 870),
    ModelInfo("fv7z_inst", "Mel-Band RoFormer Instrumental FV7z (Gabox)",
              "mel_band_roformer_instrumental_fv7z_gabox.ckpt", "config_mel_band_roformer_instrumental_gabox.yaml", 870),
    ModelInfo("karaoke_aufr33", "Mel-Band RoFormer Karaoke (aufr33 & viperx)",
              "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
              "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956_config.yaml", 870),
]}


# ---------------------------------------------------------------- download

def _download(filename: str, models_dir: str, on_bytes=None) -> str:
    """Downloads `filename` into models_dir unless present. Resumes a partial download. Returns the path."""
    path = os.path.join(models_dir, filename)
    if os.path.exists(path):
        return path
    os.makedirs(models_dir, exist_ok=True)
    part = path + ".part"
    last_error: Exception | None = None
    for attempt in range(8):
        for base in (MIRROR, UPSTREAM):
            try:
                have = os.path.getsize(part) if os.path.exists(part) else 0
                request = urllib.request.Request(f"{base}/{filename}", headers={"User-Agent": "MuseHik"})
                if have:
                    request.add_header("Range", f"bytes={have}-")
                with urllib.request.urlopen(request, timeout=60) as response:
                    if have and response.status != 206:  # server ignored Range: start over
                        have = 0
                    total = have + int(response.headers.get("Content-Length") or 0)
                    with open(part, "ab" if have else "wb") as out:
                        done = have
                        while chunk := response.read(1 << 20):
                            out.write(chunk)
                            done += len(chunk)
                            if on_bytes:
                                on_bytes(done, total)
                os.replace(part, path)
                return path
            except Exception as error:  # network drop, 404 on one mirror...: try the other, then retry
                last_error = error
        time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"could not download {filename}: {last_error}")


def ensure_model(key: str, models_dir: str, on_bytes=None) -> tuple[str, str]:
    """Checkpoint + config of a catalogue model, downloaded if needed. Returns (checkpoint_path, config_path)."""
    info = CATALOGUE[key]
    config_path = _download(info.config, models_dir)
    checkpoint_path = _download(info.checkpoint, models_dir, on_bytes)
    return checkpoint_path, config_path


def is_downloaded(key: str, models_dir: str) -> bool:
    info = CATALOGUE[key]
    return all(os.path.exists(os.path.join(models_dir, f)) for f in (info.checkpoint, info.config))


# ---------------------------------------------------------------- config + model

class _ConfigLoader(yaml.SafeLoader):
    """Model YAMLs use `!!python/tuple`; read it as a tuple without allowing arbitrary Python objects."""


_ConfigLoader.add_constructor("tag:yaml.org,2002:python/tuple", lambda loader, node: tuple(loader.construct_sequence(node)))


def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.load(f, Loader=_ConfigLoader)


def target_stems(config: dict) -> list[str]:
    """Names of what the model outputs, in order (ZFTurbo's prefer_target_instrument)."""
    training = config.get("training", {})
    target = training.get("target_instrument")
    return [target] if target else list(training.get("instruments", []))


def build_model(config: dict):
    from .roformer.bs_roformer import BSRoformer
    from .roformer.mel_band_roformer import MelBandRoformer

    params = dict(config["model"])
    cls = BSRoformer if "freqs_per_bands" in params else MelBandRoformer
    accepted = inspect.signature(cls.__init__).parameters
    return cls(**{k: v for k, v in params.items() if k in accepted})


def load_model(key: str, models_dir: str, device):
    """Returns (model on device in eval mode, config dict)."""
    import torch

    checkpoint_path, config_path = ensure_model(key, models_dir)
    config = load_config(config_path)
    model = build_model(config)
    state = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    elif isinstance(state, dict) and "model" in state and isinstance(state["model"], dict):
        state = state["model"]
    state = {k.removeprefix("module."): v for k, v in state.items()}
    model.load_state_dict(state)
    return model.to(device).eval(), config
