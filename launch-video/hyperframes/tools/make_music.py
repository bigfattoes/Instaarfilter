"""Synthesises the launch video's 15 s soundtrack (128 BPM, C major) with its sound effects
lined up to the animation in index.html. No samples or paid libraries: everything is generated here.

    python3 tools/make_music.py   ->  assets/music.wav
"""
import numpy as np
from scipy.signal import butter, sosfilt
from scipy.io import wavfile
from pathlib import Path

SR = 44100
DUR = 15.0
B = 60 / 128  # one beat, 0.46875 s
BAR = 4 * B
N = int(SR * DUR)
rng = np.random.default_rng(3)

L = np.zeros(N)
R = np.zeros(N)
duck = np.ones(N)  # sidechain envelope from the kick


def t_arr(sec):
    return np.arange(int(sec * SR)) / SR


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    L[i:i + len(sig)] += sig * gain * (1 - max(0, pan))
    R[i:i + len(sig)] += sig * gain * (1 + min(0, pan))


def filt(sig, kind, f):
    return sosfilt(butter(2, f, kind, fs=SR, output="sos"), sig)


def note(n):  # MIDI -> Hz
    return 440 * 2 ** ((n - 69) / 12)


def saw(f, sec, detune=0.0):
    t = t_arr(sec)
    ph = (t * f * (1 + detune)) % 1
    return 2 * ph - 1


# ---------- instruments
def kick(gain=1.0):
    t = t_arr(0.45)
    f = 45 + 110 * np.exp(-t * 28)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7)
    s[:200] += rng.uniform(-1, 1, 200) * np.linspace(0.5, 0, 200)
    return s * gain


def clap():
    t = t_arr(0.25)
    n = rng.uniform(-1, 1, len(t))
    env = np.exp(-t * 22)
    for d in (0.0, 0.012, 0.024):
        env += np.where(t >= d, np.exp(-(t - d) * 90), 0) * 0.6
    return filt(n * env, "bandpass", [900, 3500]) * 0.9


def hat(open_=False):
    t = t_arr(0.25 if open_ else 0.05)
    n = rng.uniform(-1, 1, len(t)) * np.exp(-t * (14 if open_ else 80))
    return filt(n, "highpass", 7000) * 0.5


def bass(n, sec):
    s = saw(note(n), sec) * 0.6 + np.sin(2 * np.pi * note(n - 12) * t_arr(sec)) * 0.7
    t = t_arr(sec)
    env = np.minimum(1, t * 200) * np.exp(-t * 3)
    return filt(s * env, "lowpass", 600)


def stab(notes, sec, bright=3500):
    t = t_arr(sec)
    s = sum(saw(note(n), sec, d) for n in notes for d in (-0.006, 0, 0.006))
    env = np.minimum(1, t * 300) * np.exp(-t * 9)
    return filt(s * env, "lowpass", bright) * 0.11


def pad(notes, sec, cutoff=1800):
    t = t_arr(sec)
    s = sum(saw(note(n), sec, d) for n in notes for d in (-0.004, 0.004))
    env = np.minimum(1, t / 0.3) * np.minimum(1, (sec - t) / 0.3)
    return filt(s * env, "lowpass", cutoff) * 0.05


def pluck(n, sec=0.3):
    t = t_arr(sec)
    s = np.sign(np.sin(2 * np.pi * note(n) * t)) * 0.5 + np.sin(2 * np.pi * note(n + 12) * t) * 0.5
    return filt(s * np.exp(-t * 14), "lowpass", 5000) * 0.18


# ---------- sound effects
def whoosh(sec=0.45, up=True):
    t = t_arr(sec)
    n = rng.uniform(-1, 1, len(t))
    env = np.sin(np.pi * t / sec) ** 2
    lo = filt(n, "bandpass", [400, 1500]) if up else filt(n, "bandpass", [1500, 5000])
    hi = filt(n, "bandpass", [1500, 6000]) if up else filt(n, "bandpass", [300, 1200])
    mix = np.linspace(0, 1, len(t))
    return (lo * (1 - mix) + hi * mix) * env * 0.9


def thud():
    t = t_arr(0.3)
    f = 40 + 80 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 12) * 1.1


def popfx(pitch=900):
    t = t_arr(0.12)
    f = pitch * (1 + 1.5 * np.exp(-t * 60))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 35) * 0.45


def impact():
    t = t_arr(1.2)
    f = 35 + 60 * np.exp(-t * 10)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 3.5)
    n = filt(rng.uniform(-1, 1, len(t)), "lowpass", 2500) * np.exp(-t * 12)
    return sub * 1.0 + n * 0.5


def crash():
    t = t_arr(1.6)
    n = rng.uniform(-1, 1, len(t)) * np.exp(-t * 2.6)
    return filt(n, "highpass", 4500) * 0.45


def punch():
    t = t_arr(0.22)
    f = 60 + 140 * np.exp(-t * 40)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 16)
    n = filt(rng.uniform(-1, 1, len(t)), "bandpass", [800, 4000]) * np.exp(-t * 60)
    return s * 1.0 + n * 0.6


def tick():
    t = t_arr(0.03)
    return np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 200) * 0.35


def riser(sec):
    t = t_arr(sec)
    n = rng.uniform(-1, 1, len(t))
    out = np.zeros(len(t))
    seg = int(0.05 * SR)
    for i in range(0, len(t), seg):  # sweep a band-pass upward in short steps
        fc = 500 + 7000 * (i / len(t)) ** 2
        out[i:i + seg] = filt(n[i:i + seg], "bandpass", [fc * 0.7, fc * 1.3])
    tone = np.sin(2 * np.pi * np.cumsum(200 + 900 * (t / sec) ** 2) / SR) * 0.15
    return (out * 0.8 + tone) * (t / sec) ** 2


