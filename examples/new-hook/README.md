# New brain hook example

`shout.ts` is a complete brain hook, "is this line shouting?", written the way
the region hooks are: built-in rules, a model call and an HTTP server behind one
`Module`. It is tested by `packages/modules/test/example-hook.test.ts`, which you
run from the repository root:

```shell
pnpm build
node --import tsx --test packages/modules/test/example-hook.test.ts
```

The walk-through, including the edits that wire a hook into a brain region, is
the [Add a brain hook page](https://codercoco-studios.github.io/cohost/advanced/extend/new-hook).
