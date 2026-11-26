import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { themeFiles, themeSection, FLOW_BODY, THEME_CONFIG_EXTRA } from "./docs-theme-fixture.ts";

export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const script = join(repoRoot, "scripts/docs-check.mjs");

export const REQUIRED_TERMS = [
  "vtuber", "obs", "browser-source", "obs-websocket", "stt", "tts", "llm", "embedding", "ollama", "redis", "redis-streams",
  "bus", "event", "consumer-group", "docker", "container", "docker-compose", "compose-profile", "postgres", "pgvector",
  "wsl2", "gpu", "vtube-studio", "vrm", "vmc", "osc", "salience", "affect", "valence-arousal", "cortex", "hook", "reflex",
  "connector", "sink", "heartbeat", "mock-mode",
];

/** A page: frontmatter (a value may start with a newline to carry nested YAML) plus body. */
export function page(fm: Record<string, string>, body: string): string {
  const head = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  return `---\n${head}\n---\n\n${body}\n`;
}
const fmOf = (title: string, track: string, extra: Record<string, string> = {}) => ({
  title, description: `About ${title}.`, track, ...extra,
});

export const LLD = `---
parent: high-level-design
prefix: DOCS
---

# docs-site

## Context and Design Philosophy

Why the docs site exists.

## Page tree

**Start here** (\`track: start\`)

| Page | Path | Covers |
| --- | --- | --- |
| Home | \`index.md\` | Hero |
| What is cohost? | \`start/what-is-cohost.md\` | x |
| How it works | \`start/how-it-works.md\` | x |
| Glossary | \`start/glossary.md\` | x |

**Set it up and run it** (\`track: simple\`)

| Group | Page | Path | Covers |
| --- | --- | --- | --- |
| Install | What you need | \`guide/install/prerequisites.md\` | x |
| Install | Try it | \`guide/install/first-run.md\` | x |
| Connect | Twitch chat | \`guide/connect/twitch.md\` | x |
| Operate | Service health | \`guide/operate/health.md\` | x |
| | Troubleshooting | \`guide/troubleshooting.md\` | x |

**Build on it** (\`track: advanced\`)

| Group | Page | Path | Covers |
| --- | --- | --- | --- |
| | Developer setup | \`advanced/dev-setup.md\` | x |
| Extend | Ways to extend cohost | \`advanced/extend/index.md\` | x |
| Reference | Configuration | \`advanced/reference/config.md\` | x |
| Reference | Environment and ports | \`advanced/reference/env.md\` | x |
| Reference | Bus events | \`advanced/reference/events.md\` | x |
| Architecture | Reading the design | \`advanced/architecture/index.md\` | x |
| Architecture | Design excerpts | \`advanced/architecture/design/<section>\` | x |

**Project** (\`track: project\`)

| Page | Path | Covers |
| --- | --- | --- |
| How specs work | \`project/spec-driven.md\` | x |
| Verification log | \`project/verification-log.md\` | x |

## Extension guides

| Page | Task | Examples | Verified by |
| --- | --- | --- | --- |
| \`advanced/extend/index.md\` | Choose a route | none | x |

| Task | Python | TypeScript | Rust | Any language with curl |
| --- | --- | --- | --- | --- |
| Add a service | — | — | — | — |

| Directory | Holds | Owning segment |
| --- | --- | --- |
| \`examples/modules/\` | The reference servers (\`server.py\`) | region-hooks |

${themeSection()}
## Decisions & Alternatives
`;

export const SIDEBAR = `export const nav = [
  { text: 'Start here', link: '/start/what-is-cohost' },
  { text: 'Guide', link: '/guide/install/prerequisites' },
  { text: 'Advanced', link: '/advanced/dev-setup' },
  { text: 'Project', link: '/project/spec-driven' },
];
export const sidebar = [
  { text: 'Start here', items: [
    { text: 'What is cohost?', link: '/start/what-is-cohost' },
    { text: 'How it works', link: '/start/how-it-works' },
    { text: 'Glossary', link: '/start/glossary' },
  ] },
  { text: 'Set it up and run it', items: [
    { text: 'Install', collapsed: false, items: [
      { text: 'What you need', link: '/guide/install/prerequisites' },
      { text: 'Try it', link: '/guide/install/first-run' },
    ] },
    { text: 'Connect', collapsed: false, items: [{ text: 'Twitch chat', link: '/guide/connect/twitch' }] },
    { text: 'Operate', collapsed: false, items: [{ text: 'Service health', link: '/guide/operate/health' }] },
    { text: 'Troubleshooting', link: '/guide/troubleshooting' },
  ] },
  { text: 'Build on it', items: [
    { text: 'Developer setup', link: '/advanced/dev-setup' },
    { text: 'Extend', collapsed: true, items: [{ text: 'Ways to extend cohost', link: '/advanced/extend/' }] },
    { text: 'Reference', collapsed: true, items: [
      { text: 'Configuration', link: '/advanced/reference/config' },
      { text: 'Environment and ports', link: '/advanced/reference/env' },
      { text: 'Bus events', link: '/advanced/reference/events' },
    ] },
    { text: 'Architecture', collapsed: true, items: [{ text: 'Reading the design', link: '/advanced/architecture/' }] },
  ] },
  { text: 'Project', items: [
    { text: 'How specs work', link: '/project/spec-driven' },
    { text: 'Verification log', link: '/project/verification-log' },
  ] },
];
`;

