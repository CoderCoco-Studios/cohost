---
title: Send audio to ears
description: Feed a recorded clip to the ears service over HTTP from Python, TypeScript or curl, and convert a recording into the format ears reads.
track: advanced
verified: f126b94
---

# Send audio to ears

You will send a clip of speech to the ears service from your own program and watch it come back as text the co-host hears. No Discord account and no microphone are involved, which also makes this the easiest way to test the listening path.

## What you need

- A running `ears` service with its `http` [audio source](../../start/glossary.md#audio-source) turned on. [One service on its own](../testing/isolated.md) shows how to start a service with no accounts.
- A clip: a WAV file. For anything else (MP3, M4A, Ogg), the converters below turn it into a WAV.
- One of Python 3 (standard library only), Node 22.18 or later, or `curl`. The TypeScript client runs with `node` on Node 22.18 or later, which strips the types, so there is nothing to install.
- For the converters: `sox` or `ffmpeg`, whichever you already have.

## Turn on the `http` source

The source is a setting of `ears` in `config/config.yaml`. These lines turn it on and name where it listens:

```yaml
ears:
  sources: [http]
  http:
    host: 127.0.0.1
    port: 8765
```

With `stt_engine: stub` the clip is "transcribed" by a stand-in, so nothing else needs to be running. Restart `ears` after the change. In [Docker](../../start/glossary.md#docker), bind `host` to `0.0.0.0` and publish the port yourself, since the default is local only. A non-empty `ears.http.token` in `config/secrets.yaml` makes ears refuse any clip that does not carry it. Every client below sends it automatically when the `EARS_HTTP_TOKEN` variable is set in the shell they run in. Only these example clients read that variable; cohost itself takes the token from `ears.http.token`.

## What a request looks like

A clip is one `POST` to `/audio` with its bytes as the body. The `content-type` is `audio/wav` for a WAV file. Two optional query parameters name where the clip came from: `speaker` is who said it, and `source` names a [connector](../../start/glossary.md#connector)'s source tag (leave it out for plain `http`). Without a `speaker`, the speaker is the source name. ears answers once the clip has been heard, with a small JSON reply:

```text
{"heard":true,"text":"stub transcript (1000 ms)"}
```

A clip that was fine but produced no speech (for example, one that is too short) still answers 200, with `{"heard":false,"reason":"too-short"}`. A refused clip gets another status and a JSON `error`: 400 for audio that cannot be decoded or an unknown `source`, 401 for a missing or wrong token, 413 for a body over 25 MiB, 415 for a content type ears does not read, and 503 when the queue is full. ears resamples any rate and any number of channels itself, so conversion is only needed for formats it does not read.

Whole clips always go to a batch speech-to-text engine: the selected one when it is batch (`speaches`, `openai`, `stub`), otherwise `ears.stt_fallback_engine`. A streaming engine (`nemotron`, `kyutai`) is never used for a clip you send. With a streaming engine selected and `ears.stt_fallback_engine: none`, there is no batch engine, and the clip is answered 502 with `{"heard":false,"reason":"stt-error","detail":"no batch STT engine"}`.

Live audio from a connector source (`ears.sources`, such as `discord`) is transcribed per utterance. `speaches` and `openai` take each utterance whole after it closes. `nemotron` (NeMo-Speech.cpp, `ears.nemotron.url`) and `kyutai` (`moshi-server`, `ears.kyutai.url`) stream the audio as it arrives and return each utterance's final when it closes. Only `kyutai` shows partial text while the speaker talks; `nemotron` publishes finals only. Choose `nemotron` for an NVIDIA server that serves Nemotron Speech Streaming and `kyutai` for a `moshi-server` serving Kyutai STT. When the streaming server refuses or fails an utterance, `ears.stt_fallback_engine` transcribes it instead. `kyutai` can also end an utterance at the server's own end-of-turn signal: set `ears.kyutai.end_of_turn` to `on` (default `off`). It is ignored under `ears.vad.engine: gap`.

**Early reply** (`ears.early.enabled`, default `false`) applies to a connector utterance under a batch engine. After a pause of `ears.early.after_ms` (default 250) ears transcribes what has been said so far and publishes it as `speech.early`. If the speaker resumes, ears publishes `speech.retracted` for it and the utterance goes on as one utterance. If the speaker stops, the final `speech.heard` reuses that transcript (`earlySeq`, `earlySttMs`) without a second transcription; a final that waited for a call still running at the close carries `earlyLate`. `ears.early.max_per_utterance` (default 2) caps the snapshots per utterance. Each pause costs one extra transcription. Turn it on only with a [cortex](../../start/glossary.md#cortex) that holds a provisional focus (the release that includes #225): an earlier cortex would answer a provisional focus as an ordinary one, speaking the early text before the person has finished. The [heartbeat](../../start/glossary.md#heartbeat) detail shows `early: <published> published, <retracted> retracted, <reused> reused, <late> late`; with a streaming engine it shows `early reply off: streaming engine`.

## Send a clip

Each client shows the same call. In every one, the reply is printed, and the exit status is 0 only when ears answered 200.

1. From Python. The sending part of `send_clip.py`:

   <<< @/../examples/audio-in/send_clip.py#send

   Run it with a file, and optionally `--url`, `--speaker` and `--source`, in any order:

   ```sh
   python3 examples/audio-in/send_clip.py clip.wav --speaker Chris
   ```

2. From TypeScript. The sending part of `send-clip.ts`, which takes the same arguments:

   <<< @/../examples/audio-in/send-clip.ts#send

   Run it with `node`, on Node 22.18 or later:

   ```sh
   node examples/audio-in/send-clip.ts clip.wav --speaker Chris
   ```

3. From any language with `curl`. A program in a language with no example here can make the same request. `send.sh` is that request as a script, and it is tested like the two clients:

   <<< @/../examples/audio-in/send.sh#send

   Give it a file and, optionally, the URL:

   ```sh
   sh examples/audio-in/send.sh clip.wav
   ```

The clients leave out `--url` when ears is on its default address, `http://127.0.0.1:8765/audio`. Give `--url` (or the second argument of `send.sh`) for any other address.

## Convert a recording

A WAV with 16 000 samples a second, one channel and 16 bits is what the [speech-to-text](../../start/glossary.md#stt) step reads without resampling. These one-line scripts make one from any file `sox` or `ffmpeg` can read. Each takes the input and the output path:

<<< @/../examples/audio-in/to-wav-sox.sh#convert

<<< @/../examples/audio-in/to-wav-ffmpeg.sh#convert

```sh
sh examples/audio-in/to-wav-sox.sh recording.mp3 clip.wav
```

```sh
sh examples/audio-in/to-wav-ffmpeg.sh recording.m4a clip.wav
```

The tests run each converter on a generated clip. A converter's test is skipped on a machine where its program is not installed, so a script is only known to work where `sox` or `ffmpeg` was present.

## How you know it worked

- A client prints a JSON reply that begins `{"heard":true`, and exits with status 0.
- ears publishes one `speech.heard` [event](../../start/glossary.md#event) for the clip, whose speaker is the one you gave, or `http` when you gave none.
- The co-host reacts to the line, if the rest of the stack is running.
- `pnpm test` runs all three clients against a real `http` source, so the examples stay true to the listener.

## If it didn't

- **The client says it cannot connect.** `ears` is not running, `http` is not in `ears.sources`, or the port differs. Check the address, and that `ears` was restarted after the change.
- **401 with a message about a bearer token.** The listener has a token and your shell does not. Export `EARS_HTTP_TOKEN` with the same value as `ears.http.token` in `config/secrets.yaml` before running the client.
- **400 with `unknown source`.** The `source` you gave is not an enabled connector source. Leave `--source` out for plain `http`.
- **415, or 400 about the audio.** The file is not a 16-bit WAV. Convert it with one of the scripts above.
- **`{"heard":false,"reason":"too-short"}`.** The clip holds less speech than ears will transcribe. Send a longer one.
- **502 with `no batch STT engine`.** `ears.stt_engine` is a streaming engine and `ears.stt_fallback_engine` is `none`, so no batch engine can take the clip. Set the fallback to `speaches` or `openai`, or select a batch engine.
- **A converter fails with "command not found".** Install `sox` or `ffmpeg`, or use the other script.
