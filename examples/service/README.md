# Service example

`now-playing.ts` is a complete cohost service built on the shared runtime: it
watches a text file and tells the co-host when the song changes. It is tested by
`packages/testing/test/example-service.test.ts`, part of the test suite. From
the checkout, run it with the path of the file, or run the suite:

```shell
mise run example:now-playing -- /path/to/song.txt
mise run test
```

The walk-through, including the edits that make it a module of cohost, is the
[Add a TypeScript service page](https://codercoco-studios.github.io/cohost/advanced/extend/typescript-service).
