# instrumentalSeparator

A library song -> its instrumental as an MP3 (same tags and cover), made on the GPU. Three methods:

| Method | What it does | Time for a 2:50 song (RTX 5060 Laptop) |
|---|---|---|
| **Fast** | BS-RoFormer Resurrection Inst, one pass | ~47 s |
| **Best quality** | Resurrection Inst + becruily Inst + Gabox FV7z, each run 3x (normal / L-R swapped / polarity flipped), all averaged | ~4 min 10 s |
| **Keep backing vocals** | Resurrection Inst (3 passes) -> clean instrumental; the removed voice goes through a karaoke model that splits lead from backing; the backing is added back | ~2 min 25 s |

The methods are defined in `methods.json` (read by both Python and the web page).

## How it works

```text
song.mp3 --ffmpeg--> 44.1 kHz stereo float
  model (RoFormer, GPU) on overlapping chunks, fades between chunks          inference.py  (from ZFTurbo's MSST)
  x3 with left/right swapped and polarity flipped, undone, averaged          inference.py  (MSST test-time augmentation)
  several models combined (Average / Max Spec / Min Spec)                    ensemble.py   (from UVR)
  [backing] voice = song - instrumental -> karaoke model -> lead; backing = voice - lead; instrumental += backing
                                                                             methods.py    (from karaoke-gen)
  -> MP3 320k with the original's tags + cover
```

## Files

| File | What |
|---|---|
| `routes.mjs` | API: methods, results of a song, start / follow / stop a job, play / download / delete a result |
| `jobs.mjs` | Job queue (one at a time: one GPU), runs `separate.py`, reads its JSON progress lines |
| `separate.py` | `python separate.py song.mp3 out.mp3 --method fast\|best\|backing [--wav]` (also usable by hand) |
| `methods.json` | The three methods (steps, models, passes, overlap) + the texts the page shows |
| `engine/` | Our separation engine, code copied from the open-source projects (see `NOTICE.md`) |

## Where things live (outside OneDrive)

`C:\Users\<you>\MuseHikData\` (`heavyDir` in `backend/core/config.mjs`):
- `separator-venv\`: Python 3.13 + PyTorch CUDA 12.8 (RTX 50xx needs cu128) + a few small libraries
- `models\`: model files, downloaded on first use (200-900 MB each)

Results are NOT kept there: they are saved in the music folder next to the songs (and added to the library) as
`<song file name> (Instrumental).mp3`, `(Instrumental, best quality).mp3` or `(Instrumental + backing vocals).mp3`.
Older results in `MuseHikData\instrumentals\` are moved there automatically when the server starts.

Setup:
```powershell
cd C:\Users\<you>\MuseHikData
py -3.13 -m venv separator-venv
.\separator-venv\Scripts\python.exe -m pip install --resume-retries 50 torch torchaudio --index-url https://download.pytorch.org/whl/cu128
.\separator-venv\Scripts\python.exe -m pip install -r <MuseHik>\backend\modules\instrumentalSeparator\requirements.txt
```
Keep the versions pinned in `requirements.txt`: with rotary-embedding-torch 0.9 the models still load but separate
almost nothing (the voice stays in the "instrumental").
No librosa: Windows Smart App Control blocks its numba dependency; the one function we needed is copied in
`engine/roformer/mel_filters.py`.
