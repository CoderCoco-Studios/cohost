#!/bin/sh
# Send one WAV clip to cohost's ears `http` source with curl, print the reply, and exit 0 only on a 200.
#   CONTROL_TOKEN=<cohost's control token> mise run example:audio-send:sh -- <file> [<url>]
#   (default url http://127.0.0.1:8765/audio)
# The listener key is derived from CONTROL_TOKEN with openssl; the token itself is never sent. `openssl dgst -hmac` takes the
# token as a command-line argument, so another user of this machine can read it in the process list while openssl runs; the
# Python and TypeScript clients keep it in memory.
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: sh send.sh <file> [<url>]" >&2
  exit 2
fi
file="$1"
url="${2:-http://127.0.0.1:8765/audio}"

# region send
# The listener key: HMAC-SHA256 keyed with the trimmed CONTROL_TOKEN of the label cohost/ears-listener/v1, as hex.
token="$(printf '%s' "${CONTROL_TOKEN:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ -z "$token" ]; then
  echo "send.sh: set CONTROL_TOKEN to cohost's control token (from your password manager)" >&2
  exit 1
fi
key="$(printf '%s' "cohost/ears-listener/v1" | openssl dgst -sha256 -hmac "$token" | sed 's/^.*= //')" || exit 1
[ ${#key} -eq 64 ] || exit 1
reply="$(mktemp)"
status="$(curl -sS -o "$reply" -w '%{http_code}' -X POST -H 'content-type: audio/wav' -H "Authorization: Bearer $key" \
  --data-binary "@$file" "$url")" || { rm -f "$reply"; exit 1; }
cat "$reply"
echo
rm -f "$reply"
[ "$status" = "200" ]
# endregion send
