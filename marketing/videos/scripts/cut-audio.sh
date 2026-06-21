#!/usr/bin/env bash
# Trim a raw source track (sources/audio/*) into a shipped, faded cut
# (public/audio/*). Re-run whenever a video's length or source changes.
#
# Usage:
#   scripts/cut-audio.sh <source> <out> <start> <duration> [fade-out-start]
#
# Example — the launch video (≈33s @ 121.75 BPM, kick-locked grid; see
# src/launch/timings.ts). Plays from 0:00; fade-out lands at the end:
#   scripts/cut-audio.sh \
#     sources/audio/launch-theme-source.mp3 public/audio/launch-theme.mp3 0 33.2 31.6
set -euo pipefail

src="${1:?source path}"; out="${2:?output path}"; start="${3:?start seconds}"
dur="${4:?duration seconds}"; fadeout="${5:-}"

af="afade=t=in:st=0:d=0.3"
if [[ -n "$fadeout" ]]; then af="$af,afade=t=out:st=${fadeout}:d=1.5"; fi

mkdir -p "$(dirname "$out")"
ffmpeg -v error -y -ss "$start" -t "$dur" -i "$src" -af "$af" -ar 44100 -ac 2 "$out"
echo "wrote $out (from $src, ${start}s +${dur}s)"
