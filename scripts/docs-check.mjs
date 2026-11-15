#!/usr/bin/env node
/**
 * Docs-site check (docs-site segment, DOCS-BUILD-001, DOCS-BUILD-005): a deterministic, read-only pass over the
 * documentation, run by `pnpm docs:build` before and after `vitepress build`.
 *
 *   node scripts/docs-check.mjs [root]         source pass: frontmatter, sidebar, glossary links, facts checked against
 *                                              the repository, links to GitHub, wording, README and examples
 *   node scripts/docs-check.mjs --dist [root]  built-site pass over docs/.vitepress/dist: unpublished files, link anchors
 *
 * Prints one line per problem (`file[:line]: [SPEC-ID] message`) to stderr and exits 1; prints a summary and exits 0 when
 * there are none. `root` defaults to the repository root. Needs only Node and the workspace's own `yaml` package.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDesign, parseYaml, splitFrontmatter } from '../docs/.vitepress/design-excerpts.mjs';

const SITE = 'https://codercoco-studios.github.io/cohost/';
const GH = 'https://github.com/CoderCoco-Studios/cohost';
const BASE = '/cohost/';
const TRACKS = ['start', 'simple', 'advanced', 'project'];
const SECTIONS = [
  ['Start here', 'start'],
  ['Set it up and run it', 'simple'],
  ['Build on it', 'advanced'],
  ['Project', 'project'],
];
const REQUIRED_EXCLUDES = ['high-level-design.md', 'intent/**', 'decisions/**', 'arrows/**', 'lid/**', 'plans/**'];
const MAY_BE_EMPTY = new Set(['decisions/**', 'plans/**']);
const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console']);
const ENV_LANGS = new Set(['env', 'dotenv']);
const PNPM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'update', 'exec', 'dlx', 'run', 'why', 'list', 'ls', 'store', 'config', 'env', 'outdated', 'prune', 'rebuild', 'setup', 'init', 'import', 'link', 'unlink', 'audit', 'fetch', 'patch', 'pack', 'publish']);
const PNPM_SKIP_FLAGS = new Set(['--filter', '-F', '-r', '--recursive', '-C', '--dir']);
const NARRATION = /\b(previously|formerly|deprecated|legacy)\b/gi;
const ALLOW = '<!-- docs-check: allow -->';
const GLOSSARY = 'start/glossary.md';
const ENV_PAGE = 'advanced/reference/env.md';
const CONFIG_PAGE = 'advanced/reference/config.md';
const EVENTS_PAGE = 'advanced/reference/events.md';
const REQUIRED_TERMS = ['vtuber', 'obs', 'browser-source', 'obs-websocket', 'stt', 'tts', 'llm', 'embedding', 'ollama', 'redis', 'redis-streams', 'bus', 'event', 'consumer-group', 'docker', 'container', 'docker-compose', 'compose-profile', 'postgres', 'pgvector', 'wsl2', 'gpu', 'vtube-studio', 'vrm', 'vmc', 'osc', 'salience', 'affect', 'valence-arousal', 'cortex', 'hook', 'reflex', 'connector', 'sink', 'heartbeat', 'mock-mode'];

// ---------------------------------------------------------------------------------------------------- file helpers

const posixPath = (p) => p.split(sep).join('/');
const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every file under `dir` as paths relative to it (POSIX), sorted; `skip` names directories not to enter. */
function walk(dir, skip = new Set(['node_modules']), base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (skip.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, skip, base, out);
    else out.push(posixPath(relative(base, p)));
  }
  return out;
}

/** A glob of the `srcExclude` forms (`a.md`, `dir/**`, `*`) as a RegExp over a docs-relative path. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += esc(c);
  }
  return new RegExp(`^${re}$`);
}

// ---------------------------------------------------------------------------------------------------- markdown analysis

/**
 * Splits a markdown file into what the checks need. Line numbers are 1-based over the whole file.
 * `fences` {lang, line, lines:[{n,text}]}, `plain` the non-fence body lines {n,text}, `headings`, `prose` (code spans, link text,
 * headings, comments and tags removed; table cells and ::: container text kept), `spans` inline code span texts, `links` hrefs.
 */