export const CONFIG_TS = `import { defineConfig } from 'vitepress';
export default defineConfig({
  base: '/cohost/',
  srcExclude: ['high-level-design.md', 'intent/**', 'decisions/**', 'arrows/**', 'lid/**', 'plans/**'],
${THEME_CONFIG_EXTRA}});
`;

export const MODULES_README = "# Modules\n\nFiles: `server.py`, `server.ts`, `rust/`, `try.sh`, `try.expected.txt`, `fixtures/`, `schemas/`.\n\n```sh\nmise run example:hook-server:py\nmise run example:hook-server:ts\nmise run example:hook-server:rust\n```\n\n[Brain hooks](https://codercoco-studios.github.io/cohost/advanced/extend/hooks)\n";

/** The tasks the fixture repository defines; a page's `mise run` and `mise watch` commands must name one (DOCS-FACT-001). */
export const MISE_TOML = `[tools]
node = "26.0.0"

[tasks.install]
run = "pnpm install --frozen-lockfile"

[tasks."build:native"]
run = "x"

[tasks.build]
run = "x"

[tasks.test]
run = "x"

[tasks.dashboard] # the dashboard
run = "x"

[tasks.cohostctl]
run = "x"

[tasks."dev:chat"]
run = "x"

[tasks."dev:cortex"]
run = "x"

[tasks."docs:build"]
run = "x"

[tasks."example:hook-server:py"]
run = "x"

[tasks."example:rust-bus"]
run = "x"
`;

const stepPage = (title: string) =>
  page(fmOf(title, "simple"), `# ${title}\n\nYou will have it working.\n\n## What you need\n\nA PC.\n\n1. Do it.\n\n## How you know it worked\n\nYou see it.\n\n## If it didn't\n\nSee [troubleshooting](../troubleshooting.md).`);

