#!/bin/sh
# Convert any audio file ffmpeg can read to the 16 kHz, mono, 16-bit WAV ears transcribes without resampling.
#   mise run example:audio-wav:ffmpeg -- <in> <out.wav>
if [ "$#" -ne 2 ]; then
  echo "usage: sh to-wav-ffmpeg.sh <in> <out.wav>" >&2
  exit 2
fi
# region convert
ffmpeg -y -loglevel error -i "$1" -ar 16000 -ac 1 -c:a pcm_s16le "$2"
# endregion convert
