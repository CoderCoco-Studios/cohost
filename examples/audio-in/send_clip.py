"""Send one audio clip to cohost's ears `http` source. Standard library only.

    CONTROL_TOKEN=<cohost's control token> mise run example:audio-send:py -- <file> [--url <url>] [--speaker <name>] [--source <tag>]

The listener key is derived from CONTROL_TOKEN, read from this command's environment only (export it from
your password manager); the token itself is never sent.

A copy outside the checkout runs as `python3 send_clip.py <file> ...`.
"""
import hashlib
import hmac
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8765/audio"
USAGE = "usage: python3 send_clip.py <file> [--url <url>] [--speaker <name>] [--source <tag>]"


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def parse(argv):
    """Returns (file, options). Options may come before or after the file."""
    options = {"--url": DEFAULT_URL}
    files = []
    i = 0
    while i < len(argv):
        if argv[i] in ("--url", "--speaker", "--source"):
            if i + 1 >= len(argv):
                fail(USAGE)
            options[argv[i]] = argv[i + 1]
            i += 2
        elif argv[i].startswith("--"):
            fail(USAGE)
        else:
            files.append(argv[i])
            i += 1
    if len(files) != 1:
        fail(USAGE)
    return files[0], options


# region send
def listener_key(token):
    """The listener key: HMAC-SHA256 keyed with the trimmed control token of the label cohost/ears-listener/v1, as hex."""
    return hmac.new(token.strip().encode(), b"cohost/ears-listener/v1", hashlib.sha256).hexdigest()


def send(path, url, key, speaker=None, source=None):
    """POST the file's bytes as audio/wav with the listener key. Returns (status, reply body)."""
    with open(path, "rb") as f:
        body = f.read()
    query = {k: v for k, v in (("speaker", speaker), ("source", source)) if v}
    if query:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
    headers = {"content-type": "audio/wav", "authorization": "Bearer " + key}
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request) as reply:
            return reply.status, reply.read().decode()
    except urllib.error.HTTPError as err:  # a refusal still has a reply body worth printing
        return err.code, err.read().decode()
# endregion send


def main():
    path, options = parse(sys.argv[1:])
    token = os.environ.get("CONTROL_TOKEN", "").strip()
    if not token:
        fail("send_clip.py: set CONTROL_TOKEN to cohost's control token (from your password manager)")
    try:
        status, text = send(path, options["--url"], listener_key(token), options.get("--speaker"), options.get("--source"))
    except (OSError, ValueError) as err:
        fail(f"send_clip.py: {err}")
    print(text)
    sys.exit(0 if status == 200 else 1)


if __name__ == "__main__":
    main()
