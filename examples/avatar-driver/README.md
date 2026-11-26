# Avatar driver example

`udp-json.ts` is a complete avatar driver that sends each call to another
avatar app as one JSON datagram over UDP. It imports the avatar service's driver
types, so it type-checks with `examples/tsconfig.json`, and it is tested by
`services/avatar/test/example-driver.test.ts`, part of the test suite. From the
checkout:

```shell
mise run example:typecheck
mise run test
```

The walk-through, including the edits that register a driver, is the
[Add an avatar driver page](https://codercoco-studios.github.io/cohost/advanced/extend/avatar-driver).
