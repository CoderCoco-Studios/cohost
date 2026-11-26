# Examples

Runnable material that goes with the docs. Start at the
[docs site](https://codercoco-studios.github.io/cohost/). From the checkout,
each program runs through a `mise run example:*` task (`mise tasks` lists them).

- [`modules/`](modules/) is a runnable server for the three brain hooks
  (salience, affect, the cortex critic) with sample requests and JSON Schemas.
  See the [Brain hooks page](https://codercoco-studios.github.io/cohost/advanced/extend/hooks).
- [`model-stub/`](model-stub/) is the smallest OpenAI-compatible model server, in Python and TypeScript.
- [`audio-in/`](audio-in/) holds clients that send a clip to ears and scripts that convert a recording.
- [`avatar-driver/`](avatar-driver/) is a driver that sends avatar calls as UDP JSON datagrams.
- [`new-hook/`](new-hook/) is a new brain hook written the way the region hooks are.
- [`service/`](service/) is a small service on the shared runtime.
- [`rust-bus/`](rust-bus/) is a Rust program that publishes and reads on the bus.

Recipes for model providers (local Ollama, a rented GPU box, the Claude API,
Amazon Bedrock) are on the
[Choose a model page](https://codercoco-studios.github.io/cohost/guide/tune/model).
