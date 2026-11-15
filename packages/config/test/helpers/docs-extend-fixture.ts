import { page, REQUIRED_TERMS, LLD, SIDEBAR } from "./docs-fixture.ts";

/** Fixture for the Extend group (DOCS-GUIDE-*): a repository whose Extend pages, examples and tables all agree. */

export const EXT = "docs/advanced/extend/";
export const SITE = "https://codercoco-studios.github.io/cohost/";
export const FIXTURES_URL = "https://github.com/CoderCoco-Studios/cohost/tree/main/packages/bus/fixtures/contract";

export const CONSTANTS = {
  FRAME_VERSION: 1,
  MAX_FRAME_BYTES: 65536,
  AUDIO_MAXLEN: { in: 3000, out: 1500 },
  AUDIO_STREAM_TTL_MS: 60000,
  names: { prefix: "p1", dir: "in", tag: "discord", id: "disc", audioStream: "p1:audio.in.discord", connectorKey: "p1:connector:disc" },
};

const SKIP = `[${REQUIRED_TERMS.join(", ")}]`;
const fm = (title: string, extra: Record<string, string> = {}) => ({
  title, description: `About ${title}.`, track: "advanced", verified: "1a2b3c4", "glossary-skip": SKIP, ...extra,
});

/** A step-shaped guide page; `body` is appended after the three required headings. */
export function guide(title: string, body = "", extraFm: Record<string, string> = {}): string {
  return page(
    fm(title, extraFm),
    `# ${title}\n\nYou will have it running.\n\n## What you need\n\nA PC.\n\n## Steps\n\n1. Do it.\n\n${body}\n\n## How you know it worked\n\nYou see it.\n\n## If it didn't\n\nCheck the log.\n`,
  );
}

export const TS_SERVICE = guide("Add a TypeScript service", "<<< @/../examples/service/now-playing.ts#main\n");
export const RUST_BUS = guide(
  "Rust bus client",
  "`crates/cohost-bus` has no shared runtime. A Rust service publishes `service.heartbeat` itself and answers `control` and `inject.request` only if it implements them.\n\n```sh\ncargo run --manifest-path examples/Cargo.toml -p cohost-example-bus\n```\n\n<<< @/../examples/rust-bus/Cargo.toml\n\n<<< @/../examples/rust-bus/src/lib.rs\n",
);

export const INDEX = page(
  fm("Ways to extend cohost"),
  `# Ways to extend cohost

Build on \`@cohost/bus\` (TypeScript) or \`crates/cohost-bus\` (Rust). A process on neither gets no event validation, no dashboard control and no health reporting.

Read [Add a TypeScript service](typescript-service.md) and [Rust bus client](rust-bus.md) and [Connector protocol](connector-protocol.md).

A language other than Python, TypeScript and Rust has no tested example and uses the contracts and their \`curl\` scripts.

<<< @/../examples/service/now-playing.ts#main

## Tested examples

| Task | Python | TypeScript | Rust | Any language with curl |
| --- | --- | --- | --- | --- |
| Add a service | — | [Add a TypeScript service](typescript-service.md) | [Rust bus client](rust-bus.md) | — |
`,
);

export const CONNECTOR = page(
  fm("Connector protocol"),
  `# Connector protocol

There is no SDK outside TypeScript, and a connector in another language is not a supported route. Every connector uses \`@cohost/bus\`.

Keys: \`<prefix>:connector:<id>\`, \`<prefix>:audio.in.<tag>\` and \`<prefix>:audio.out.<tag>\`. Fixtures: [contract](${FIXTURES_URL}).

| Constant | Value |
| --- | --- |
| \`FRAME_VERSION\` | \`1\` |
| \`MAX_FRAME_BYTES\` | \`65536\` |
| \`AUDIO_MAXLEN.in\` | \`3000\` |
| \`AUDIO_MAXLEN.out\` | \`1500\` |
| \`AUDIO_STREAM_TTL_MS\` | \`60000\` |
`,
);