def sparkle():
    out = np.zeros(int(0.6 * SR))
    for k, n in enumerate((84, 88, 91, 96)):
        p = pluck(n, 0.3) * 1.2
        i = int(k * 0.06 * SR)
        out[i:i + len(p)] += p[: len(out) - i]
    return out


# ---------- arrangement
CHORDS = [  # one per bar: C, G, Am, F, C, G, Am, F
    (48, [60, 64, 67]), (43, [59, 62, 67]), (45, [60, 64, 69]), (41, [60, 65, 69]),
    (48, [60, 64, 67]), (43, [59, 62, 67]), (45, [60, 64, 69]), (41, [60, 65, 69]),
]


def kick_at(t, g=1.0):
    add(kick(g), t, 1.0)
    i = int(t * SR)
    d = 1 - 0.7 * np.exp(-t_arr(0.3) * 12)
    j = min(N, i + len(d))
    duck[i:j] = np.minimum(duck[i:j], d[: j - i])


music_L = np.zeros(N)
music_R = np.zeros(N)

for bar in range(8):
    t0 = bar * BAR
    root, ch = CHORDS[bar]
    groove = bar in (1, 2, 4, 5, 6)
    spin = bar == 3
    if bar == 0:
        add(pad(ch, BAR, 900), t0, 0.8)
    if groove or bar == 7:
        add(pad(ch, BAR), t0, 0.7)
    for b in range(4):
        tb = t0 + b * B
        if groove or spin or (bar == 7 and b == 0):
            kick_at(tb)
        if groove and b in (1, 3):
            add(clap(), tb, 0.7)
        if groove or spin:
            add(hat(), tb + B / 2, 0.8, 0.3)
            add(hat(), tb + B / 4, 0.35, -0.3)
            add(hat(), tb + 3 * B / 4, 0.35, -0.3)
        if groove:
            add(hat(True), tb + B / 2, 0.25, 0.2)
            for e in (0, 1):
                add(bass(root + (12 if e else 0), B / 2), tb + e * B / 2, 0.55)
            add(stab(ch, 0.25), tb + B / 2, 1.0, 0.0)
        if spin:
            add(bass(root, B / 2), tb, 0.45)
            for k, n in enumerate((ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[1] + 12)):
                add(pluck(n), tb + k * B / 4, 0.8, (-0.4, 0.4)[k % 2])
    if bar == 7:
        add(stab(ch, 1.4, 2500), t0, 1.6)
        add(bass(root, 1.2), t0, 0.7)

# hook hits
kick_at(2 * B)
kick_at(3 * B)
add(stab(CHORDS[0][1], 0.4), 2 * B, 1.4)
add(stab([62, 67, 71], 0.6), 3 * B, 1.6)
# final button
kick_at(14.0625)
add(stab([60, 64, 67, 72], 0.9, 3000), 14.0625, 1.6)
add(bass(36, 0.9), 14.0625, 0.8)

music_L[:] = L
music_R[:] = R
L[:] = 0
R[:] = 0

# ---------- effects, timed to index.html
for at in (1.62, 3.6, 9.25, 10.2, 11.15, 12.0):
    add(whoosh(), at, 0.8)
for at in (0.42, 2.205, 12.1875 + B + 0.33):
    add(thud(), at, 0.9)
for at, p in ((B, 900), (2.344, 800), (2.5, 900), (2.656, 1000), (2.812, 1100), (B * 8.5, 700),
              (B * 9, 800), (B * 9 + 0.08, 950), (B * 9 + 0.16, 1100), (B * 12, 900), (12.1875 + B / 2, 900),
              (12.1875 + B * 3, 1000)):
    add(popfx(p), at, 0.8)
add(popfx(1400), B * 11, 1.0)  # tap on SPIN
for at in (2 * B, 3 * B, 7.5, 12.1875 + 2 * B):
    add(impact(), at, 0.7)
for at in (3 * B, 7.5, 9.375, 12.1875):
    add(crash(), at, 0.8)
for at in (7.5, 7.5 + B, 7.5 + 3 * B):
    add(punch(), at, 0.9)
for at in (9.375 + B * 2, 9.375 + B * 4):
    add(impact()[: int(0.4 * SR)], at, 0.45)
add(riser(1.1), 6.4, 0.6)
add(riser(0.45), 1.42, 0.35)
add(sparkle(), 12.1875 + B * 4, 1.0)

# reel ticks: word k reaches the centre when power3.out progress = k / (words - 1)
words, s0, s1 = 17, 5.7, 7.5
last = -1
for k in range(1, words):
    t = s0 + (s1 - s0) * (1 - (1 - k / (words - 1)) ** (1 / 3))
    if t - last > 0.035:
        add(tick(), t, 1.0, (-0.3, 0.3)[k % 2])
        last = t

fxL, fxR = L.copy(), R.copy()
outL = music_L * duck + fxL
outR = music_R * duck + fxR
fade = np.ones(N)
fade[-int(0.25 * SR):] = np.linspace(1, 0, int(0.25 * SR))
out = np.stack([outL, outR], 1) * fade[:, None]
out = np.tanh(out / np.max(np.abs(out)) * 1.6) * 0.89

dst = Path(__file__).resolve().parent.parent / "assets" / "music.wav"
wavfile.write(dst, SR, (out * 32767).astype(np.int16))
print("wrote", dst)
