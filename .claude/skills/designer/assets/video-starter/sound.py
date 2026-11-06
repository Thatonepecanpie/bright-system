# A short synth "whoosh + chime" made with numpy, then finished with Pedalboard effects.
import sys, numpy as np
from pedalboard import Pedalboard, Reverb, Compressor, HighpassFilter, Limiter, Gain
from pedalboard.io import AudioFile
sr = 48000; dur = 3.0; t = np.arange(int(sr * dur)) / sr
rng = np.random.default_rng(7)
noise = rng.standard_normal(t.size) * np.exp(-((t - 0.9) ** 2) / 0.08) * 0.25        # whoosh into the morph
chime = sum(np.sin(2 * np.pi * f * t) * np.exp(-(t - 1.35).clip(0) * 3) * (t > 1.35) for f in (523.25, 784.0, 1046.5)) * 0.18
dry = np.stack([noise + chime, noise * 0.9 + chime]).astype(np.float32)
board = Pedalboard([HighpassFilter(120), Compressor(threshold_db=-18, ratio=3), Reverb(room_size=0.6, wet_level=0.3), Gain(3), Limiter(-1)])
with AudioFile(sys.argv[1], 'w', sr, 2) as f:
    f.write(board(dry, sr))
print('sound ok')
