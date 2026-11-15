#!/bin/sh
# Sends cohost's two requests to an OpenAI-compatible server and prints each reply on one line.
#   sh examples/model-stub/try.sh [base-url]      (default http://127.0.0.1:8901/v1)
base="${1:-http://127.0.0.1:8901/v1}"

# region requests
# The health check: cohost asks for the model list.
curl -sS "$base/models"
echo
# A chat turn: cohost sends the messages and reads choices[0].message.content.
curl -sS "$base/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"stub","messages":[{"role":"user","content":"Say hello."}],"stream":false}'
echo
# endregion requests
