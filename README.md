# cohost

A locally hosted AI VTuber co-host for your stream. It watches your game
through OBS, reads Twitch chat, sits in your Discord voice channel, remembers
people and running jokes across streams, and drives a 2D (VTube Studio) or 3D
(VRM / VMC) avatar. Every piece is its own container on a Redis bus, so nothing
is monolithic and anything can be swapped.

## Quick start

Try it with no accounts: no Twitch, Discord, OBS, GPU or API key. You need
Linux or WSL2 (Ubuntu or Debian). The installer sets up Docker, Node and pnpm,
and may ask you to log out and back in once; run it again after that.

```bash
git clone https://github.com/CoderCoco-Studios/cohost.git
cd cohost
./scripts/install.sh
cat >> .env <<'EOF'
LLM_PROVIDER=mock
MEMORY_STORE=memory
MEMORY_EMBEDDER=hash
VOICE_ENGINE=stub
CHAT_SOURCE=fake
EOF
pnpm dashboard
```

Open the URL the dashboard prints (<http://localhost:3000> by default), enter
the `CONTROL_TOKEN` from `.env`, and press Launch. For real accounts, follow
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
