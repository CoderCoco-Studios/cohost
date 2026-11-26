#!/bin/sh
# Convert any audio file sox can read to the 16 kHz, mono, 16-bit WAV ears transcribes without resampling.
#   mise run example:audio-wav:sox -- <in> <out.wav>
if [ "$#" -ne 2 ]; then
  echo "usage: sh to-wav-sox.sh <in> <out.wav>" >&2
  exit 2
fi
# region convert
sox "$1" -r 16000 -c 1 -b 16 "$2"
# endregion convert