function analyze(text) {
  const all = text.replace(/\r\n/g, '\n').split('\n');
  let first = 0;
  if (/^---[ \t]*$/.test(all[0] ?? '')) {
    const close = all.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
    if (close > 0) first = close + 1;
  }
  const fences = [];
  const plain = [];
  let fence = null;
  for (let i = first; i < all.length; i++) {
    const line = all[i];
    const m = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && /^\s{0,3}(`+|~+)\s*$/.test(line)) {
        fence.end = i + 1;
        fence = null;
      } else fence.lines.push({ n: i + 1, text: line });
    } else if (m) {
      fence = { ch: m[1][0], len: m[1].length, lang: m[2].toLowerCase(), line: i + 1, lines: [], end: null };
      fences.push(fence);
    } else plain.push({ n: i + 1, text: line });
  }
  const headings = [];
  const prose = [];
  const spans = [];
  const links = [];
  for (const { n, text: raw } of plain) {
    const h = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(raw);
    const noSpans = raw.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _t, inner) => {
      spans.push(inner.trim());
      return ' ';
    });
    for (const lm of noSpans.matchAll(/\]\(\s*<?([^)\s>]+)>?/g)) links.push({ n, href: lm[1] });
    const def = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(noSpans);
    if (def) links.push({ n, href: def[1] });
    if (h) {
      headings.push({ n, level: h[1].length, text: h[2] });
      continue;
    }
    const text2 = noSpans
      .replace(/<!--.*?-->/g, ' ')
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/!?\[[^\]]*\]\[[^\]]*\]/g, ' ')
      .replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/, ' ')
      .replace(/<https?:[^>]*>/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^\s*:::.*$/, ' ');
    prose.push({ n, text: text2, raw });
  }
  return { all, first, fences, plain, headings, prose, spans, links };
}

/** Resolves a link href found in the page at docs-relative `pageRel` to a docs-relative target, or null for external links. */
function resolveDocLink(pageRel, href) {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return null;
  const hash = href.indexOf('#');
  const frag = hash === -1 ? '' : href.slice(hash + 1);
  const pathPart = (hash === -1 ? href : href.slice(0, hash)).split('?')[0];
  let target;
  if (pathPart === '') target = pageRel;
  else if (pathPart.startsWith('/')) target = pathPart.slice(1);
  else target = posix.normalize(posix.join(posix.dirname(pageRel), pathPart));
  return { target: target.replace(/\.md$/, ''), frag };
}

const normRoute = (link) => link.replace(/[#?].*$/, '').replace(/\.md$/, '').replace(/^\/+/, '');

// ---------------------------------------------------------------------------------------------------- page tree and sidebar

/** Parses the docs-site LLD's Page tree: [{ name, track, rows: [{ group, page, path }] }], tables in order. */
export function parsePageTree(lld) {
  const lines = lld.split('\n');
  const start = lines.findIndex((l) => /^## Page tree\s*$/.test(l));
  if (start === -1) return [];
  const sections = [];
  let section = null;
  let header = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^## /.test(line)) break;
    const h = /^\*\*(.+?)\*\*\s*\(`track:\s*(\w+)`\)/.exec(line);
    if (h) {
      section = { name: h[1], track: h[2], rows: [] };
      sections.push(section);
      header = null;
      continue;
    }
    if (!section || !line.trim().startsWith('|')) {
      if (!line.trim()) header = null;
      continue;
    }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const get = (name) => cells[header.indexOf(name)] ?? '';
    const path = /`([^`]+)`/.exec(get('path'))?.[1] ?? '';
    section.rows.push({ group: header.includes('group') ? get('group') : '', page: get('page'), path });
  }
  return sections;
}

const linkOfPath = (p) => (p === 'index.md' ? '/' : p.endsWith('/index.md') ? `/${p.slice(0, -8)}` : `/${p.replace(/\.md$/, '')}`);

/** Every page link of a sidebar with its section, level-2 group, depth and the group chain above it. */
export function flattenSidebar(sidebar) {
  const out = [];
  const visit = (items, section, chain) => {
    for (const it of items ?? []) {
      if (it.items) visit(it.items, section, [...chain, it.text]);
      else if (it.link) out.push({ section, group: chain[0] ?? '', chain, link: it.link });
    }
  };
  for (const s of sidebar) visit(s.items, s.text, []);
  return out;
}

/**
 * Checks the sidebar and nav as data against the LLD page tree: section names (DOCS-IA-001), page order and grouping
 * (DOCS-IA-002), collapse flags (DOCS-IA-005), nav (DOCS-IA-007), group depth (DOCS-IA-009). Returns problem strings.
 */
export function sidebarStructureProblems(sidebar, nav, tree) {
  const out = [];
  const names = sidebar.map((s) => s.text);
  if (JSON.stringify(names) !== JSON.stringify(SECTIONS.map((s) => s[0]))) {
    out.push(`[DOCS-IA-001] sidebar sections are ${JSON.stringify(names)}; expected ${JSON.stringify(SECTIONS.map((s) => s[0]))}`);
  }
  const expected = [];
  for (const s of tree) {
    for (const r of s.rows) if (r.path.endsWith('.md') && r.path !== 'index.md') expected.push(`${s.name}|${r.group}|${linkOfPath(r.path)}`);
  }
  const expectedLinks = new Set(expected.map((e) => e.split('|')[2]));
  const actual = flattenSidebar(sidebar).filter((e) => expectedLinks.has(e.link)).map((e) => `${e.section}|${e.group}|${e.link}`);
  if (expected.length && JSON.stringify(expected) !== JSON.stringify(actual)) {
    const i = expected.findIndex((e, k) => e !== actual[k]);
    out.push(`[DOCS-IA-002] sidebar order or grouping differs from the LLD page tree at entry ${i + 1}: expected ${expected[i]} (section|group|link), found ${actual[i] ?? 'nothing'}`);
  }
  sidebar.forEach((s) => {
    if ('collapsed' in s) out.push(`[DOCS-IA-005] section "${s.text}" must not be collapsible (no collapsed key)`);
    for (const it of s.items ?? []) {
      if (it.items && (s.text === 'Start here' || s.text === 'Project')) out.push(`[DOCS-IA-005] section "${s.text}" must hold pages and no groups, found group "${it.text}"`);
      if (it.items && s.text === 'Set it up and run it' && it.collapsed !== false) out.push(`[DOCS-IA-005] group "${it.text}" in "${s.text}" must have collapsed: false`);
      if (it.items && s.text === 'Build on it' && it.collapsed !== true) out.push(`[DOCS-IA-005] group "${it.text}" in "${s.text}" must have collapsed: true`);
    }
    const deep = (items, depth, inArch) => {
      for (const it of items ?? []) {
        if (!it.items) continue;
        const d = depth + 1;
        const arch = inArch || (d === 2 && it.text === 'Architecture');
        if (d > 4) out.push(`[DOCS-IA-009] group "${it.text}" is nested ${d} levels deep; at most four`);
        else if (d >= 3 && !inArch) out.push(`[DOCS-IA-009] group "${it.text}" is a level-${d} group outside the Architecture group`);
        else if (d >= 3 && it.collapsed !== true) out.push(`[DOCS-IA-009] group "${it.text}" must have collapsed: true`);
        deep(it.items, d, arch);
      }
    };
    deep(s.items, 1, false);
  });
  const wantNav = [['Start here', 'start/what-is-cohost'], ['Guide', 'guide/install/prerequisites'], ['Advanced', 'advanced/dev-setup'], ['Project', 'project/spec-driven']];
  const gotNav = (nav ?? []).map((n) => [n.text, normRoute(n.link ?? '')]);
  if (JSON.stringify(gotNav) !== JSON.stringify(wantNav)) out.push(`[DOCS-IA-007] nav is ${JSON.stringify(gotNav)}; expected ${JSON.stringify(wantNav)} (Start here, Guide, Advanced, Project in order)`);
  return out;
}

// ---------------------------------------------------------------------------------------------------- YAML-ish facts

/** Every mapping key path of a parsed YAML value: `a.b`, list items as `a.b[].c`. */
function keyPaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) keyPaths(item, `${prefix}[]`, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : String(k);
      out.add(p);
      keyPaths(v, p, out);
    }
  }
  return out;
}

