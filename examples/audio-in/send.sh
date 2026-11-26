#!/bin/sh
# Send one WAV clip to cohost's ears `http` source with curl, print the reply, and exit 0 only on a 200.
#   mise run example:audio-send:sh -- <file> [<url>]      (default http://127.0.0.1:8765/audio)
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: sh send.sh <file> [<url>]" >&2
  exit 2
fi
file="$1"
url="${2:-http://127.0.0.1:8765/audio}"

# region send
reply="$(mktemp)"
set -- -sS -o "$reply" -w '%{http_code}' -X POST -H 'content-type: audio/wav' --data-binary "@$file"
if [ -n "${EARS_HTTP_TOKEN:-}" ]; then
  set -- "$@" -H "Authorization: Bearer $EARS_HTTP_TOKEN"
fi
status="$(curl "$@" "$url")" || { rm -f "$reply"; exit 1; }
cat "$reply"
echo
rm -f "$reply"
[ "$status" = "200" ]
# endregion send
