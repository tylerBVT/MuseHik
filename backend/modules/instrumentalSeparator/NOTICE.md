# Third-party code in this module

The separation engine (`engine/`) is built from code copied out of these open-source projects. All are under the
MIT license (librosa: ISC), which allows copying and changing the code as long as this notice is kept.

| Our file | Copied from | License |
|---|---|---|
| `engine/roformer/bs_roformer.py`, `mel_band_roformer.py`, `attend.py`, `rotary.py`, `device_utils.py` | python-audio-separator (`audio_separator/separator/uvr_lib_v5/`), Copyright (c) 2023 karaokenerds / Nomad Karaoke LLC; model code originally by Phil Wang (lucidrains, BS-RoFormer / Mel-Band RoFormer) and Roman Solovyev (ZFTurbo) | MIT |
| `engine/roformer/mel_filters.py` | librosa (`filters.mel`, `hz_to_mel`, `mel_to_hz`), Copyright (c) 2013--2023 librosa development team | ISC |
| `engine/inference.py` (`demix`, windowing, test-time augmentation) | Music-Source-Separation-Training (`utils/model_utils.py`), Copyright (c) 2024 Roman Solovyev (ZFTurbo) | MIT |
| `engine/ensemble.py` (Average / Max Spec / Min Spec) | Ultimate Vocal Remover GUI (`lib_v5/spec_utils.py`), Anjok07 & aufr33; as reused in python-audio-separator's `ensembler.py` | MIT |
| `engine/models.py` (download mirrors, RoFormer loading) | python-audio-separator (`separator.py` `download_model_files`, `roformer/roformer_loader.py`) | MIT |
| `engine/methods.py` "backing" method (lead/backing split, backing added back) | karaoke-gen (`karaoke_gen/audio_processor.py`), Copyright (c) 2024 Nomad Karaoke LLC | MIT |

The models themselves (downloaded into `MuseHikData/models/`, not in this repository) are community-trained
checkpoints: Resurrection Inst (unwa), Instrumental (becruily), Instrumental FV7z (Gabox), Karaoke (aufr33 & viperx).

MIT license text (same for every MIT project above, with each one's copyright line):

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following conditions:
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of
> the Software.
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
