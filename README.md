# cohost

A locally hosted AI VTuber co-host for your stream. It watches your game
through OBS, reads Twitch chat, sits in your Discord voice channel, remembers
people and running jokes across streams, and drives a 2D (VTube Studio) or 3D
(VRM / VMC) avatar. Every piece is its own container on a Redis bus, so nothing
is monolithic and anything can be swapped.

## Quick start

Try it with no accounts: no Twitch, Discord, OBS, GPU or API key. You need
Linux or WSL2 (Ubuntu or Debian). The installer sets up Docker and mise, which
installs the project's Node, pnpm, Rust, Zig and Python. It may ask you to log
out and back in once; run it again after that. When it finishes, open a new
shell so mise is active, and run the last line there.

```bash
git clone https://github.com/CoderCoco-Studios/cohost.git
cd cohost
./scripts/install.sh
mise run dashboard
```

Open the URL the dashboard prints (<http://localhost:3000> by default) and press
Launch; on this PC nothing asks for a token. To reach mock mode, edit no
file: on the Services screen, tick **isolated** and press Start (or Restart) on
`chat`, `memory`, `cortex` and `voice`, which gives each a stand-in backend.
Nothing is appended to `.env`. For real accounts, follow
[Install for real](https://codercoco-studios.github.io/cohost/guide/install/real-install).

## Documentation

Everything else lives on the [docs site](https://codercoco-studios.github.io/cohost/).

- [What is cohost?](https://codercoco-studios.github.io/cohost/start/what-is-cohost)
- [What you need](https://codercoco-studios.github.io/cohost/guide/install/prerequisites)
- [Developer setup](https://codercoco-studios.github.io/cohost/advanced/dev-setup)
- [How specs work](https://codercoco-studios.github.io/cohost/project/spec-driven)

## License

AGPL-3.0-only, with a commercial licence available from CoderCoco. See
[LICENSE](LICENSE), [COMMERCIAL.md](COMMERCIAL.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).
