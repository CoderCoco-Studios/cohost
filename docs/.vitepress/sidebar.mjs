// @spec DOCS-BUILD-008, DOCS-IA-001, DOCS-IA-002, DOCS-IA-005, DOCS-IA-007, DOCS-IA-009, DOCS-ARCH-008
// The site's sidebar and top nav as plain data, imported by config.ts and by scripts/docs-check.mjs. The order is the
// order of the docs-site LLD's Page tree; the Architecture entries come from the same loaders that build the pages.
import { architectureSidebar, defaultRepoRoot } from './design-excerpts.mjs';

export const nav = [
  { text: 'Start here', link: '/start/what-is-cohost' },
  { text: 'Guide', link: '/guide/install/prerequisites' },
  { text: 'Advanced', link: '/advanced/dev-setup' },
  { text: 'Project', link: '/project/spec-driven' },
];

export const sidebar = [
  {
    text: 'Start here',
    items: [
      { text: 'What is cohost?', link: '/start/what-is-cohost' },
      { text: 'How it works', link: '/start/how-it-works' },
      { text: 'Glossary', link: '/start/glossary' },
    ],
  },
  {
    text: 'Set it up and run it',
    items: [
      {
        text: 'Install',
        collapsed: false,
        items: [
          { text: 'What you need', link: '/guide/install/prerequisites' },
          { text: 'Try it with no accounts', link: '/guide/install/first-run' },
          { text: 'Install for real', link: '/guide/install/real-install' },
        ],
      },
      {
        text: 'Connect',
        collapsed: false,
        items: [
          { text: 'Twitch chat', link: '/guide/connect/twitch' },
          { text: 'Discord', link: '/guide/connect/discord' },
          { text: 'OBS and the voice on stream', link: '/guide/connect/obs' },
          { text: 'Avatar', link: '/guide/connect/avatar' },
        ],
      },
      {
        text: 'Tune',
        collapsed: false,
        items: [
          { text: 'Personality', link: '/guide/tune/personality' },
          { text: 'When it talks', link: '/guide/tune/talkativeness' },
          { text: 'Mood', link: '/guide/tune/mood' },
          { text: 'Memory and viewer notes', link: '/guide/tune/memory' },
          { text: 'Choose a model', link: '/guide/tune/model' },
          { text: 'Choose a voice engine', link: '/guide/tune/voice-engine' },
        ],
      },
      {
        text: 'Operate',
        collapsed: false,
        items: [
          { text: 'Dashboard tour', link: '/guide/operate/dashboard' },
          { text: 'Service health', link: '/guide/operate/health' },
          { text: 'Starting and stopping', link: '/guide/operate/start-stop' },
          { text: 'After a stream', link: '/guide/operate/after-stream' },
        ],
      },
      { text: 'Troubleshooting', link: '/guide/troubleshooting' },
      { text: 'FAQ', link: '/guide/faq' },
    ],
  },
  {
    text: 'Build on it',
    items: [
      { text: 'Developer setup', link: '/advanced/dev-setup' },
      {
        text: 'Testing',
        collapsed: true,
        items: [
          { text: 'Running the tests', link: '/advanced/testing/' },
          { text: 'One service on its own', link: '/advanced/testing/isolated' },
          { text: 'Fake inputs', link: '/advanced/testing/inject' },
          { text: 'Real hardware and accounts', link: '/advanced/testing/real-backends' },
          { text: 'Single-PC checklist', link: '/advanced/testing/single-pc' },
          { text: 'Unit-test helpers', link: '/advanced/testing/helpers' },
        ],
      },
      {
        text: 'Extend',
        collapsed: true,
        items: [
          { text: 'Ways to extend cohost', link: '/advanced/extend/' },
          { text: 'Brain hooks', link: '/advanced/extend/hooks' },
          { text: 'Hook server in Python', link: '/advanced/extend/hook-server-python' },
          { text: 'Hook server in TypeScript', link: '/advanced/extend/hook-server-typescript' },
          { text: 'Hook server in Rust', link: '/advanced/extend/hook-server-rust' },
          { text: 'Your own model server', link: '/advanced/extend/model-server' },
          { text: 'Send audio to ears', link: '/advanced/extend/audio-in' },
          { text: 'Add an avatar driver', link: '/advanced/extend/avatar-driver' },
          { text: 'Add a brain hook', link: '/advanced/extend/new-hook' },
          { text: 'Add a TypeScript service', link: '/advanced/extend/typescript-service' },
          { text: 'Rust bus client', link: '/advanced/extend/rust-bus' },
          { text: 'Connector protocol', link: '/advanced/extend/connector-protocol' },
        ],
      },
      {
        text: 'Reference',
        collapsed: true,
        items: [
          { text: 'Configuration', link: '/advanced/reference/config' },
          { text: 'Environment and ports', link: '/advanced/reference/env' },
          { text: 'Bus events', link: '/advanced/reference/events' },
          { text: 'HTTP routes', link: '/advanced/reference/http' },
          { text: 'Commands', link: '/advanced/reference/commands' },
        ],
      },
      { text: 'Architecture', collapsed: true, items: architectureSidebar(defaultRepoRoot()) },
    ],
  },
  {
    text: 'Project',
    items: [
      { text: 'How specs work', link: '/project/spec-driven' },
      { text: 'Licence', link: '/project/license' },
      { text: 'Contributing', link: '/project/contributing' },
      { text: 'Status', link: '/project/status' },
      { text: 'Verification log', link: '/project/verification-log' },
    ],
  },
];
