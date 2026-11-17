"""Song in -> instrumental MP3 out. Started by routes.mjs (one job at a time), also usable by hand:

  python separate.py song.mp3 out.mp3 --method fast|best|backing [--models-dir DIR] [--ffmpeg PATH] [--title T]
                                       [--wav]   (also write a 32-bit WAV next to the MP3, for comparisons)

Prints one JSON object per line on stdout:
  {"event": "progress", "stage": "...", "progress": 0.42}
  {"event": "done", "output": "...", "seconds": 61.2, "device": "cuda"}
  {"event": "error", "message": "..."}
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback


def emit(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Song in -> instrumental MP3 out")
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--method", default="fast")
    parser.add_argument("--models-dir", default=os.path.join(os.path.expanduser("~"), "MuseHikData", "models"))
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_BIN", "ffmpeg"))
    parser.add_argument("--title", help="title tag of the output MP3")
    parser.add_argument("--wav", action="store_true", help="also write <output>.wav (32-bit float)")
    args = parser.parse_args()

    started = time.time()
    last = {"stage": None, "progress": -1.0, "time": 0.0}

    def report(stage: str, progress: float) -> None:
        now = time.time()
        # throttle: on stage change, every 1 %, or every 2 s
        if stage != last["stage"] or progress - last["progress"] >= 0.01 or now - last["time"] >= 2:
            emit("progress", stage=stage, progress=round(min(max(progress, 0.0), 1.0), 4))
            last.update(stage=stage, progress=progress, time=now)

    try:
        report("Starting (loading PyTorch)", 0.0)
        import torch
        from engine.audio import decode, encode
        from engine.methods import load_methods, run

        if args.method not in load_methods():
            raise ValueError(f"unknown method {args.method!r}")
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        report("Reading the song", 0.0)
        mix = decode(args.ffmpeg, args.input)
        instrumental = run(args.method, mix, args.models_dir, device, report)
        report("Writing the MP3", 1.0)
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        part = args.output + ".part.mp3"  # finished file appears only when complete
        encode(args.ffmpeg, instrumental, part, tags_from=args.input, title=args.title)
        os.replace(part, args.output)
        if args.wav:
            encode(args.ffmpeg, instrumental, os.path.splitext(args.output)[0] + ".wav")
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit("error", message=f"{type(error).__name__}: {error}")
        return 1
    emit("done", output=args.output, seconds=round(time.time() - started, 1), device=str(device))
    return 0


if __name__ == "__main__":
    sys.exit(main())
