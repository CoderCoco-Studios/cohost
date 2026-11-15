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

From the repository root:

```sh
python3 examples/audio-in/send_clip.py clip.wav
node examples/audio-in/send-clip.ts clip.wav
sh examples/audio-in/send.sh clip.wav
```

The explanation is on the
[Send audio to ears page](https://codercoco-studios.github.io/cohost/advanced/extend/audio-in).
