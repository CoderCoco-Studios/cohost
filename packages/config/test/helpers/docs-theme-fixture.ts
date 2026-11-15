// Fixtures for the docs-site theme checks (DOCS-THEME-*): a complete, valid theme source tree and a valid built site
// that the docs check's source and built-site passes accept. Tests mutate one piece and expect one named failure.

export const PALETTE: [string, string, string][] = [
  ["bg", "#FFFCF8", "#1A1420"],
  ["bg-alt", "#F8F3EE", "#211A29"],
  ["bg-soft", "#F7F1EA", "#2A2133"],
  ["text-1", "#251C2E", "#F4EEF8"],
  ["text-2", "#574B63", "#C9BDD3"],
  ["text-3", "#6F637B", "#A396AE"],
  ["brand-1", "#6B3FBF", "#BFA3FF"],
  ["brand-2", "#5A30A6", "#D2BFFF"],
  ["button-bg", "#6B3FBF", "#6A40C4"],
  ["button-hover-bg", "#5A30A6", "#7A4FD6"],
  ["button-text", "#FFFFFF", "#FFFFFF"],
  ["accent", "#E0583F", "#FF8A70"],
  ["focus", "#6B3FBF", "#BFA3FF"],
  ["aside-bg", "#FFF1EA", "#2C1E22"],
  ["aside-title", "#A63A26", "#FFB39F"],
  ["code-bg", "#F6F2F9", "#211A29"],
  ["code-inline-bg", "#F1EBF7", "#2E2440"],
  ["code-inline-text", "#5A30A6", "#D2BFFF"],
  ["badge-start-bg", "#FFE3D9", "#3D2420"],
  ["badge-start-text", "#9A3420", "#FFB39F"],
  ["badge-simple-bg", "#DDF3E6", "#1C3326"],
  ["badge-simple-text", "#1E6B3F", "#8FDCAE"],
  ["badge-advanced-bg", "#ECE3FB", "#2E2448"],
  ["badge-advanced-text", "#5A30A6", "#CDB8FF"],
  ["badge-project-bg", "#E8E6EC", "#2C2833"],
  ["badge-project-text", "#45404D", "#D4CFDA"],
  ["tip-bg", "#E9F6EE", "#1C3326"],
  ["tip-title", "#1E6B3F", "#8FDCAE"],
  ["info-bg", "#EEF0F4", "#262330"],
  ["info-title", "#3F4654", "#C9BDD3"],
  ["warning-bg", "#FFF4D6", "#3A2E12"],
  ["warning-title", "#8A5A00", "#F5C86A"],
  ["danger-bg", "#FDE7E9", "#3D1E22"],
  ["danger-title", "#B4232F", "#FF9AA4"],
  ["mascot-body", "#6B3FBF", "#8F6BEA"],
  ["mascot-face", "#FFFFFF", "#FFFFFF"],
  ["mascot-headset", "#E0583F", "#FF8A70"],
];

export const CONTRAST: [string, string[], number][] = [
  ["text-1", ["bg", "bg-alt", "bg-soft", "aside-bg", "code-bg", "tip-bg", "info-bg", "warning-bg", "danger-bg"], 4.5],
  ["text-2", ["bg", "bg-alt", "bg-soft"], 4.5],
  ["text-3", ["bg", "bg-alt", "bg-soft"], 4.5],
  ["brand-1", ["bg", "bg-alt", "bg-soft", "aside-bg", "tip-bg", "info-bg", "warning-bg", "danger-bg"], 4.5],
  ["brand-2", ["bg", "bg-alt", "bg-soft"], 4.5],
  ["button-text", ["button-bg", "button-hover-bg"], 4.5],
  ["aside-title", ["aside-bg"], 4.5],
  ["code-inline-text", ["code-inline-bg"], 4.5],
  ["badge-start-text", ["badge-start-bg"], 4.5],
  ["badge-simple-text", ["badge-simple-bg"], 4.5],
  ["badge-advanced-text", ["badge-advanced-bg"], 4.5],
  ["badge-project-text", ["badge-project-bg"], 4.5],
  ["tip-title", ["tip-bg"], 4.5],
  ["info-title", ["info-bg"], 4.5],
  ["warning-title", ["warning-bg"], 4.5],
  ["danger-title", ["danger-bg"], 4.5],
  ["focus", ["bg", "bg-alt", "bg-soft"], 3],
  ["accent", ["bg"], 3],
  ["mascot-body", ["bg"], 3],
  ["mascot-headset", ["bg"], 3],
  ["mascot-face", ["mascot-body"], 3],
];

