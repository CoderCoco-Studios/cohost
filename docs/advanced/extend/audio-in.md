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
- The `CONTROL_TOKEN` from cohost's `.env`, set in the shell you run a client in. ears checks a key derived from it on every clip, on loopback too.
- A checkout of cohost with mise: each client runs from it through an `example:audio-send:*` task, with the Python and Node from `mise.toml`. A copy of a client outside the checkout needs Python 3 (standard library only), Node 22.18 or later, or `curl` and `openssl`. The TypeScript client runs with `node` on Node 22.18 or later, which strips the types, so there is nothing to install.
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

With `stt_engine: stub` the clip is "transcribed" by a stand-in, so nothing else needs to be running. Restart `ears` after the change. In [Docker](../../start/glossary.md#docker), bind `host` to `0.0.0.0` and publish the port yourself, since the default is local only. ears refuses any clip that does not carry the listener key: `Authorization: Bearer <key>`, where the key is HMAC-SHA256 keyed with the trimmed `CONTROL_TOKEN` of the label `cohost/ears-listener/v1`, written as 64 lowercase hex digits. The control plane derives the key and hands it to `ears` when it starts it, so start `ears` through the dashboard or `cohostctl` (or `mise run dev`, which projects the secrets first); ears itself never sees the token. Every client below reads `CONTROL_TOKEN` from the shell it runs in, derives the key and sends it, never the token itself, and exits 1 with a message naming `CONTROL_TOKEN` when the variable is empty or unset:

```sh
export CONTROL_TOKEN=<the value in cohost's .env>
```

## What a request looks like

A clip is one `POST` to `/audio` with its bytes as the body. The `content-type` is `audio/wav` for a WAV file. Two optional query parameters name where the clip came from: `speaker` is who said it, and `source` names a [connector](../../start/glossary.md#connector)'s source tag (leave it out for plain `http`). Without a `speaker`, the speaker is the source name. ears answers once the clip has been heard, with a small JSON reply:

```text
{"heard":true,"text":"stub transcript (1000 ms)"}
```

A clip that was fine but produced no speech (for example, one that is too short) still answers 200, with `{"heard":false,"reason":"too-short"}`. A refused clip gets another status and a JSON `error`: 400 for audio that cannot be decoded or an unknown `source`, 401 for a missing or wrong listener key, 413 for a body over 25 MiB, 415 for a content type ears does not read, and 503 when the queue is full. ears resamples any rate and any number of channels itself, so conversion is only needed for formats it does not read.

Whole clips always go to a batch speech-to-text engine: the selected one when it is batch (`speaches`, `openai`, `stub`), otherwise `ears.stt_fallback_engine`. A streaming engine (`nemotron`, `kyutai`) is never used for a clip you send. With a streaming engine selected and `ears.stt_fallback_engine: none`, there is no batch engine, and the clip is answered 502 with `{"heard":false,"reason":"stt-error","detail":"no batch STT engine"}`.

Live audio from a connector source (`ears.sources`, such as `discord`) is transcribed per utterance. `speaches` and `openai` take each utterance whole after it closes. `nemotron` (NeMo-Speech.cpp, `ears.nemotron.url`) and `kyutai` (`moshi-server`, `ears.kyutai.url`) stream the audio as it arrives and return each utterance's final when it closes. Only `kyutai` shows partial text while the speaker talks; `nemotron` publishes finals only. Choose `nemotron` for an NVIDIA server that serves Nemotron Speech Streaming and `kyutai` for a `moshi-server` serving Kyutai STT. When the streaming server refuses or fails an utterance, `ears.stt_fallback_engine` transcribes it instead. `kyutai` can also end an utterance at the server's own end-of-turn signal: set `ears.kyutai.end_of_turn` to `on` (default `off`). It is ignored under `ears.vad.engine: gap`.

**Early reply** (`ears.early.enabled`, default `false`) applies to a connector utterance under a batch engine. After a pause of `ears.early.after_ms` (default 250) ears transcribes what has been said so far and publishes it as `speech.early`. If the speaker resumes, ears publishes `speech.retracted` for it and the utterance goes on as one utterance. If the speaker stops, the final `speech.heard` reuses that transcript (`earlySeq`, `earlySttMs`) without a second transcription; a final that waited for a call still running at the close carries `earlyLate`. `ears.early.max_per_utterance` (default 2) caps the snapshots per utterance. Each pause costs one extra transcription. Turn it on only with a [cortex](../../start/glossary.md#cortex) that holds a provisional focus (the release that includes #225): an earlier cortex would answer a provisional focus as an ordinary one, speaking the early text before the person has finished. The [heartbeat](../../start/glossary.md#heartbeat) detail shows `early: <published> published, <retracted> retracted, <reused> reused, <late> late`; with a streaming engine it shows `early reply off: streaming engine`.

## Send a clip

Each client shows the same call. In every one, the reply is printed, and the exit status is 0 only when ears answered 200. Each runs from the checkout through its task, with the arguments after `--`. A task runs in the repository root, so give the clip's path from there, or an absolute path.

1. From Python. The sending part of `send_clip.py`:

   <<< @/../examples/audio-in/send_clip.py#send

   Run it with a file, and optionally `--url`, `--speaker` and `--source`, in any order:

   ```sh
   mise run example:audio-send:py -- clip.wav --speaker Chris
   ```

2. From TypeScript. The sending part of `send-clip.ts`, which takes the same arguments:

   <<< @/../examples/audio-in/send-clip.ts#send

   The task runs it with `node`, which on Node 22.18 or later strips the types:

   ```sh
   mise run example:audio-send:ts -- clip.wav --speaker Chris
   ```

3. From any language with `curl`. A program in a language with no example here can make the same request. `send.sh` is that request as a script, and it is tested like the two clients; it derives the key with `openssl`, so it needs `openssl` as well as `curl`:

   <<< @/../examples/audio-in/send.sh#send

   Give it a file and, optionally, the URL:

   ```sh
   mise run example:audio-send:sh -- clip.wav
   ```

The clients leave out `--url` when ears is on its default address, `http://127.0.0.1:8765/audio`. Give `--url` (or the second argument of `send.sh`) for any other address.

To use a client in your own program, copy its file out of the checkout and run the copy with its own tool:

```sh
python3 send_clip.py clip.wav --speaker Chris
node send-clip.ts clip.wav --speaker Chris
sh send.sh clip.wav
```

## Convert a recording

A WAV with 16 000 samples a second, one channel and 16 bits is what the [speech-to-text](../../start/glossary.md#stt) step reads without resampling. These one-line scripts make one from any file `sox` or `ffmpeg` can read. Each takes the input and the output path:

<<< @/../examples/audio-in/to-wav-sox.sh#convert

<<< @/../examples/audio-in/to-wav-ffmpeg.sh#convert

```sh
mise run example:audio-wav:sox -- recording.mp3 clip.wav
```

```sh
mise run example:audio-wav:ffmpeg -- recording.m4a clip.wav
```

The tests run each converter on a generated clip. `sox` and `ffmpeg` do not come from `mise.toml`, so a converter's test is skipped on a machine where its program is not installed, and a script is only known to work where `sox` or `ffmpeg` was present.

## How you know it worked

- A client prints a JSON reply that begins `{"heard":true`, and exits with status 0.
- ears publishes one `speech.heard` [event](../../start/glossary.md#event) for the clip, whose speaker is the one you gave, or `http` when you gave none.
- The co-host reacts to the line, if the rest of the stack is running.
- `mise run test` runs all three clients against a real `http` source, so the examples stay true to the listener.

## If it didn't

- **The client says it cannot connect.** `ears` is not running, `http` is not in `ears.sources`, or the port differs. Check the address, and that `ears` was restarted after the change.
- **The client exits 1 naming `CONTROL_TOKEN`.** The variable is empty or unset in your shell. Export it with the value in cohost's `.env` before running the client.
- **401 with a message about a bearer token.** The key your client derived does not match the one ears was given. Check that `CONTROL_TOKEN` in your shell is the whole value from `.env`. If ears' health shows `deps.http` down with the listener key missing, ears was started without one: start it through the dashboard or `cohostctl`. After `CONTROL_TOKEN` changes, press **Restart all** so ears gets the new key.
- **400 with `unknown source`.** The `source` you gave is not an enabled connector source. Leave `--source` out for plain `http`.
- **415, or 400 about the audio.** The file is not a 16-bit WAV. Convert it with one of the scripts above.
- **`{"heard":false,"reason":"too-short"}`.** The clip holds less speech than ears will transcribe. Send a longer one.
- **502 with `no batch STT engine`.** `ears.stt_engine` is a streaming engine and `ears.stt_fallback_engine` is `none`, so no batch engine can take the clip. Set the fallback to `speaches` or `openai`, or select a batch engine.
- **A converter fails with "command not found".** Install `sox` or `ffmpeg`, or use the other script.
