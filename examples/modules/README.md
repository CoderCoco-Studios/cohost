# Brain hooks example

A runnable stand-in for the three brain hooks (salience scoring, affect
appraisal, the cortex critic) when you serve them over HTTP.

| Path | What it is |
| --- | --- |
| `server.py` | Standard-library Python server with the three endpoints `/salience`, `/affect` and `/critic` |
| `fixtures/` | `contracts.json`, sample requests and replies for the three endpoints |
| `schemas/` | JSON Schema for each reply (`salience.json`, `affect.json`, `critic.json`) |

Run it from the repository root:

```bash
python3 examples/modules/server.py        # listens on :8900
```

Then set a hook to `kind: http` with `url: "http://host.docker.internal:8900/salience"`
(or `/affect`, `/critic`) in `config/config.yaml`. The schemas are generated
with `node scripts/gen-hook-schemas.mjs`.

The full contract, every hook kind and a guide to training your own are on the
[Brain hooks page](https://codercoco-studios.github.io/cohost/advanced/extend/hooks).
