# Rust bus example

The Rust package `cohost-example-bus`, a member of the examples Cargo workspace
(`examples/Cargo.toml`). It publishes a heartbeat and reads events using only
`crates/cohost-bus`.

| Path | What it is |
| --- | --- |
| `lib.rs` | In `src/`: the heartbeat and the reader |
| `main.rs` | In `src/`: a program that runs them against `REDIS_URL` |
| `round_trip.rs` | The integration test in `tests/`; needs Redis |

From the repository root, with Redis running:

```shell
cargo run --manifest-path examples/Cargo.toml -p cohost-example-bus
```

The explanation is on the
[Rust bus client page](https://codercoco-studios.github.io/cohost/advanced/extend/rust-bus).
