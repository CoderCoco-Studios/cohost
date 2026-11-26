# Audio in

Clients that send a clip to the ears `http` source, and two scripts that
convert a recording into the WAV ears reads without resampling.

| Path | What it is |
| --- | --- |
| `send_clip.py` | Python 3 client, standard library only |
| `send-clip.ts` | TypeScript client, Node built-ins only; runs with `node` on Node 22.18 or later |
| `send.sh` | The same request with `curl` |
| `to-wav-sox.sh` | Converts any audio `sox` reads to 16 kHz mono 16-bit WAV |
| `to-wav-ffmpeg.sh` | The same with `ffmpeg` |

From the checkout (a task runs in the repository root, so give the clip's
path from there or an absolute one):

```sh
mise run example:audio-send:py -- clip.wav
mise run example:audio-send:ts -- clip.wav
mise run example:audio-send:sh -- clip.wav
```

The explanation is on the
[Send audio to ears page](https://codercoco-studios.github.io/cohost/advanced/extend/audio-in).