/** The LLD's Theme and personality section: the Palette table and the Contrast pairs table. */
export function themeSection(): string {
  const pal = PALETTE.map(([t, l, d]) => `| \`${t}\` | \`${l}\` | \`${d}\` | used |`).join("\n");
  const con = CONTRAST.map(([f, bgs, min]) => `| \`${f}\` | ${bgs.map((b) => `\`${b}\``).join(", ")} | ${min} |`).join("\n");
  return `## Theme and personality

### Palette

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
${pal}

**Contrast pairs.** Each row pairs one foreground token with each listed background token.

| Foreground | Backgrounds | Minimum |
| --- | --- | --- |
${con}

### Type

Inter.
`;
}

const block = (sel: string, idx: 1 | 2) =>
  `${sel} {\n${PALETTE.map((p) => `  --cohost-${p[0]}: ${p[idx]};`).join("\n")}\n}\n`;

export const TOKENS_CSS = `/* The palette: the only thing in this file. */\n${block(":root", 1)}\n${block(".dark", 2)}`;

const VP_MAP: [string, string][] = [
  ["--vp-c-bg", "bg"], ["--vp-c-bg-alt", "bg-alt"], ["--vp-c-bg-soft", "bg-soft"],
  ["--vp-c-text-1", "text-1"], ["--vp-c-text-2", "text-2"], ["--vp-c-text-3", "text-3"],
  ["--vp-c-brand-1", "brand-1"], ["--vp-c-brand-2", "brand-2"], ["--vp-c-brand-3", "brand-2"],
  ["--vp-button-brand-bg", "button-bg"], ["--vp-button-brand-hover-bg", "button-hover-bg"],
  ["--vp-button-brand-text", "button-text"], ["--vp-button-brand-hover-text", "button-text"],
  ["--vp-code-block-bg", "code-bg"], ["--vp-code-bg", "code-inline-bg"], ["--vp-code-color", "code-inline-text"],
  ...["tip", "info", "warning", "danger", "details"].flatMap((t): [string, string][] => [
    [`--vp-custom-block-${t}-bg`, t === "details" ? "info-bg" : `${t}-bg`],
    [`--vp-custom-block-${t}-text`, "text-1"],
  ]),
];

const lightDark = PALETTE.map((p) => `    --cohost-${p[0]}: ${p[1]};`).join("\n");

export const STYLE_CSS = `:root {
${VP_MAP.map(([v, t]) => `  ${v}: var(--cohost-${t});`).join("\n")}
}

h1, h2, h3 { font-weight: 700; letter-spacing: -0.01em; }

.cohost-track-badge { display: inline-block; border-radius: 999px; padding: 2px 10px; }
.cohost-track-badge[data-track='start'] { color: var(--cohost-badge-start-text); background: var(--cohost-badge-start-bg); }
.cohost-track-badge[data-track='simple'] { color: var(--cohost-badge-simple-text); background-color: var(--cohost-badge-simple-bg); }
.cohost-track-badge[data-track='advanced'] { color: var(--cohost-badge-advanced-text); background: var(--cohost-badge-advanced-bg); }
.cohost-track-badge[data-track='project'] { color: var(--cohost-badge-project-text); background: var(--cohost-badge-project-bg); }

.cohost-aside { background: var(--cohost-aside-bg); border-left: 4px solid var(--cohost-accent); border-radius: 12px; padding: 12px 16px; }
.cohost-aside-title { color: var(--cohost-aside-title); font-weight: 700; }
.cohost-aside-title::before {
  content: '';
  display: inline-block;
  width: 18px;
  height: 18px;
  background: var(--cohost-mascot-body);
  -webkit-mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='44' height='34' rx='14'/></svg>");
  mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='44' height='34' rx='14'/></svg>");
}

${["tip", "info", "warning", "danger"].map((t) => `.vp-doc .custom-block.${t} { border-left: 4px solid var(--cohost-${t}-title); }
.vp-doc .custom-block.${t} .custom-block-title { color: var(--cohost-${t}-title); }`).join("\n")}
.vp-doc .custom-block.details { border-left: 4px solid var(--cohost-info-title); }
.vp-doc .custom-block.details summary { color: var(--cohost-info-title); }

.cohost-diagram { overflow-x: auto; }
.cohost-diagram svg { width: auto; max-width: none; }

