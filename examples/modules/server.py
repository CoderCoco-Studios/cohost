#!/usr/bin/env python3
"""
A custom brain module served over HTTP — the `kind: http` hook.

This is the slot for a model you trained yourself: a sentiment classifier,
a "is chat talking to me" detector, a toxicity filter, anything. The co-host
POSTs JSON to a URL and reads JSON back; what happens in between is yours.
Standard library only, so it runs anywhere:

    python3 examples/modules/server.py            # listens on :8900

Then in config/config.yaml (the co-host runs in Docker, so reach the host by name):

    brain:
      salience: { module: { kind: http, url: "http://host.docker.internal:8900/salience" } }
      affect:   { module: { kind: http, url: "http://host.docker.internal:8900/affect" } }
      cortex:   { critic: { kind: http, url: "http://host.docker.internal:8900/critic" } }

Any error or timeout makes the region fall back to its built-in rules, so a
module can crash, be slow, or be redeployed mid-stream without breaking the show.

The three contracts (request → response):

  POST /salience
    {"events":[{"kind":"chat|speech|vision","who":"name?","text":"...","mention":bool,
                "isMod":bool,"isSub":bool,"changed":bool}, ...], "arousal":0..1}
    → {"scores":[0..1, ...]}            exactly one per event, same order

  POST /affect
    {"source":"chat|speech","who":"name","text":"...","mention":bool,"valence":-1..1,"arousal":0..1}
    → {"valence_delta":-0.5..0.5,"arousal_delta":-0.5..0.5}

  POST /critic
    {"text":"line about to be spoken","emotion":"happy|...","reason":"mentioned|...","transcript":"recent lines"}
    → {"ok":true} | {"ok":true,"text":"fixed line","emotion":"neutral"} | {"ok":false,"note":"why"}

Below, each handler has a tiny stand-in where a real model call would go.
"""
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

# --- the stand-ins. Replace these bodies with your model. --------------------

GAME_WORDS = re.compile(r"\b(boss|died|clutch|raid|gg|clip|pog)\b", re.I)


def salience(req):
    """Which of these events deserve a reaction? Here: a toy that likes game words."""
    scores = []
    for e in req["events"]:
        s = 0.15
        if e["kind"] == "speech":
            s = 0.9
        elif e["mention"]:
            s = 1.0
        elif e["kind"] == "vision":
            s = 0.3 if e["changed"] else 0.0
        if GAME_WORDS.search(e["text"]):
            s = min(1.0, s + 0.25)
        scores.append(s)
    return {"scores": scores}


def affect(req):
    """How does this line move the mood? Here: a two-word lexicon. Yours: a sentiment model."""
    text = req["text"].lower()
    dv = 0.2 if "love" in text else -0.2 if "hate" in text else 0.0
    da = 0.25 if req["mention"] else 0.05
    return {"valence_delta": dv, "arousal_delta": da}


def critic(req):
    """Should this line be said? Here: block anything with a URL, trim to one sentence."""
    text = req["text"]
    if "http" in text:
        return {"ok": False, "note": "no links on air"}
    first = re.split(r"(?<=[.!?])\s+", text.strip())[0]
    return {"ok": True, "text": first} if first != text else {"ok": True}


ROUTES = {"/salience": salience, "/affect": affect, "/critic": critic}

# --- plumbing -----------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        fn = ROUTES.get(self.path)
        if not fn:
            return self._send(404, {"error": "unknown module"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0)) or b"{}"))
            self._send(200, fn(body))
        except Exception as e:  # noqa: BLE001 — a bad answer just means the region uses its rules
            self._send(500, {"error": str(e)})

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print(f"{self.path} {fmt % args}")


if __name__ == "__main__":
    print("custom brain modules on http://0.0.0.0:8900  (/salience /affect /critic)")
    HTTPServer(("0.0.0.0", 8900), Handler).serve_forever()
