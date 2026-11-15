"""Send one audio clip to cohost's ears `http` source. Standard library only.

    python3 examples/audio-in/send_clip.py <file> [--url <url>] [--speaker <name>] [--source <tag>]
"""
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
def send(path, url, speaker=None, source=None):
    """POST the file's bytes as audio/wav. Returns (status, reply body)."""
    with open(path, "rb") as f:
        body = f.read()
    query = {k: v for k, v in (("speaker", speaker), ("source", source)) if v}
    if query:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
    headers = {"content-type": "audio/wav"}
    token = os.environ.get("EARS_HTTP_TOKEN", "")
    if token:
        headers["authorization"] = "Bearer " + token
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request) as reply:
            return reply.status, reply.read().decode()
    except urllib.error.HTTPError as err:  # a refusal still has a reply body worth printing
        return err.code, err.read().decode()
# endregion send


def main():
    path, options = parse(sys.argv[1:])
    try:
        status, text = send(path, options["--url"], options.get("--speaker"), options.get("--source"))
    except (OSError, ValueError) as err:
        fail(f"send_clip.py: {err}")
    print(text)
    sys.exit(0 if status == 200 else 1)


if __name__ == "__main__":
    main()
