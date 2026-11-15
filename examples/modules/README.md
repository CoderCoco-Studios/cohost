# Brain hooks examples

Three servers that answer the three brain hooks (salience, affect, the cortex
critic) over HTTP, all with the same toy judgements on port 8900.

| Path | What it is |
| --- | --- |
| `server.py` | Python, standard library only |
| `server.ts` | TypeScript on Node 22.18 or later, built-in modules only |
| `rust/` | Rust package `cohost-example-hook-server` (`serde_json` only) |
| `try.sh` | `curl` script that asks a server the three questions; `try.expected.txt` holds the replies |
| `fixtures/` | `contracts.json`, sample requests and replies for the three endpoints |
| `schemas/` | JSON Schema of each reply: `schemas/salience.json`, `schemas/affect.json`, `schemas/critic.json` |

Run one from the repository root, then `sh examples/modules/try.sh` in another terminal:

```shell
python3 examples/modules/server.py
node examples/modules/server.ts
cargo run --manifest-path examples/Cargo.toml -p cohost-example-hook-server
```

The contracts, every hook kind and a guide for each language are on the
[Brain hooks page](https://codercoco-studios.github.io/cohost/advanced/extend/hooks).
