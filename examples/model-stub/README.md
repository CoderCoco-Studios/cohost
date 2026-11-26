# Model stub

The smallest server cohost's OpenAI-compatible provider accepts, in two
languages, with a script that checks any server the same way.

| Path | What it is |
| --- | --- |
| `stub.py` | Python 3, standard library only |
| `stub.ts` | TypeScript, Node built-ins only; runs with `node` on Node 22.18 or later |
| `try.sh` | Sends cohost's two requests with `curl` and prints each reply |
| `try.expected.txt` | The replies the stub gives, one JSON document per line |

From the checkout:

```sh
mise run example:model-stub:py
mise run example:model-stub:ts
mise run example:model-try
```

The explanation is on the
[Your own model server page](https://codercoco-studios.github.io/cohost/advanced/extend/model-server).