/** A complete repository that passes the docs check's source pass. Override a file by path, or delete it with null. */
export function baseFiles(): Record<string, string> {
  const terms = "\n" + REQUIRED_TERMS.map((id) => `  - id: ${id}\n    match: [${id.replace(/-/g, " ")}]`).join("\n");
  const gloss = REQUIRED_TERMS.map((id) => `### ${id} {#${id}}\n\nA thing.\n`).join("\n");
  const cfgNames = [
    "llm", "llm.provider", "llm.openai", "llm.openai.base_url", "mouth", "mouth.outputs", "mouth.outputs.discord",
    "mouth.outputs.discord.gain_db", "mouth.list", "mouth.list[].a", "mouth.list[].b",
  ];
  const envNames = [
    "DASHBOARD_PORT", "DASHBOARD_LAN_PORT", "COMPOSE_PROFILES", "LLM_PROVIDER", "MEMORY_STORE", "MEMORY_EMBEDDER", "VOICE_ENGINE",
    "CHAT_SOURCES", "6379", "11434", "3000", "3001",
  ];
  return {
    "package.json": JSON.stringify({ devDependencies: { "beautiful-mermaid": "1.1.3", vitepress: "1.6.4" } }),
    "mise.toml": MISE_TOML,
    ".env.example": [
      "DASHBOARD_PORT=3000", "DASHBOARD_LAN_PORT=3001", "# COMPOSE_PROFILES=discord", "LLM_PROVIDER=ollama", "MEMORY_STORE=postgres",
      "MEMORY_EMBEDDER=ollama", "VOICE_ENGINE=kokoro", "CHAT_SOURCES=[twitch]", "# a prose comment, not a variable", "",
    ].join("\n"),
    "docker-compose.yml": `services:\n  redis:\n    ports: ["127.0.0.1:6379:6379"]\n  models:\n    ports: ["127.0.0.1:\${OLLAMA_PORT:-11434}:11434"]\n`,
    "config/config.example.yaml": `llm:\n  provider: x\n  openai:\n    base_url: y\nmouth:\n  outputs:\n    discord:\n      gain_db: 1\n  list:\n    - a: 1\n      b: 2\n`,
    "packages/bus/src/events.ts": `export const EventPayloads = {\n  "chat.message": z.object({\n    text: z.string(),\n  }),\n  "speech.heard": z.object({}),\n} as const;\n`,
    "docs/intent/docs-site/docs-site-design.md": LLD,
    "docs/intent/docs-site/docs-site-specs.md": "# specs\n",
    "docs/high-level-design.md": "# HLD\n",
    "docs/arrows/index.yaml": "x: 1\n",
    "docs/lid/workflow.md": "# workflow\n",
    "docs/.vitepress/sidebar.mjs": SIDEBAR,
    "docs/.vitepress/config.ts": CONFIG_TS,
    "docs/index.md": page(
      { layout: "home", title: "cohost", description: "Home.", track: "start", hero: "\n  actions:\n    - { text: A, link: /start/what-is-cohost }\n    - { text: B, link: /guide/install/prerequisites }\n    - { text: C, link: /advanced/dev-setup }" },
      FLOW_BODY,
    ),
    "docs/start/what-is-cohost.md": page(fmOf("What is cohost?", "start"), "# What is cohost?\n\nIt talks."),
    "docs/start/how-it-works.md": page(fmOf("How it works", "start", { next: "{ text: What you need, link: /guide/install/prerequisites }" }), "# How it works\n\nIt listens."),
    "docs/start/glossary.md": page(fmOf("Glossary", "start", { prev: "false", next: "false", terms }), "# Glossary\n\n" + gloss),
    "docs/guide/install/prerequisites.md": page(fmOf("What you need", "simple"), "# What you need\n\nA PC."),
    "docs/guide/install/first-run.md": stepPage("Try it"),
    "docs/guide/connect/twitch.md": stepPage("Twitch chat"),
    "docs/guide/operate/health.md": page(fmOf("Service health", "simple"), "# Service health\n\nThe services report in.\n\n## The states\n\nA table.\n\n## Your services right now\n\n<LiveHealth />"),
    "docs/guide/troubleshooting.md": page(fmOf("Troubleshooting", "simple"), "# Troubleshooting\n\nFix it."),
    "docs/advanced/dev-setup.md": page(fmOf("Developer setup", "advanced"), "# Developer setup\n\nBuild it."),
    "docs/advanced/extend/index.md": page(
      fmOf("Ways to extend cohost", "advanced", { "glossary-skip": "[event]" }),
      "# Ways to extend cohost\n\nA service built on `@cohost/bus` (TypeScript) or `crates/cohost-bus` (Rust) is the supported way to add a service. See [Add a TypeScript service](typescript-service.md) and [Rust bus client](rust-bus.md).\n\nA process on neither client, such as one written in Python, is not a supported route: it gets no event validation, no dashboard control and no health reporting.\n\nA language other than Python, TypeScript and Rust has no tested example.\n\n| Task | Python | TypeScript | Rust | Any language with curl |\n| --- | --- | --- | --- | --- |\n| Add a service | — | — | — | — |",
    ),
    "docs/advanced/reference/config.md": page(fmOf("Configuration", "advanced"), "# Configuration\n\n" + cfgNames.map((n) => `- \`${n}\``).join("\n")),
    "docs/advanced/reference/env.md": page(fmOf("Environment and ports", "advanced"), "# Environment and ports\n\n" + envNames.map((n) => `- \`${n}\``).join("\n")),
    "docs/advanced/reference/events.md": page(fmOf("Bus events", "advanced"), "# Bus events\n\n- `chat.message`\n- `speech.heard`"),
    "docs/advanced/architecture/index.md": page(
      fmOf("Reading the design", "advanced"),
      "# Reading the design\n\nThe pages beneath are excerpts shown as written, not held to the site's wording and glossary-link rules. See the [glossary](../../start/glossary.md).",
    ),
    "docs/project/spec-driven.md": page(fmOf("How specs work", "project"), "# How specs work\n\nSpecs."),
    "docs/project/verification-log.md": page(fmOf("Verification log", "project"), "# Verification log\n\nThis was previously run."),
    "README.md": `# cohost

A co-host.

## Quick start

\`\`\`sh
git clone https://github.com/CoderCoco-Studios/cohost.git
cd cohost
scripts/install.sh
mise run dashboard
\`\`\`

Open the dashboard, tick isolated on the Services screen and press Start on chat, memory, cortex and voice; edit no file and append nothing to .env. For real accounts see [Install for real](https://codercoco-studios.github.io/cohost/guide/install/real-install).

## Documentation

Read the [docs](https://codercoco-studios.github.io/cohost/).

## License

AGPL-3.0-only.
`,
    "crates/cohost-bus/Cargo.toml": '[package]\nname = "cohost-bus"\nversion = "0.0.0"\n',
    "examples/README.md": "# Examples\n\n- `modules/`: a runnable brain-hook server.\n\n[Docs](https://codercoco-studios.github.io/cohost/advanced/extend/hooks)\n",
    "examples/modules/README.md": MODULES_README,
    "examples/modules/server.py": "print('hi')\n",
    ...themeFiles(),
  };
}

export function writeTree(dir: string, files: Record<string, string | null>) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

export interface Result { code: number | null; out: string; err: string }

/** Builds a throwaway repo (base files plus overrides; null deletes), runs the docs check on it, removes it. */
export function check(overrides: Record<string, string | null> = {}, args: string[] = [], extra?: (dir: string) => void): Result {
  const dir = mkdtempSync(join(tmpdir(), "cohost-docs-"));
  try {
    writeTree(dir, { ...baseFiles(), ...overrides });
    extra?.(dir);
    const r = spawnSync(process.execPath, [script, ...args, dir], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