export const NOW_PLAYING = "// #region main\nexport const x = 1;\n// #endregion main\n";
export const GUIDES_TABLE = `| Page | Task | Examples | Verified by |
| --- | --- | --- | --- |
| \`advanced/extend/index.md\` | Choose a route | \`examples/service/now-playing.ts\` | x |
| \`advanced/extend/typescript-service.md\` | Add a service | \`examples/service/now-playing.ts\` | x |
| \`advanced/extend/rust-bus.md\` | Rust | \`examples/rust-bus/Cargo.toml\`, \`examples/rust-bus/src/lib.rs\` | x |
| \`advanced/extend/connector-protocol.md\` | Protocol | none | x |
`;
export const TESTED_TABLE = `| Task | Python | TypeScript | Rust | Any language with curl |
| --- | --- | --- | --- | --- |
| Add a service | — | Add a TypeScript service | Rust bus client | — |
`;
export const LAYOUT_TABLE = `| Directory | Holds | Owning segment |
| --- | --- | --- |
| \`examples/modules/\` | The reference servers (\`server.py\`) | region-hooks |
| \`examples/service/\` | \`now-playing.ts\` | module-contract |
| \`examples/rust-bus/\` | The Rust package \`cohost-example-bus\`: \`src/lib.rs\`, \`src/main.rs\` | event-bus |
`;
export const SERVICE_README = `# service\n\n\`now-playing.ts\`\n\n[Guide](${SITE}advanced/extend/typescript-service)\n`;
export const RUST_README = `# rust-bus\n\n\`lib.rs\` and \`main.rs\`.\n\n[Guide](${SITE}advanced/extend/rust-bus)\n`;

const titleOf = (text: string) => /^title: (.*)$/m.exec(text)?.[1] ?? "x";

/**
 * A consistent repository for the Extend group. `over` replaces or deletes files by path; Extend pages it adds are
 * entered into the LLD page tree and the sidebar. `tables` replaces the three LLD tables (guides, tested, layout).
 */
export function extendRepo(over: Record<string, string | null> = {}, tables: { guides?: string; tested?: string; layout?: string } = {}): Record<string, string | null> {
  const pages: Record<string, string | null> = {
    [`${EXT}index.md`]: INDEX,
    [`${EXT}typescript-service.md`]: TS_SERVICE,
    [`${EXT}rust-bus.md`]: RUST_BUS,
    [`${EXT}connector-protocol.md`]: CONNECTOR,
  };
  const all: Record<string, string | null> = {
    ...pages,
    "examples/service/now-playing.ts": NOW_PLAYING,
    "examples/service/README.md": SERVICE_README,
    "examples/rust-bus/README.md": RUST_README,
    "examples/rust-bus/Cargo.toml": '[package]\nname = "cohost-example-bus"\nversion = "0.0.0"\n',
    "examples/rust-bus/src/lib.rs": "pub fn f() {}\n",
    "examples/rust-bus/src/main.rs": "fn main() {}\n",
    "examples/rust-bus/tests/it.rs": "#[test]\nfn t() {}\n",
    "examples/Cargo.toml": '[workspace]\nmembers = ["modules/rust", "rust-bus"]\n',
    "examples/modules/rust/Cargo.toml": '[package]\nname = "cohost-example-hook-server"\nversion = "0.0.0"\n',
    "examples/README.md": "# Examples\n\n- `modules/`: a runnable brain-hook server.\n- `service/`: a service that shows the track playing.\n- `rust-bus/`: a Rust client that reads the bus.\n\n[Docs](https://codercoco-studios.github.io/cohost/advanced/extend/hooks)\n",
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
    "crates/cohost-bus/Cargo.toml": '[package]\nname = "cohost-bus"\nversion = "0.0.0"\n',
    "packages/bus/test/examples.test.ts": 'const a = "examples/service/now-playing.ts";\nconst d = "examples/service";\nconst b = "cohost-example-bus";\n',
    "packages/bus/fixtures/contract/constants.json": JSON.stringify(CONSTANTS, null, 2),
    ...over,
  };
  const extend = Object.entries(all).filter(([k, v]) => k.startsWith(EXT) && k.endsWith(".md") && v !== null).map(([k, v]) => [k.slice(EXT.length), titleOf(v as string)]);
  extend.sort((a, b) => (a[0] === "index.md" ? -1 : b[0] === "index.md" ? 1 : a[0] < b[0] ? -1 : 1));
  const rows = extend.map(([f, t]) => `| Extend | ${t} | \`advanced/extend/${f}\` | x |`).join("\n");
  const lld = LLD
    .replace(/\| Extend \| Ways to extend cohost \|[^\n]*\n/, `${rows}\n`)
    .replace(/## Extension guides[\s\S]*?(?=\n## |\n---|$)/, "")
    .replace(
      /(\n## Decisions)/,
      `\n## Extension guides\n\n${tables.guides ?? GUIDES_TABLE}\n${tables.tested ?? TESTED_TABLE}\n${tables.layout ?? LAYOUT_TABLE}\n$1`,
    );
  const items = extend.map(([f, t]) => `{ text: '${t.replace(/'/g, "\\'")}', link: '/advanced/extend/${f === "index.md" ? "" : f.replace(/\.md$/, "")}' }`).join(", ");
  const sidebar = SIDEBAR.replace(/items: \[\{ text: 'Ways to extend cohost', link: '\/advanced\/extend\/' \}\]/, `items: [${items}]`);
  return { ...all, "docs/intent/docs-site/docs-site-design.md": lld, "docs/.vitepress/sidebar.mjs": sidebar, ...over };
}
