# Video pipeline: brief → storyboard → motion → sound → render → launch

How Indigo turns a brief into a finished, delivered video, and what each of the 16 tools Fernando shared on
2026-11-06 is good for. Everything marked **tested** ran in a Claude cloud session that day: 4 CPUs, 15 GB of
RAM, no GPU, Node 22, Python 3.13 and FFmpeg 6.1 preinstalled. The working project is `assets/video-starter/`.

Contents: [The toolkit](#the-toolkit) · [Setup](#setup) · [1 Brief](#1-brief) · [2 Storyboard](#2-storyboard) ·
[3 Motion](#3-motion) · [4 Sound](#4-sound) · [5 Render](#5-render) · [6 Launch](#6-launch)

## The toolkit

The source was a list Fernando pasted on 2026-11-06 with the framing "pair them with Opus and go from a brief to
a finished video"; the original link wasn't given. The verdicts below come from installing and running the
tools here where possible, plus npm and PyPI metadata. The repos themselves weren't opened, because they're
outside this session's GitHub scope.

| # | Tool | Stage | What it is | Runs in a Claude session? | How Indigo uses it | License |
|---|---|---|---|---|---|---|
| 1 | **Remotion** (remotion-dev/remotion) | motion, render | Videos written as React components and rendered frame by frame in headless Chrome | **Yes, tested** (4.0.541) | The backbone: every video is a Remotion project | Remotion License: free for individuals, companies of up to 3 people and non-profits; larger for-profits need a company license (remotion.pro). The terms change in Remotion 5.0 |
| 2 | **Storyboarder** (wonderunit/storyboarder) | storyboard | Desktop app for drawing boards and timing animatics | No, it's a desktop app | Fernando's own sketching. In a session, the storyboard is a shot list plus rendered stills, and the animatic is those stills timed to temp audio | MIT |
| 3 | **Anime.js** (juliangarnier/anime) | motion | Animation engine: timelines, easings, springs, stagger, SVG morph and line drawing, text splitting | **Yes, tested** (4.5.0) | Live animation on web pages and artifacts. In Remotion, use its eases as plain functions (tested) or a paused timeline seeked to the frame (untested) | MIT |
| 4 | **Flubber** (veltman/flubber) | motion | Smooth morphs between any two SVG shapes | **Yes, tested** (0.4.2) | Logo and icon morphs. It's old but stable. For two similar paths, Anime.js `morphTo` is enough | MIT |
| 5 | **Pixelorama** (Orama-Interactive/Pixelorama) | assets | Pixel-art editor and sprite animator (Godot) | No, it's a desktop app | Fernando's hand-drawn sprites. In a session, pixel art is made in code (PIL, or SVG rects with `image-rendering: pixelated`) and upscaled nearest-neighbour | MIT |
| 6 | **Three.js** (mrdoob/three.js) | motion | 3D scenes, lights, cameras, materials | **Yes**: software WebGL works (tested with a shader); a Three.js scene itself is untested | 3D product shots and camera moves, through `@remotion/three` (`ThreeCanvas`) so it syncs to frames. Keep scenes light, since rendering is on the CPU | MIT |
| 7 | **PlayCanvas** (playcanvas/engine) | motion | WebGL/WebGPU engine for real-time 3D worlds | In a browser, yes; untested | Interactive 3D on sites and artifacts. For rendered video, Three.js in Remotion is simpler | MIT |
| 8 | **cannon-es** (pmndrs/cannon-es) | motion | 3D rigid-body physics | **Yes**, pure JS; untested | Drops, bounces and collisions. Physics must be deterministic: from frame 0, step the world by a fixed `1/fps` up to the current frame (or pre-bake the positions), never by the wall clock | MIT |
| 9 | **Sverchok** (nortikin/sverchok) | assets | Blender add-on for node-based procedural geometry | No, it needs Blender, which isn't installed | Fernando's Blender work. In a session, procedural geometry is written in Three.js code, and Higgsfield's image-to-3D (GLB) costs credits | GPL-3.0 |
| 10 | **Effekseer** (effekseer/Effekseer) | motion | Particle-effect editor, with runtimes for game engines and WebGL | The editor is a desktop app; untested | Fernando's game effects. In a session, particles use Three.js `Points` or shaders, with seeded randomness so every render matches | MIT |
| 11 | **twigl** (doxas/twigl) | motion | Browser GLSL live-coding editor with GIF/WebM export | The site is for Fernando; the shaders it produces run here (**tested**) | Write a fragment shader (twigl "classic" style, with `resolution` and `time` uniforms) and drop it into a Remotion canvas layer | MIT |
| 12 | **Bark** (suno-ai/bark) | sound | Text-to-audio model for speech, laughs and short musical bits | Not practical: it wants a GPU and multi-GB model downloads, and this container is CPU-only | Use Higgsfield voices and audio instead (ask first, it spends credits), or Fernando's own recording. Bark is an option on a GPU machine | MIT |
| 13 | **Pedalboard** (spotify/pedalboard) | sound | Python audio effects (EQ, compression, reverb, limiting), VST3/AU host, audio file I/O | **Yes, tested** (0.9.26) | Finishes every sound: high-pass, compressor, reverb, limiter | GPL-3.0 (fine as a tool; don't ship it inside closed-source software) |
| 14 | **OBS Studio** (obsproject/obs-studio) | capture | Screen recording and streaming | No, it's a desktop app | Fernando's own screen recordings. In a session, Playwright's `recordVideo` records any page to WebM (**tested**), which suits product demos of Company Floor or Xglide | GPL-2.0+ |
| 15 | **Shotcut** (mltframework/shotcut) | edit | Timeline video editor (MLT) | No, it's a desktop app | Fernando's manual finishing. In a session, the timeline is Remotion `<Series>`/`<Sequence>`, and trims and joins are done with FFmpeg | GPL-3.0 |
| 16 | **FFmpeg** (FFmpeg/FFmpeg) | launch | Encoding, conversion, compression, muxing | **Yes, installed and tested** (6.1.1, with libass, x264/x265, VP9, AV1, Opus) | `deliver.sh`: masters, verticals, GIFs, posters, loudness | LGPL/GPL |

**The rule of thumb:** code libraries (1, 3, 4, 6, 7, 8, 11, 13, 16) run in the session. Desktop apps
(2, 5, 9, 10, 14, 15) are for Fernando's computer, and each has a substitute in the table. Bark needs a GPU.

## Setup

```bash
W=<scratchpad or project dir>/video-<name>
cp -r .claude/skills/designer/assets/video-starter "$W" && cd "$W"
npm install                                    # Remotion, Flubber, Anime.js, React (about 10 s)
python3 -m venv .venv && .venv/bin/pip install pedalboard numpy
```

Add `@remotion/three three` for 3D, `cannon-es` for physics, and `@remotion/google-fonts` for web fonts.

## 1 Brief

Write the brief in one line, then pin down:

- **Where it goes:** this sets the shape. A landing-page loop is 16:9 or 4:5, muted and 6-12 s. YouTube is
  16:9. Reels, TikTok and Shorts are 9:16 at 1080×1920. LinkedIn and X take 1:1 or 16:9. A README or doc gets
  a GIF.
- **Length**, **the one idea** and **the call to action**.
- **Sound or silent?** Social video autoplays muted, so the story must work without sound and captions get
  burned in.

## 2 Storyboard

Write a shot list first:

| Shot | Seconds | What we see | What we hear | Transition out |
|---|---|---|---|---|
| 1 | 0-1.5 | The hook: the one idea, big | Whoosh | Morph |

Then build the composition roughly, render one still per shot with `renderStill` at each shot's key frame,
and tile them into a board:

```bash
ffmpeg -y -i out/shot%02d.png -filter_complex "scale=640:-1,tile=3x2:padding=16:color=black" out/board.png
```

Show Fernando the board (as an image, or an artifact page for comments) **before animating**. The animatic is
the same stills in a `<Series>`, each held for its seconds, with temp audio.

## 3 Motion

- **Everything is a pure function of the frame.** Use `useCurrentFrame()`, `interpolate()` and `spring()`.
  Don't use `Math.random()` (use Remotion's `random('seed')`), `Date.now()`, CSS transitions or animations,
  or `requestAnimationFrame` loops. Anything that runs on its own clock renders wrong or flickers.
- **Anime.js eases** (tested): `import {eases} from 'animejs'; const e = eases.outElastic(1, 0.45); e(progress)`.
  v4's API (`animate`, `createTimeline`, `eases`, `utils`) differs from v3's (`anime()`, `anime.timeline`), so
  don't copy v3 examples.
- **Flubber** (tested): build the interpolator once, outside the component:
  `const m = interpolate(shapeA, shapeB, {maxSegmentLength: 4}); <path d={m(t)} />`. Shapes can be SVG path
  strings or arrays of `[x, y]` points.
- **Shaders** (tested): a `<canvas>` with a WebGL context created with `preserveDrawingBuffer: true`, drawn in
  `useLayoutEffect` with `time = frame / fps`. See `ShaderBg` in `src/Promo.jsx`.
- **3D:** `@remotion/three`'s `<ThreeCanvas>` with `useCurrentFrame()` driving the camera and objects.
- **Fonts:** load them with `@remotion/google-fonts`, or with `staticFile()` plus `delayRender()` until
  loaded. Otherwise the first frames render in a fallback font.
- **Easing taste:** ease-out for things arriving, ease-in for things leaving, ease-in-out for moves on screen.
  Use springs with high damping for UI and elastic only for a single playful beat. Most motion lasts
  0.3-0.8 s, and stagger offsets run 30-60 ms.
- **Live preview:** `npx remotion studio src/index.jsx` serves a preview on a port. Report that port so
  Fernando can watch it from the app.

## 4 Sound

- **Effects and music:** `sound.py` shows a synthesized whoosh and chime finished with a Pedalboard chain
  (`HighpassFilter → Compressor → Reverb → Gain → Limiter`). Supplied tracks go through the same kind of
  chain.
- **Voice:** use a Higgsfield voice (ask first, it spends credits) or Fernando's recording; Bark only on a GPU
  machine. Write the script to the storyboard timings at about 2.5 words per second.
- **Mix:** keep music 12-18 dB under the voice, or duck it with FFmpeg's `sidechaincompress`. Hit the sound
  effects on the motion's key frames. `deliver.sh` brings the final mix to -14 LUFS.
- In Remotion, `<Audio src={staticFile('sound.wav')} />` puts sound in the render. The alternative is to mux
  it afterwards in `deliver.sh`, which is what the starter does.

## 5 Render

`node render.mjs [compositionId] [stillFrame]` renders `out/<id>.mp4` and a still.

- It uses the container's own headless Chromium (`/opt/pw-browsers/chromium_headless_shell-*`) and
  `gl: 'swangle'` for WebGL without a GPU.
- The "Detected differing memory amounts" warnings are harmless.
- Speed: 90 frames at 720p rendered in about 6-7 s here. Heavy 3D or 4K will take much longer, so render a
  low-resolution draft first (`scale` option) and the full size last.
- **Watch the output before handing it over.** Extract a few frames with
  `ffmpeg -ss 1 -i out/Promo.mp4 -frames:v 1 f.png` and look at them with Read.

## 6 Launch

`./deliver.sh out/Promo.mp4 out/sound.wav out/final` produces:

- `final-16x9.mp4`: H.264 + AAC, -14 LUFS, faststart
- `final-9x16.mp4`: 1080×1920 centre crop. Recompose in Remotion when the subject isn't centred, and keep
  text out of the bottom fifth and right edge, where the app's buttons sit.
- `final.gif`: 480 px wide with a custom palette
- `final-poster.jpg`: a frame from 1.5 s in

Extras:

- **Captions:** render them in Remotion for real typography, or burn them in from an SRT file with
  `-vf subtitles=captions.srt:force_style='FontSize=18,Outline=1'`, since this build has libass.
- **Web loop:** `-c:v libvpx-vp9 -b:v 0 -crf 34 -an` for WebM, plus the MP4. Keep it under about 3 MB, add a
  poster, and make the first and last frames match.
- **Review:** publish the video to an artifact page (the Artifact tool's asset upload) so Fernando can watch
  and comment from a phone.
