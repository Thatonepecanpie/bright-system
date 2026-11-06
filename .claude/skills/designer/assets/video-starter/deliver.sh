#!/usr/bin/env bash
# Finish and deliver: mux picture + sound, normalise loudness, then make web 16:9, vertical 9:16, a GIF and a poster.
# Usage: ./deliver.sh out/Promo.mp4 out/sound.wav out/final
set -euo pipefail
video=$1; audio=$2; name=$3

# 16:9 master: H.264 + AAC, -14 LUFS (social/web loudness), faststart so it plays while downloading.
ffmpeg -v error -y -i "$video" -i "$audio" -c:v libx264 -crf 20 -preset slow -pix_fmt yuv420p \
  -af "loudnorm=I=-14:TP=-1.5:LRA=11" -c:a aac -b:a 160k -shortest -movflags +faststart "$name-16x9.mp4"

# 9:16 vertical (Reels, TikTok, Shorts): centre crop. Recompose instead when the subject isn't centred.
ffmpeg -v error -y -i "$name-16x9.mp4" -vf "crop=ih*9/16:ih,scale=1080:1920:flags=lanczos" \
  -c:v libx264 -crf 21 -pix_fmt yuv420p -c:a copy -movflags +faststart "$name-9x16.mp4"

# GIF preview with its own palette (two-pass in one filter graph).
ffmpeg -v error -y -i "$name-16x9.mp4" -vf "fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" "$name.gif"

# Poster frame from 1.5 s in.
ffmpeg -v error -y -ss 1.5 -i "$name-16x9.mp4" -frames:v 1 "$name-poster.jpg"

ls -la "$name"*