.cohost-flow ol { display: flex; flex-direction: column; }

.VPFeatures .item:nth-child(1) .VPFeature { border-top: 4px solid var(--cohost-accent); }
.VPFeatures .item:nth-child(2) .VPFeature { border-top: 4px solid var(--cohost-badge-simple-text); }
.VPFeatures .item:nth-child(3) .VPFeature { border-top: 4px solid var(--cohost-badge-advanced-text); }

a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--cohost-focus);
  outline-offset: 2px;
}

@media (min-width: 640px) {
  .cohost-flow ol { flex-direction: row; flex-wrap: wrap; }
  .cohost-flow li { flex-basis: 400px; }
}

@media (prefers-reduced-motion: no-preference) {
  .VPFeature { transition: transform 150ms; }
  .VPFeature:hover { transform: translateY(-2px); }
  @keyframes cohost-talk { from { transform: scaleY(0.6); } to { transform: scaleY(1); } }
  .cohost-mark[data-expression='talking'] rect { animation-name: cohost-talk; animation-duration: 0.5s; animation-iteration-count: 3; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

@media print {
  .VPNav, .VPLocalNav, .VPSidebar, .VPDocAside, .VPDoc .aside, .VPDocFooter .prev-next { display: none !important; }
  .dark {
${lightDark}
  }
  .dark .shiki, .dark .shiki span { color: var(--shiki-light) !important; }
  .dark div[class*='language-'], .dark .shiki { background-color: ${PALETTE.find((p) => p[0] === "code-bg")![1]} !important; }
  .vp-doc div[class*='language-'] pre { white-space: pre-wrap; }
  .cohost-diagram, .cohost-aside, .custom-block { break-inside: avoid; }
  .vp-doc a[href^='http']::after, .vp-doc a[href^='//']::after { content: " (" attr(href) ")"; }
}
`;

export const THEME_INDEX_TS = `import DefaultTheme from 'vitepress/theme';
import './tokens.css';
import './style.css';

export default { extends: DefaultTheme };
`;

export const MARK_VUE = `<script setup lang="ts">
withDefaults(defineProps<{ expression?: 'idle' | 'talking' | 'lost' }>(), { expression: 'idle' });
</script>

<template>
  <svg class="cohost-mark" :data-expression="expression" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <rect x="10" y="18" width="44" height="34" rx="14" fill="var(--cohost-mascot-body)" />
    <path d="M18 50 L12 60 L26 52 Z" fill="var(--cohost-mascot-body)" />
    <path d="M10 28 A22 22 0 0 1 54 28" fill="none" stroke="var(--cohost-mascot-headset)" stroke-width="4" stroke-linecap="round" />
    <rect x="5" y="28" width="6" height="12" rx="3" fill="var(--cohost-mascot-headset)" />
    <rect x="53" y="28" width="6" height="12" rx="3" fill="var(--cohost-mascot-headset)" />
    <rect x="22" y="28" width="4" height="8" rx="2" fill="var(--cohost-mascot-face)" />
    <rect x="38" y="28" width="4" height="8" rx="2" fill="var(--cohost-mascot-face)" />
    <g v-if="expression === 'lost'">
      <rect x="27" y="42" width="10" height="4" rx="2" fill="var(--cohost-mascot-face)" />
    </g>
    <g v-else>
      <rect x="25" y="41" width="4" height="6" rx="2" fill="var(--cohost-mascot-face)" />
      <rect x="30" y="38" width="4" height="12" rx="2" fill="var(--cohost-mascot-face)" />
      <rect x="35" y="41" width="4" height="6" rx="2" fill="var(--cohost-mascot-face)" />
    </g>
  </svg>
</template>
`;

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="10" y="18" width="44" height="34" rx="14" fill="#6B3FBF"/>
  <path d="M10 28 A22 22 0 0 1 54 28" fill="none" stroke="#E0583F" stroke-width="4"/>
  <rect x="22" y="28" width="4" height="8" rx="2" fill="#ffffff"/>
</svg>
`;

export const MERMAID_FENCE_MJS = `import { renderMermaidSVG } from 'beautiful-mermaid';

const OPTIONS = {
  bg: 'var(--cohost-bg)',
  fg: 'var(--cohost-text-1)',
  muted: 'var(--cohost-text-2)',
  line: 'var(--cohost-text-2)',
  accent: 'var(--cohost-accent)',
  surface: 'var(--cohost-bg-soft)',
  border: 'var(--cohost-text-3)',
  transparent: true,
  font: 'Inter',
};

export function render(source) {
  return renderMermaidSVG(source, OPTIONS).replace(/@import[^;]*;/g, '');
}
`;

export const FLOW_BODY = `## How a chat line becomes speech

::: flow
1. **Chat** hears the line.
2. **[Salience](start/glossary.md#salience)** decides it is worth answering.
3. **[Cortex](start/glossary.md#cortex)** remembers and writes a reply.
4. **Voice** turns it into speech.
5. **The [sink](start/glossary.md#sink) or Discord** plays it.
6. **The avatar** moves its mouth.

See [How it works](start/how-it-works.md) for the whole journey.
:::
`;

export const THEME_CONFIG_EXTRA = `  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/cohost/favicon.svg' }]],
  markdown: { theme: { light: 'github-light-high-contrast', dark: 'github-dark-default' } },
`;

/** The theme-related files of the base repository fixture. */
export function themeFiles(): Record<string, string> {
  return {
    "docs/.vitepress/theme/index.ts": THEME_INDEX_TS,
    "docs/.vitepress/theme/tokens.css": TOKENS_CSS,
    "docs/.vitepress/theme/style.css": STYLE_CSS,
    "docs/.vitepress/theme/components/CohostMark.vue": MARK_VUE,
    "docs/.vitepress/mermaid-fence.mjs": MERMAID_FENCE_MJS,
    "docs/public/favicon.svg": FAVICON_SVG,
  };
}

// ---------------------------------------------------------------------------------------------- built site

const FAV = `<link rel="icon" type="image/svg+xml" href="/cohost/favicon.svg">`;
export const NAV_MARK = `<svg class="cohost-mark" data-expression="idle" viewBox="0 0 64 64" aria-hidden="true"><rect fill="var(--cohost-mascot-body)"/></svg>`;
export const NAV = `<header class="VPNav"><div class="VPNavBar"><div class="VPNavBarTitle"><a class="title" href="/cohost/">${NAV_MARK}<span>cohost</span></a></div><a href="/cohost/start/what-is-cohost">Start here</a></div></header>`;
export const LABELS: Record<string, string> = { start: "Start here", simple: "Simple", advanced: "Advanced", project: "Project" };
export const badge = (track: string) =>
  `<span class="cohost-track-badge" data-track="${track}"><span class="visually-hidden">Track: </span>${LABELS[track]}</span>`;
export const FIGURE = (label: string) =>
  `<figure class="cohost-diagram" tabindex="0"><svg role="img" aria-label="Diagram: ${label}" viewBox="0 0 10 10"><style>.x{fill:red}</style><rect/></svg></figure>`;

/** A built page: head with the favicon, the nav bar with the idle mark, then `body`. `head` and `nav` replace the defaults. */
export function shell(body: string, o: { head?: string; nav?: string } = {}): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${o.head ?? FAV}<link rel="stylesheet" href="/cohost/assets/style.css"></head><body><div id="app">${o.nav ?? NAV}<main>${body}</main></div></body></html>`;
}

export const docPage = (track: string, title: string, extra = "") =>
  shell(`<div class="vp-doc">${badge(track)}<h1>${title}</h1>${extra}</div>`);

const HERO_MARK = `<svg class="cohost-mark" data-expression="talking" role="img" aria-label="The cohost mascot" viewBox="0 0 64 64"><rect/></svg>`;
export const HOME_BODY = `<div class="VPHero"><div class="image">${HERO_MARK}</div></div><div class="cohost-flow"><ol><li>Chat</li><li>Salience</li><li>Cortex</li><li>Voice</li><li>Sink</li><li>Avatar</li></ol></div>`;

export const NOT_FOUND_BODY = `<div class="NotFound"><svg class="cohost-mark" data-expression="lost" role="img" aria-label="The cohost mascot" viewBox="0 0 64 64"><rect/></svg><h1>Page not found</h1><p>There is no page at this address.</p><a href="/cohost/">Go to the home page</a> <a href="/cohost/start/what-is-cohost">What is cohost?</a><div class="cohost-aside"><p class="cohost-aside-title">The co-host says</p><p>I looked behind the couch.</p></div></div>`;

/** A valid built site's theme-relevant files (the home page, the 404 page); tests add pages to it. */
export function themeDist(): Record<string, string> {
  return {
    "index.html": shell(HOME_BODY),
    "404.html": shell(NOT_FOUND_BODY),
  };
}
