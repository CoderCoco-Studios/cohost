# Service example

`now-playing.ts` is a complete cohost service built on the shared runtime: it
watches a text file and tells the co-host when the song changes. It is tested by
`packages/testing/test/example-service.test.ts`, which you run from the
repository root:

```shell
pnpm build
node --import tsx --test packages/testing/test/example-service.test.ts
```

The walk-through, including the edits that make it a module of cohost, is the
[Add a TypeScript service page](https://codercoco-studios.github.io/cohost/advanced/extend/typescript-service).
