# New brain hook example

`shout.ts` is a complete brain hook, "is this line shouting?", written the way
the region hooks are: built-in rules, a model call and an HTTP server behind one
`Module`. It is tested by `packages/modules/test/example-hook.test.ts`, part of
the test suite, which builds the packages and runs from the checkout:

```shell
mise run test
```

The walk-through, including the edits that wire a hook into a brain region, is
the [Add a brain hook page](https://codercoco-studios.github.io/cohost/advanced/extend/new-hook).