/** Whether any code span names `token` as a whole dotted/identifier token. */
const spanNames = (spans, token) => {
  const re = new RegExp(`(?<![\\w.\\]-])${esc(token)}(?![\\w]|\\.\\w|-\\w|\\[)`);
  return spans.some((s) => re.test(s));
};
const portNamed = (spans, port) => spans.some((s) => new RegExp(`(?<!\\d)${port}(?!\\d)`).test(s));

/** Splits a command line into leading NAME=value assignments and the remaining command text. */
function leadingAssignments(cmd) {
  const names = [];
  let rest = cmd.trim().replace(/^export\s+/, '');
  for (;;) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)\s*/.exec(rest);
    if (!m) break;
    names.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { names, rest };
}

/** Command lines of a shell fence: {n, cmd}; heredoc bodies stay command lines (each is a line of the fence). */
function commandLines(fence) {
  const out = [];
  for (const { n, text } of fence.lines) {
    if (!text.trim()) continue;
    if (fence.lang === 'console') {
      if (text.startsWith('$ ')) out.push({ n, cmd: text.slice(2) });
    } else if (!text.trim().startsWith('#')) out.push({ n, cmd: text });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- source pass

/**
 * Runs the source pass over the repository at `root`; returns problems `{ file, line, spec, msg }`.
 * @spec DOCS-BUILD-005, DOCS-PUB-001, DOCS-PUB-002, DOCS-PUB-004, DOCS-IA-001, DOCS-IA-002, DOCS-IA-003, DOCS-IA-004, DOCS-IA-005, DOCS-IA-006, DOCS-IA-007, DOCS-IA-008, DOCS-IA-009,
 * DOCS-PAGE-001, DOCS-PAGE-002, DOCS-PAGE-003, DOCS-PAGE-004, DOCS-PAGE-005, DOCS-PAGE-006, DOCS-PAGE-007, DOCS-GLOSS-001, DOCS-GLOSS-002, DOCS-GLOSS-003, DOCS-GLOSS-004,
 * DOCS-LINK-002, DOCS-FACT-001, DOCS-FACT-002, DOCS-FACT-003, DOCS-FACT-004, DOCS-FACT-005, DOCS-FACT-006, DOCS-ARCH-004, DOCS-ARCH-009,
 * DOCS-README-001, DOCS-README-002, DOCS-README-003, DOCS-README-004, DOCS-EX-001, DOCS-EX-002, DOCS-EX-003, DOCS-EX-004
 */
export async function runSource(root) {
  const problems = [];
  const add = (file, line, spec, msg) => problems.push({ file, line, spec, msg });
  const docs = join(root, 'docs');

  // ---- config: srcExclude, ignoreDeadLinks
  const configRel = 'docs/.vitepress/config.ts';
  const configText = readIf(join(root, configRel));
  let excludes = [];
  if (configText === null) add(configRel, 0, 'DOCS-PUB-001', 'cannot read the VitePress config');
  else {
    const m = /srcExclude\s*:\s*\[([\s\S]*?)\]/.exec(configText);
    excludes = m ? [...m[1].matchAll(/(['"])(.*?)\1/g)].map((x) => x[2]) : [];
    for (const p of REQUIRED_EXCLUDES) if (!excludes.includes(p)) add(configRel, 0, 'DOCS-PUB-001', `srcExclude is missing "${p}"`);
    const dl = /ignoreDeadLinks\s*:\s*([^,\n}]+)/.exec(configText);
    if (dl && dl[1].trim().replace(/["']/g, "'") !== "'localhostLinks'") add(configRel, 0, 'DOCS-BUILD-004', `ignoreDeadLinks must be unset or 'localhostLinks', found ${dl[1].trim()}`);
  }
  const allDocsFiles = walk(docs, new Set(['node_modules']));
  const excluded = excludes.map((g) => [g, globToRegExp(g)]);
  for (const [g, re] of excluded) {
    if (MAY_BE_EMPTY.has(g)) continue;
    if (!allDocsFiles.some((f) => re.test(f))) add(configRel, 0, 'DOCS-PUB-002', `srcExclude pattern "${g}" matches no file under docs/`);
  }
  const isExcluded = (rel) => excluded.some(([, re]) => re.test(rel));
  const mdFiles = allDocsFiles.filter((f) => f.endsWith('.md') && !f.startsWith('.vitepress/') && !isExcluded(f));
  const isTemplate = (f) => /\[[^\]/]+\]\.md$/.test(f);
  const templates = mdFiles.filter(isTemplate);
  const handFiles = mdFiles.filter((f) => !isTemplate(f));

  // ---- LLD page tree
  const lldRel = 'docs/intent/docs-site/docs-site-design.md';
  const lldText = readIf(join(root, lldRel));
  const tree = lldText === null ? [] : parsePageTree(lldText);
  if (lldText === null) add(lldRel, 0, 'DOCS-PUB-004', 'cannot read the docs-site LLD (the page tree)');
  else if (!tree.length) add(lldRel, 0, 'DOCS-PUB-004', 'no Page tree tables found');
  const treePaths = new Set(tree.flatMap((s) => s.rows.map((r) => r.path)).filter((p) => p.endsWith('.md')));
  for (const f of handFiles) {
    if (tree.length && !treePaths.has(f)) add(`docs/${f}`, 0, 'DOCS-PUB-004', 'is published but is not a page named in the docs-site LLD Page tree');
  }
  for (const f of templates) {
    if (!f.startsWith('advanced/architecture/')) add(`docs/${f}`, 0, 'DOCS-PUB-004', 'a dynamic-route template is allowed only under docs/advanced/architecture/');
  }
  for (const p of treePaths) {
    if (!existsSync(join(docs, p)) || isExcluded(p)) add(`docs/${p}`, 0, 'DOCS-IA-002', 'is named in the docs-site LLD Page tree but does not exist');
  }

  // ---- hand-written pages
  const pages = new Map();
  for (const f of handFiles) {
    const text = readFileSync(join(docs, f), 'utf8');
    const a = analyze(text);
    let fm = {};
    let fmRaw = '';
    try {
      fm = splitFrontmatter(text, `docs/${f}`).data;
    } catch (e) {
      add(`docs/${f}`, 0, 'DOCS-PAGE-001', e.message.replace(/^docs\/[^:]*:\s*/, ''));
    }
    if (a.first > 0) fmRaw = a.all.slice(1, a.first - 1).join('\n');
    pages.set(f, { rel: f, file: `docs/${f}`, text, a, fm, fmRaw });
  }

  // ---- excerpt pages (the loaders' output)
  let excerpts = [];
  if (templates.length) {
    try {
      excerpts = loadDesign(root).pages;
    } catch (e) {
      const m = /^([^\s:]+):\s*(.*)$/s.exec(e.message);
      add(m ? m[1] : 'docs/high-level-design.md', 0, 'DOCS-ARCH-004', m ? m[2] : e.message);
    }
  }

  // ---- per-page frontmatter, structure, wording
  const isHome = (p) => p.rel === 'index.md';
  for (const p of pages.values()) {
    const { fm, file, a } = p;
    if (!fm.title || typeof fm.title !== 'string') add(file, 0, 'DOCS-PAGE-001', 'frontmatter needs a non-empty title');
    if (!fm.description || typeof fm.description !== 'string') add(file, 0, 'DOCS-PAGE-001', 'frontmatter needs a non-empty description');
    if (!TRACKS.includes(fm.track)) add(file, 0, 'DOCS-PAGE-001', `frontmatter track must be one of ${TRACKS.join(', ')}; found ${JSON.stringify(fm.track ?? null)}`);
    if (isHome(p) && fm.track !== 'start') add(file, 0, 'DOCS-PAGE-001', 'the home page carries track: start');
    if (a.fences.length) {
      const v = /^verified:[ \t]*["']?([^\s"'#]*)["']?[ \t]*(?:#.*)?$/m.exec(p.fmRaw);
      if (!v || !/^[0-9a-f]{7,40}$/.test(v[1])) add(file, 0, 'DOCS-PAGE-002', `has a fenced code block, so frontmatter needs verified: <7 to 40 lowercase hex characters>; found ${v ? JSON.stringify(v[1]) : 'none'}`);
    }
    for (const { n, text } of a.plain) {
      const bare = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, ' ');
      for (const m of bare.matchAll(/!\[([^\]]*)\]\([^)]*\)/g)) if (!m[1].trim()) add(file, n, 'DOCS-PAGE-003', 'markdown image has no alt text');
      for (const m of bare.matchAll(/<img\b[^>]*>/gi)) {
        const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[0]);
        if (!alt || !(alt[1] ?? alt[2] ?? '').trim()) add(file, n, 'DOCS-PAGE-003', '<img> has no alt text');
      }
    }
    if (p.rel !== 'project/verification-log.md') {
      for (const { n, text, raw } of a.prose) {
        if (raw.includes(ALLOW)) continue;
        for (const m of text.matchAll(NARRATION)) add(file, n, 'DOCS-PAGE-004', `uses "${m[0]}"; pages describe what is true today (add ${ALLOW} to the line if the current-tense sense is needed)`);
      }
    }
    if (!isHome(p)) {
      const h1 = a.headings.filter((h) => h.level === 1);
      if (h1.length !== 1) add(file, h1[1]?.n ?? 0, 'DOCS-PAGE-007', `needs exactly one # heading; found ${h1.length}`);
    }
    // step pages
    if (/^guide\/(install|connect)\//.test(p.rel) && p.rel !== 'guide/install/prerequisites.md') {
      const h2 = a.headings.filter((h) => h.level === 2).map((h) => ({ ...h, text: h.text.replace(/[‘’]/g, "'").trim() }));
      for (const want of ['What you need', 'How you know it worked', "If it didn't"]) {
        if (!h2.some((h) => h.text === want)) add(file, 0, 'DOCS-PAGE-005', `needs a "## ${want}" heading`);
      }
      const at = h2.find((h) => h.text === "If it didn't");
      if (at) {
        const next = a.headings.find((h) => h.level <= 2 && h.n > at.n);
        const inSection = a.links.filter((l) => l.n > at.n && (!next || l.n < next.n));
        if (!inSection.some((l) => resolveDocLink(p.rel, l.href)?.target === 'guide/troubleshooting')) add(file, at.n, 'DOCS-PAGE-005', 'the "If it didn\'t" section must link the troubleshooting page (guide/troubleshooting.md)');
      }
    }
  }

  // ---- extend page (DOCS-PAGE-006)
  const extend = pages.get('advanced/extend/index.md');
  if (extend) {
    const t = extend.text;
    const need = [
      [/@cohost\/bus/, 'name `@cohost/bus` as a supported route'],
      [/crates\/cohost-bus/, 'name `crates/cohost-bus` as a supported route'],
      [/no\s+example\s+yet/i, 'say the Rust route has "no example yet"'],
      [/no\s+event\s+validation/i, 'say a process on neither client gets "no event validation"'],
      [/no\s+dashboard\s+control/i, 'say a process on neither client gets "no dashboard control"'],
      [/no\s+health\s+reporting/i, 'say a process on neither client gets "no health reporting"'],
    ];
    for (const [re, what] of need) if (!re.test(t)) add(extend.file, 0, 'DOCS-PAGE-006', `must ${what}`);
    for (const { n, raw } of extend.a.prose) {
      if (/\bpython\b/i.test(raw) && /\bsupported\b/i.test(raw) && !/\b(not|isn't|never|no|unsupported)\b/i.test(raw)) add(extend.file, n, 'DOCS-PAGE-006', 'presents a process on neither bus client (Python) as a supported way to extend cohost');
    }
  }

  // ---- architecture index page (DOCS-ARCH-009)
  const arch = pages.get('advanced/architecture/index.md');
  if (arch) {
    const t = arch.text;
    if (!(/excerpt/i.test(t) && /as written/i.test(t) && /not held to/i.test(t) && /wording/i.test(t) && /glossary[- ]link/i.test(t))) {
      add(arch.file, 0, 'DOCS-ARCH-009', "must say the pages beneath are excerpts of the design documents shown as written, not held to the site's wording and glossary-link rules");
    }
    if (!arch.a.links.some((l) => resolveDocLink(arch.rel, l.href)?.target === 'start/glossary')) add(arch.file, 0, 'DOCS-ARCH-009', 'must link the glossary page');
  }

  // ---- home page entry actions (DOCS-IA-008), how-it-works/glossary navigation (DOCS-IA-006)
  const home = pages.get('index.md');
  if (home) {
    const targets = [...(home.fm.hero?.actions ?? []), ...(home.fm.features ?? [])].map((x) => normRoute(String(x?.link ?? '')));
    for (const want of ['start/what-is-cohost', 'guide/install/prerequisites', 'advanced/dev-setup']) {
      if (!targets.includes(want)) add(home.file, 0, 'DOCS-IA-008', `the home page needs an entry action linking /${want}`);
    }
  }
  const gloss = pages.get(GLOSSARY);
  if (gloss && !(gloss.fm.prev === false && gloss.fm.next === false)) add(gloss.file, 0, 'DOCS-IA-006', 'the glossary must set prev: false and next: false');
  const how = pages.get('start/how-it-works.md');
  if (how && normRoute(String(how.fm.next?.link ?? '')) !== 'guide/install/prerequisites') add(how.file, 0, 'DOCS-IA-006', 'How it works must set next to the What you need page (link: /guide/install/prerequisites)');

  // ---- glossary
  const terms = [];
  if (!gloss) add(`docs/${GLOSSARY}`, 0, 'DOCS-GLOSS-001', 'the glossary page does not exist');
  else {
    const list = gloss.fm.terms;
    if (!Array.isArray(list) || !list.length) add(gloss.file, 0, 'DOCS-GLOSS-001', 'frontmatter needs a terms list');
    else {
      const seen = new Set();
      const anchors = new Set();
      for (const h of gloss.a.headings) {
        const m = /\{#([A-Za-z0-9_-]+)\}\s*$/.exec(h.text);
        anchors.add(m ? m[1] : h.text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-'));
      }
      for (const t of list) {
        if (!t || typeof t.id !== 'string' || !t.id) {
          add(gloss.file, 0, 'DOCS-GLOSS-001', 'a term has no id');
          continue;
        }
        if (seen.has(t.id)) add(gloss.file, 0, 'DOCS-GLOSS-001', `term id "${t.id}" is listed twice`);
        seen.add(t.id);
        if (!Array.isArray(t.match) || !t.match.length || t.match.some((x) => typeof x !== 'string' || !x.trim())) add(gloss.file, 0, 'DOCS-GLOSS-001', `term "${t.id}" needs a non-empty match list`);
        else terms.push({ id: t.id, match: t.match });
        if (!anchors.has(t.id)) add(gloss.file, 0, 'DOCS-GLOSS-001', `term "${t.id}" has no heading with the anchor {#${t.id}}`);
      }
      for (const id of REQUIRED_TERMS) if (!seen.has(id)) add(gloss.file, 0, 'DOCS-GLOSS-003', `the glossary must define the term "${id}"`);
    }
  }
  const termRes = terms.map((t) => ({
    id: t.id,
    re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${t.match.map((m) => esc(m.trim()).replace(/\s+/g, '\\s+')).join('|')})s?(?![\\p{L}\\p{N}_])`, 'iu'),
  }));
  for (const p of pages.values()) {
    if (p.rel === GLOSSARY) continue;
    const skip = Array.isArray(p.fm['glossary-skip']) ? p.fm['glossary-skip'].map(String) : [];
    for (const { id, re } of termRes) {
      if (skip.includes(id)) continue;
      const hit = p.a.prose.find((l) => re.test(l.text));
      if (!hit) continue;
      const linked = p.a.links.some((l) => {
        const r = resolveDocLink(p.rel, l.href);
        return r && r.target === 'start/glossary' && r.frag === id;
      });
      if (!linked) add(p.file, hit.n, 'DOCS-GLOSS-002', `uses the glossary term "${id}" in prose but never links start/glossary.md#${id} (or lists ${id} in glossary-skip)`);
    }
  }

  // ---- sidebar and nav
  const sideRel = 'docs/.vitepress/sidebar.mjs';
  let side = null;
  try {
    side = await import(pathToFileURL(join(root, sideRel)).href);
  } catch (e) {
    add(sideRel, 0, 'DOCS-BUILD-008', `cannot load the sidebar: ${e.message.split('\n')[0]}`);
  }
  const urlOf = new Map();
  for (const p of pages.values()) urlOf.set(linkOfPath(p.rel), { file: p.file, track: p.fm.track });
  for (const e of excerpts) urlOf.set(`/${e.route}`, { file: e.source, track: e.track, excerpt: true });
  if (side) {
    for (const m of sidebarStructureProblems(side.sidebar, side.nav, tree)) {
      const spec = /^\[(DOCS-[A-Z]+-\d+)\]/.exec(m)[1];
      add(sideRel, 0, spec, m.replace(/^\[[^\]]+\]\s*/, ''));
    }
    const flat = flattenSidebar(side.sidebar);
    for (const l of [...flat.map((f) => f.link), ...(side.nav ?? []).map((n) => n.link)]) {
      const key = String(l).replace(/[#?].*$/, '').replace(/\.md$/, '');
      if (!urlOf.has(key) && !(key === '' && urlOf.has('/'))) add(sideRel, 0, 'DOCS-IA-003', `link ${l} resolves to no published page`);
    }
    const count = new Map();
    for (const f of flat) count.set(f.link.replace(/[#?].*$/, ''), (count.get(f.link.replace(/[#?].*$/, '')) ?? 0) + 1);
    for (const [url, info] of urlOf) {
      if (url === '/') continue;
      const n = count.get(url) ?? 0;
      if (n !== 1) add(info.file, 0, 'DOCS-IA-004', `page ${url} appears ${n} times in the sidebar; expected exactly once`);
    }
    for (const f of flat) {
      const info = urlOf.get(f.link.replace(/[#?].*$/, ''));
      const want = Object.fromEntries(SECTIONS)[f.section] ?? null;
      if (info && want && info.track !== want) add(info.file, 0, 'DOCS-IA-001', `has track ${JSON.stringify(info.track)} but sits in the sidebar section "${f.section}" (track ${want})`);
    }
  }

  // ---- facts: package scripts, env vars, ports, config keys, event types
  const pkgText = readIf(join(root, 'package.json'));
  let scripts = new Set();
  try {
    scripts = new Set(Object.keys(JSON.parse(pkgText ?? '{}').scripts ?? {}));
  } catch (e) {
    add('package.json', 0, 'DOCS-FACT-001', `cannot parse package.json: ${e.message}`);
  }
  const envPage = pages.get(ENV_PAGE);
  const envSpans = envPage?.a.spans ?? [];
  const factTargets = [...pages.values()];
  const readme = readIf(join(root, 'README.md'));
  if (readme !== null) factTargets.push({ rel: 'README.md', file: 'README.md', a: analyze(readme), text: readme, fm: {}, readme: true });
  for (const p of factTargets) {
    for (const fence of p.a.fences) {
      if (SHELL_LANGS.has(fence.lang)) {
        const cmds = commandLines(fence);
        const firstLine = fence.lines.find((l) => l.text.trim());
        const firstIsCmd = firstLine && cmds.some((c) => c.n === firstLine.n);
        for (const { n, cmd } of cmds) {
          const { names } = leadingAssignments(cmd);
          for (const name of names) if (/^[A-Z][A-Z0-9_]*$/.test(name) && !spanNames(envSpans, name)) add(p.file, n, 'DOCS-FACT-002', `names variable ${name}, which the Environment and ports page (${ENV_PAGE}) does not name`);
        }
        if (!firstIsCmd) continue;
        for (const { n, cmd } of cmds) {
          for (const seg of cmd.split(/&&|\|\||;|\|/)) {
            const tokens = leadingAssignments(seg).rest.split(/\s+/).filter(Boolean);
            if (tokens[0] !== 'pnpm') continue;
            const args = tokens.slice(1);
            if (args.some((t) => PNPM_SKIP_FLAGS.has(t))) continue;
            const flagless = args.filter((t) => !t.startsWith('-'));
            let name = flagless[0];
            if (name === 'run') name = flagless[1];
            else if (name === undefined || PNPM_BUILTINS.has(name)) continue;
            if (name !== undefined && !scripts.has(name)) add(p.file, n, 'DOCS-FACT-001', `command "pnpm ${args.join(' ')}" names ${name}, which is no script in the root package.json`);
          }
        }
      } else if (ENV_LANGS.has(fence.lang)) {
        for (const { n, text } of fence.lines) {
          if (!text.trim() || text.trim().startsWith('#')) continue;
          for (const name of leadingAssignments(text).names) if (/^[A-Z][A-Z0-9_]*$/.test(name) && !spanNames(envSpans, name)) add(p.file, n, 'DOCS-FACT-002', `names variable ${name}, which the Environment and ports page (${ENV_PAGE}) does not name`);
        }
      }
    }
  }
  const mustExist = (page, rel, spec) => {
    if (!page) add(`docs/${rel}`, 0, spec, 'the page does not exist');
    return page;
  };
  const envText = readIf(join(root, '.env.example'));
  if (mustExist(envPage, ENV_PAGE, 'DOCS-FACT-003') && envText !== null) {
    const names = new Set();
    for (const line of envText.split('\n')) {
      const m = /^#?\s?([A-Z][A-Z0-9_]*)=/.exec(line);
      if (m && !/^#\s{2,}/.test(line)) names.add(m[1]);
    }
    for (const name of names) if (!spanNames(envSpans, name)) add(envPage.file, 0, 'DOCS-FACT-003', `does not name ${name}, which .env.example assigns or shows commented out`);
    const ports = new Set(['3000', '3001']);
    const compose = readIf(join(root, 'docker-compose.yml'));
    if (compose !== null) {
      try {
        for (const svc of Object.values(parseYaml(compose)?.services ?? {})) {
          for (const entry of svc?.ports ?? []) {
            let host = null;
            if (typeof entry === 'object' && entry) host = String(entry.published ?? '');
            else {
              const s = String(entry).replace(/\$\{[^}:]+:-([^}]*)\}/g, '$1').replace(/\/(tcp|udp)$/, '');
              const parts = s.split(':');
              host = parts.length === 2 ? parts[0] : parts.length === 3 ? parts[1] : null;
            }
            if (host && /^\d+$/.test(host)) ports.add(host);
          }
        }
      } catch (e) {
        add('docker-compose.yml', 0, 'DOCS-FACT-004', `cannot parse: ${String(e.message).split('\n')[0]}`);
      }
    }
    for (const port of [...ports].sort((a, b) => a - b)) if (!portNamed(envSpans, port)) add(envPage.file, 0, 'DOCS-FACT-004', `does not name host port ${port}`);
  }
  const cfgYaml = readIf(join(root, 'config/config.example.yaml'));
  const cfgPage = mustExist(pages.get(CONFIG_PAGE), CONFIG_PAGE, 'DOCS-FACT-005');
  if (cfgPage && cfgYaml !== null) {
    try {
      for (const path of keyPaths(parseYaml(cfgYaml))) if (!spanNames(cfgPage.a.spans, path)) add(cfgPage.file, 0, 'DOCS-FACT-005', `does not name the config key ${path}`);
    } catch (e) {
      add('config/config.example.yaml', 0, 'DOCS-FACT-005', `cannot parse: ${String(e.message).split('\n')[0]}`);
    }
  }
  const eventsTs = readIf(join(root, 'packages/bus/src/events.ts'));
  const evPage = mustExist(pages.get(EVENTS_PAGE), EVENTS_PAGE, 'DOCS-FACT-006');
  if (evPage && eventsTs !== null) {
    const lines = eventsTs.split('\n');
    const start = lines.findIndex((l) => /^export const EventPayloads\s*=\s*\{/.test(l));
    if (start === -1) add('packages/bus/src/events.ts', 0, 'DOCS-FACT-006', 'cannot find EventPayloads');
    else {
      for (let i = start + 1; i < lines.length && !/^\}/.test(lines[i]); i++) {
        const m = /^ {2}"([^"]+)":/.exec(lines[i]);
        if (m && !spanNames(evPage.a.spans, m[1])) add(evPage.file, 0, 'DOCS-FACT-006', `does not name the event type ${m[1]}`);
      }
    }
  }

  // ---- links to this repository on GitHub
  const checkGithub = (file, lines) => {
    for (const { n, text } of lines) {
      const bare = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, ' ');
      for (const m of bare.matchAll(new RegExp(`${esc(GH)}/(blob|tree)/main/([^\\s)\\]>"'#?]*)`, 'g'))) {
        const path = decodeURIComponent(m[2]).replace(/\/$/, '');
        const abs = join(root, path);
        let ok = false;
        try {
          const st = statSync(abs);
          ok = m[1] === 'blob' ? st.isFile() : st.isDirectory();
        } catch {
          ok = false;
        }
        if (!ok) add(file, n, 'DOCS-LINK-002', `link ${m[0]} names ${path || '(root)'}, which does not exist in the repository as a ${m[1] === 'blob' ? 'file' : 'directory'}`);
      }
    }
  };
  for (const p of pages.values()) checkGithub(p.file, p.a.plain);
  if (readme !== null) checkGithub('README.md', analyze(readme).plain);
  const exampleReadmes = walk(join(root, 'examples')).filter((f) => posix.basename(f) === 'README.md').map((f) => `examples/${f}`);
  for (const f of exampleReadmes) checkGithub(f, analyze(readFileSync(join(root, f), 'utf8')).plain);
  for (const e of excerpts) {
    const lines = e.content.split('\n').map((text) => ({ n: 0, text }));
    checkGithub(e.source, lines);
  }

  // ---- README
  if (readme === null) add('README.md', 0, 'DOCS-README-001', 'README.md does not exist');
  else {
    const ra = analyze(readme);
    const lineCount = readme.replace(/\n$/, '').split('\n').length;
    if (lineCount > 60) add('README.md', 0, 'DOCS-README-001', `is ${lineCount} lines; at most 60`);
    for (const { n, text, raw } of ra.prose) {
      if (raw.includes(ALLOW)) continue;
      for (const m of text.matchAll(NARRATION)) add('README.md', n, 'DOCS-PAGE-004', `uses "${m[0]}"; the README describes what is true today`);
    }
    const h2 = ra.headings.filter((h) => h.level === 2).map((h) => h.text);
    if (JSON.stringify(h2) !== JSON.stringify(['Quick start', 'Documentation', 'License'])) add('README.md', 0, 'DOCS-README-002', `## sections are ${JSON.stringify(h2)}; expected ["Quick start","Documentation","License"]`);
    const qs = ra.headings.find((h) => h.level === 2 && h.text === 'Quick start');
    if (qs) {
      const nextH = ra.headings.find((h) => h.level <= 2 && h.n > qs.n);
      const inSec = (n) => n > qs.n && (!nextH || n < nextH.n);
      const fence = ra.fences.find((f) => inSec(f.line) && SHELL_LANGS.has(f.lang));
      if (!fence) add('README.md', qs.n, 'DOCS-README-003', 'Quick start needs a shell fence');
      else {
        const cmds = commandLines(fence);
        const ci = cmds.findIndex((c) => /^\s*git\s+clone\b/.test(c.cmd));
        const di = cmds.findIndex((c, i) => i > ci && /^\s*cd\s+\S+/.test(c.cmd));
        if (ci === -1) add('README.md', fence.line, 'DOCS-README-003', 'the quick start fence must run git clone');
        if (di === -1) add('README.md', fence.line, 'DOCS-README-003', 'the quick start fence must cd into the checkout after git clone');
        else {
          let count = 0;
          let heredoc = null;
          for (const c of cmds.slice(di + 1)) {
            if (heredoc) {
              if (c.cmd.trim() === heredoc) heredoc = null;
              continue;
            }
            count++;
            const hd = /<<-?\s*['"]?(\w+)['"]?/.exec(c.cmd);
            if (hd) heredoc = hd[1];
          }
          if (count > 5) add('README.md', fence.line, 'DOCS-README-003', `has ${count} command lines after the cd; at most five (a heredoc counts as one)`);
        }
        const body = fence.lines.map((l) => l.text).join('\n');
        if (!/scripts\/install\.sh/.test(body)) add('README.md', fence.line, 'DOCS-README-003', 'the quick start must run scripts/install.sh');
        if (!/(^|\n)\s*pnpm dashboard\b/.test(body)) add('README.md', fence.line, 'DOCS-README-003', 'the quick start must start the dashboard with pnpm dashboard');
        if (!body.includes('.env')) add('README.md', fence.line, 'DOCS-README-003', 'the quick start must append the mock-mode lines to .env');
        for (const line of ['LLM_PROVIDER=mock', 'MEMORY_STORE=memory', 'MEMORY_EMBEDDER=hash', 'VOICE_ENGINE=stub', 'CHAT_SOURCE=fake']) {
          if (!body.split('\n').some((l) => l.trim() === line)) add('README.md', fence.line, 'DOCS-README-003', `the quick start must add the mock-mode line ${line}`);
        }
        const after = ra.links.filter((l) => l.n > (fence.end ?? fence.line) && inSec(l.n));
        if (!after.some((l) => l.href.replace(/[#?].*$/, '').replace(/\/$/, '') === `${SITE}guide/install/real-install`)) add('README.md', fence.end ?? fence.line, 'DOCS-README-003', `the fence must be followed by a link to ${SITE}guide/install/real-install`);
      }
    }
    if (!ra.links.some((l) => l.href.replace(/[#?].*$/, '').replace(/\/$/, '') === SITE.replace(/\/$/, ''))) add('README.md', 0, 'DOCS-README-004', `must link the docs site at ${SITE}`);
  }

  // ---- examples
  for (const f of exampleReadmes) {
    const t = readFileSync(join(root, f), 'utf8');
    const lc = t.replace(/\n$/, '').split('\n').length;
    if (lc > 30) add(f, 0, 'DOCS-EX-001', `is ${lc} lines; at most 30`);
    if (!analyze(t).links.some((l) => l.href.startsWith(SITE)) && !t.includes(SITE)) add(f, 0, 'DOCS-EX-001', `must link a page of the docs site at ${SITE}...`);
  }
  const exDir = join(root, 'examples');
  const exDirs = existsSync(exDir) ? readdirSync(exDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  const modules = readIf(join(exDir, 'modules/README.md'));
  if (modules === null) add('examples/modules/README.md', 0, 'DOCS-EX-002', 'does not exist');
  else {
    const ma = analyze(modules);
    for (const name of ['server.py', 'fixtures/', 'schemas/']) if (!modules.includes(name)) add('examples/modules/README.md', 0, 'DOCS-EX-002', `must name ${name}`);
    if (!ma.fences.some((f) => f.lines.some((l) => l.text.includes('server.py')))) add('examples/modules/README.md', 0, 'DOCS-EX-002', 'must say how to run server.py (a command in a fenced block)');
    if (!ma.links.some((l) => l.href.replace(/[#?].*$/, '').replace(/\/$/, '') === `${SITE}advanced/extend/hooks`)) add('examples/modules/README.md', 0, 'DOCS-EX-002', `must link the Brain hooks page ${SITE}advanced/extend/hooks`);
  }
  const exReadme = readIf(join(exDir, 'README.md'));
  if (exReadme === null) add('examples/README.md', 0, 'DOCS-EX-003', 'does not exist');
  else {
    for (const d of exDirs) {
      const line = exReadme.split('\n').find((l) => new RegExp(`(?<![\\w-])${esc(d)}(?![\\w-])`).test(l));
      const rest = line ? line.replace(new RegExp(`(?<![\\w-])${esc(d)}(?![\\w-])`, 'g'), ' ').replace(/[`|*:/\-–—[\]()]+/g, ' ').trim() : '';
      if (!line || rest.split(/\s+/).filter(Boolean).length < 2) add('examples/README.md', 0, 'DOCS-EX-003', `must list the directory ${d}/ with a one-line description`);
    }
  }
  for (const d of exDirs) {
    const files = walk(join(exDir, d)).filter((f) => posix.basename(f) !== 'README.md');
    if (!files.length) add(`examples/${d}`, 0, 'DOCS-EX-004', 'holds no file other than README.md that a reader runs or a runnable example reads');
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------------- built-site pass

const ASSET = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|txt|woff2?|ttf|map|mp4|webm|pdf|wav|mp3)$/i;

/**
 * Runs the built-site pass over docs/.vitepress/dist; returns problems.
 * @spec DOCS-BUILD-005, DOCS-PUB-003, DOCS-LINK-001, DOCS-LINK-003
 */
export function runDist(root) {
  const problems = [];
  const add = (file, line, spec, msg) => problems.push({ file, line, spec, msg });
  const dist = join(root, 'docs/.vitepress/dist');
  if (!existsSync(dist)) {
    add('docs/.vitepress/dist', 0, 'DOCS-PUB-003', 'does not exist; run vitepress build docs first');
    return problems;
  }
  const files = walk(dist, new Set());
  const htmlFiles = files.filter((f) => f.endsWith('.html'));
  for (const f of files) {
    if (f === 'high-level-design.html' || /^(intent|decisions|arrows|lid|plans)\//.test(f)) add(`docs/.vitepress/dist/${f}`, 0, 'DOCS-PUB-003', 'was built from a file that is not published');
  }
  const idCache = new Map();
  const idsOf = (rel) => {
    if (!idCache.has(rel)) {
      const html = readFileSync(join(dist, rel), 'utf8');
      idCache.set(rel, new Set([...html.matchAll(/\sid=(?:"([^"]*)"|'([^']*)')/g)].map((m) => m[1] ?? m[2])));
    }
    return idCache.get(rel);
  };
  const fileFor = (urlPath) => {
    const cands = urlPath === '' || urlPath.endsWith('/') ? [`${urlPath}index.html`] : [urlPath.endsWith('.html') ? urlPath : `${urlPath}.html`, `${urlPath}/index.html`];
    return cands.find((c) => files.includes(c)) ?? null;
  };
  const dec = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  for (const page of htmlFiles) {
    const html = readFileSync(join(dist, page), 'utf8');
    const urlPath = page.endsWith('index.html') ? page.slice(0, -10) : page.replace(/\.html$/, '');
    const dirUrl = urlPath.endsWith('/') || urlPath === '' ? urlPath : urlPath.includes('/') ? urlPath.slice(0, urlPath.lastIndexOf('/') + 1) : '';
    for (const m of html.matchAll(/<a\s[^>]*?href=(?:"([^"]*)"|'([^']*)')/g)) {
      const href = m[1] ?? m[2];
      if (!href || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
      const hash = href.indexOf('#');
      const frag = hash === -1 ? '' : dec(href.slice(hash + 1));
      if (!frag) continue;
      const p = (hash === -1 ? href : href.slice(0, hash)).split('?')[0];
      let target;
      if (p === '') target = page;
      else if (p.startsWith('/')) {
        if (!p.startsWith(BASE)) continue;
        target = fileFor(p.slice(BASE.length));
      } else target = fileFor(posix.normalize(posix.join(dirUrl, p)).replace(/^\.\//, ''));
      if (p !== '' && ASSET.test(p)) continue;
      if (!target) continue;
      if (!idsOf(target).has(frag)) add(`docs/.vitepress/dist/${page}`, 0, 'DOCS-LINK-001', `link ${href} targets #${frag}, which is no element id on ${target}`);
    }
  }
  const readmes = ['README.md', ...walk(join(root, 'examples')).filter((f) => posix.basename(f) === 'README.md').map((f) => `examples/${f}`)];
  for (const rel of readmes) {
    const text = readIf(join(root, rel));
    if (text === null) continue;
    for (const { n, href } of analyze(text).links) {
      if (!href.startsWith(SITE)) continue;
      const hash = href.indexOf('#');
      const frag = hash === -1 ? '' : dec(href.slice(hash + 1));
      const path = (hash === -1 ? href : href.slice(0, hash)).split('?')[0].slice(SITE.length);
      const want = path === '' || path.endsWith('/') ? `${path}index.html` : `${path}.html`;
      if (!files.includes(want)) add(rel, n, 'DOCS-LINK-003', `link ${href} maps to ${want}, which is not in docs/.vitepress/dist`);
      else if (frag && !idsOf(want).has(frag)) add(rel, n, 'DOCS-LINK-003', `link ${href} targets #${frag}, which is no element id in ${want}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------- main

const format = (p) => `${p.file}${p.line ? `:${p.line}` : ''}: [${p.spec}] ${p.msg}`;

async function main(argv) {
  const dist = argv.includes('--dist');
  const rest = argv.filter((a) => a !== '--dist');
  const root = resolve(rest[0] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const problems = dist ? runDist(root) : await runSource(root);
  for (const p of problems) console.error(format(p));
  console.log(`docs-check${dist ? ' --dist' : ''}: ${problems.length} problems`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`docs-check: ${e.stack ?? e}`);
      process.exit(1);
    },
  );
}
