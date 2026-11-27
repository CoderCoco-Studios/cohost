#!/bin/sh
# Entrypoint of the tts-pocket container (DEPLOY-ENG-014). Waits, with no timeout, for the Pocket token the control plane
# delivers into the /run/cohost tmpfs (settings-store STORE-DLV-006; the file is always written, empty when no token is set),
# exports a non-empty value as HF_TOKEN for the server process alone, deletes the file and replaces this shell with the
# command the service names. A container Docker restarts by itself waits here until the dashboard or `mise run deliver`
# delivers again.
# @spec DEPLOY-ENG-014
set -eu
TOKEN_FILE=/run/cohost/hf_token
if [ ! -f "$TOKEN_FILE" ]; then echo "tts-pocket: waiting for credentials" >&2; fi
while [ ! -f "$TOKEN_FILE" ]; do sleep 1; done
HF_TOKEN="$(cat "$TOKEN_FILE")"
rm -f "$TOKEN_FILE"
if [ -n "$HF_TOKEN" ]; then export HF_TOKEN; else unset HF_TOKEN; fi
exec "$@"
