"""MuseHik separation engine: song -> instrumental.

Code taken from (all MIT licensed, see NOTICE.md):
  roformer/          model code, from python-audio-separator (uvr_lib_v5/roformer), itself from lucidrains / ZFTurbo
  models.py          model download (audio-separator's mirrors) + loading (audio-separator's RoformerLoader)
  inference.py       chunked overlap-add inference + test-time augmentation (ZFTurbo's Music-Source-Separation-Training)
  ensemble.py        combining several results (UVR's Max/Min Spec, plain average)
  methods.py         the three ways of making an instrumental (fast / best / with backing vocals, from karaoke-gen)
"""
