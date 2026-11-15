#!/bin/sh
# Ask a hook server the three questions cohost asks it, and print each reply on its own line.
#
#   sh examples/modules/try.sh                          # a server on this machine, port 8900
#   sh examples/modules/try.sh http://127.0.0.1:9000    # a server somewhere else
#
# A server in any language is right when this prints the lines of try.expected.txt
# (the same JSON; spacing and 1.0 versus 1 do not matter).
base="${1:-http://127.0.0.1:8900}"

# region requests
curl -s -X POST "$base/salience" -H 'content-type: application/json' \
  -d '{"events":[{"kind":"chat","who":"viewer","text":"hey Coco?","mention":true,"isMod":false,"isSub":false,"changed":false}],"arousal":0.2}'
echo
curl -s -X POST "$base/affect" -H 'content-type: application/json' \
  -d '{"source":"chat","who":"viewer","text":"I love this game","mention":false,"valence":0,"arousal":0.3}'
echo
curl -s -X POST "$base/critic" -H 'content-type: application/json' \
  -d '{"text":"Nice one. Did you see that?","emotion":"happy","reason":"mentioned","transcript":""}'
echo
# endregion requests
