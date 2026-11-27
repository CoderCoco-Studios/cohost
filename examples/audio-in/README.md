# Audio in

Clients that send a clip to the ears `http` source, and two scripts that
convert a recording into the WAV ears reads without resampling.

| Path | What it is |
| --- | --- |
| `send_clip.py` | Python 3 client, standard library only |
| `send-clip.ts` | TypeScript client, Node built-ins only; runs with `node` on Node 22.18 or later |
| `send.sh` | The same request with `curl`; derives the key with `openssl` |
| `to-wav-sox.sh` | Converts any audio `sox` reads to 16 kHz mono 16-bit WAV |
| `to-wav-ffmpeg.sh` | The same with `ffmpeg` |

Each client reads `CONTROL_TOKEN` from its environment, derives the
listener key from it and sends that key as its bearer, never the token
itself; it exits 1 when the variable is empty or unset. Set it to the value
in cohost's `.env`, then run a client from the checkout (a task runs in the
repository root, so give the clip's path from there or an absolute one):

```sh
export CONTROL_TOKEN=<the value in cohost's .env>
mise run example:audio-send:py -- clip.wav
mise run example:audio-send:ts -- clip.wav
mise run example:audio-send:sh -- clip.wav
```

`send.sh` passes the token to `openssl` as an argument, readable in the process
list while it runs: on a shared machine, use the Python or TypeScript client.
The explanation is on the
[Send audio to ears page](https://codercoco-studios.github.io/cohost/advanced/extend/audio-in).
