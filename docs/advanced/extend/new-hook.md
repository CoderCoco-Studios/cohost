---
title: Add a brain hook
description: Build a new hook with rules, llm and http implementations, test it, and wire it into a brain region.
track: advanced
verified: f126b94
---

# Add a brain hook

You will have a new [hook](../../start/glossary.md#hook), a place where a [brain region](../../start/glossary.md#brain-region) asks a small judge a question, written once and able to run as built-in rules, as one call to a model or as a request to your own server. The example answers "is this line shouting?". [Brain hooks](hooks.md) is the contract that every hook of kind `http` follows. This page is for writing the hook itself, inside the repository.

## What you need

- A checkout of cohost with its packages installed and built. [Developer setup](../dev-setup.md) covers it.
- A region that has a question to put behind a hook. Here the question is made up, so nothing in a region changes until you choose to wire it in.
- Some comfort with TypeScript.

## Steps

1. Read the hook. It is one file, `examples/new-hook/shout.ts`, and it is built the way the region hooks are. A hook is a `Module<I, O>` from `@cohost/modules`: a `Module` takes the question's input type `I` and the answer's type `O`. The two types come first:

   <<< @/../examples/new-hook/shout.ts#types

2. Write the `rules`. This is the built-in judge, and it is also what runs whenever the model or the server fails, so it must answer for every input and never throw. Here a line shouts when it has at least three letters that have a case and none of them is lower case. The check uses Unicode letter classes, so `ÉCOUTEZ` shouts and `日本語`, which has no case, does not.

   <<< @/../examples/new-hook/shout.ts#rules

3. Write the validator. An `llm` hook and an `http` hook both come back as unchecked JSON, and the validator turns it into your answer type or into `undefined`. Anything unusable makes the module use your rules, so be strict about what you accept.

   <<< @/../examples/new-hook/shout.ts#validate

4. Build the module. `createShoutHook` takes the hook's config, the top-level `llm` settings it borrows a provider from, a logger and options meant for tests. It gives the `llm` kind a system prompt that asks for JSON, and it shares the one validator between `llm` and `http`.

   <<< @/../examples/new-hook/shout.ts#create

5. Run the test that tries it with each kind: the `rules` directly, `http` against a stub server that sends good and bad replies, and `llm` through a fake chat provider. Build the packages first, because the example imports them from their built folders.

   ```sh
   pnpm build
   node --import tsx --test packages/modules/test/example-hook.test.ts
   ```

6. Wire the hook into a region. These edits change files outside the example, so they are described here, not shown:

   - In `packages/config/src/schema.ts`, give the region's section a field built from `ModuleSchema`, as the existing hooks have, so the hook has a `kind`, a `url`, a `timeout_ms` and an `llm` override like the others.
   - In `config/config.example.yaml`, add that key under the region with `kind: rules`, so a new install starts on the built-in judge.
   - In the region's service, build the module once at start (`createShoutHook` becomes a `createX` function beside the region's other code, as `services/affect/src/appraise.ts` shows) and call `run` where the judgement used to be written inline.
   - Pass the module to `hookHealth` from `@cohost/modules` with the service's other hooks, and merge what its `deps()` returns into the service's [heartbeat](../../start/glossary.md#heartbeat) dependencies, as `services/affect/src/main.ts` does. A hook whose `kind` is `http` or `llm` then reports a `hook.<name>` dependency, where `<name>` is the name the module was given. A hook on `rules` reports none.

   After the edits, run `pnpm test` to build everything and run every test.

## How you know it worked

- The test in step 5 passes: it checks the rules, a good and a bad `http` reply, and a good and a bad `llm` reply.
- Once wired in, setting the hook's `kind` to `http` and pointing it at a server from [Hook server in Python](hook-server-python.md) (or the TypeScript or Rust guide) changes the answers, and stopping that server brings the rules answers back.
- With `kind` set to `http` or `llm`, the Services tab lists `hook.<name>` in the deps column of the service that owns the hook, as `ok` while the hook is reachable and `down` while it is unreachable or being skipped.

## If it didn't

- **The test cannot find the packages.** The example imports `packages/modules` and `packages/config` from their `dist` folders. Run `pnpm build` first.
- **`rules` throws for some input.** It must not: the module calls it with no guard, as the answer and as the fallback. Make the function total, then add that input to the test.
- **An `llm` or `http` reply is ignored.** The validator returned `undefined`, so the rules answered. The region log says `module returned something unusable; using rules`. Compare the reply with what the validator accepts.
- **The config refuses to load after the schema edit.** The error names the key and the problem. For a hook, `kind` must be `rules`, `llm` or `http`, and an `llm.provider` needs an `llm.model` beside it.
