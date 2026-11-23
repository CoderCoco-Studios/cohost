#!/bin/sh
# Entrypoint of the tts-pocket container (DEPLOY-ENG-014). When Launch has written the Pocket TTS token file, export its
# content as HF_TOKEN for the server process alone, then replace this shell with the command the service names.
# @spec DEPLOY-ENG-014
set -eu
TOKEN_FILE=/run/cohost-secret/hf_token
if [ -f "$TOKEN_FILE" ]; then
  HF_TOKEN="$(cat "$TOKEN_FILE")"
  export HF_TOKEN
fi
exec "$@"
