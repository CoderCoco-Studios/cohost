#!/usr/bin/env node
/**
 * Docs-site check (docs-site segment, DOCS-BUILD-001, DOCS-BUILD-005): a deterministic, read-only pass over the
 * documentation, run by `mise run docs:build` before and after `vitepress build`.
 *
 *   node scripts/docs-check.mjs [root]         source pass: frontmatter, sidebar, glossary links, facts checked against
 *                                              the repository, links to GitHub, wording, README and examples
 *   node scripts/docs-check.mjs --dist [root]  built-site pass over docs/.vitepress/dist: unpublished files, link anchors
 *
 * Prints one line per problem (`file[:line]: [SPEC-ID] message`) to stderr and exits 1; prints a summary and exits 0 when
 * there are none. `root` defaults to the repository root. Needs only Node and the workspace's own `yaml` package.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
// Flags of `mise run` and `mise watch` that take a value as the next word (so that word is no task name).
const MISE_RUN_VALUE_FLAGS = new Set(['-C', '--cd', '-j', '--jobs', '-o', '--output', '-t', '--tool', '-E', '--env', '-s', '--shell', '--timeout']);
const MISE_WATCH_VALUE_FLAGS = new Set(['-C', '--cd', '-w', '--watch', '-W', '--watch-file', '-e', '--exts', '-f', '--filter', '--delay', '--debounce', '--on-busy-update', '--signal', '--stop-signal', '--stop-timeout', '--poll', '--shell', '-E', '--env', '-j', '--jobs']);
// Flags of pnpm and cargo, before the subcommand, that take a value as the next word.
const PKG_VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir', '--workspace-dir', '--config', '-Z', '--color', '--manifest-path']);
const DEP_EDITS = new Set(['add', 'remove']);
// A word naming a path inside the repository: a program there runs through its `mise run` task (DOCS-GUIDE-005, DOCS-FACT-001).
const REPO_PATH = /^(?:\.\/)?(?:examples|scripts|packages|services|crates)(?:\/|$)/;
const NARRATION = /\b(previously|formerly|deprecated|legacy)\b/gi;
const ALLOW = '<!-- docs-check: allow -->';
// Build output and installed packages under examples/ (cargo's target/, node_modules/) are no example directory or README.
const EXAMPLES_SKIP = new Set(['node_modules', 'target']);
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
 * `fences` {lang, line, lines:[{n,text}]}, `snippets` {n, path, region} (VitePress code imports, DOCS-GUIDE-003: not in `plain`), `plain` the non-fence body lines {n,text}, `headings`, `prose` (code spans, link text,
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
  const snippets = [];
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
      fence = { ch: m[1][0], len: m[1].length, lang: m[2].split(/[{:[]/)[0].toLowerCase(), line: i + 1, lines: [], end: null };
      fences.push(fence);
    } else {
      const sn = /^ {0,3}<<< ([^#{\s]*)(?:#([^{\s]*))?/.exec(line);
      if (sn) snippets.push({ n: i + 1, path: sn[1], region: sn[2] ?? null });
      else plain.push({ n: i + 1, text: line });
    }
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
  return { all, first, fences, snippets, plain, headings, prose, spans, links };
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
    if (line.startsWith('## ')) break;
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
      const p = prefix ? `${prefix}.${k}` : k;
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

// ---------------------------------------------------------------------------------------------------- Extend pages

const EXTEND_DIR = 'advanced/extend/';
const EXTEND_REFERENCES = new Set(['index.md', 'hooks.md', 'connector-protocol.md']);
const FENCE_LANGS = new Set([...SHELL_LANGS, 'yaml', 'yml', 'env', 'dotenv', 'text', 'txt']);
const ALLOWED_COMMANDS = new Set(['mise', 'pnpm', 'node', 'python3', 'cargo', 'sh', 'cd', 'export']);
// First words that run code the reader keeps outside the checkout; one naming a path inside it fails DOCS-GUIDE-005.
const OUTSIDE_CODE_COMMANDS = new Set(['pnpm', 'node', 'python3', 'cargo', 'sh']);
const GUIDE_HEADINGS = ['What you need', 'How you know it worked', "If it didn't"];
const TESTED_HEADER = ['Task', 'Python', 'TypeScript', 'Rust', 'Any language with curl'];
const LANG_EXT = { Python: '.py', TypeScript: '.ts', Rust: '.rs', 'Any language with curl': '.sh' };
const NODE_22_18_FILES = new Set(['examples/modules/server.ts', 'examples/model-stub/stub.ts', 'examples/audio-in/send-clip.ts']);
const DASH = '—';
const FIXTURES_TREE = `${GH}/tree/main/packages/bus/fixtures/contract`;
/** The region-marker patterns of VitePress 1.6.4's code import (`findRegion` in its markdown-it snippet plugin). */
const REGION_RES = [
  /^\/\/ ?#?((?:end)?region) ([\w*-]+)$/,
  /^\/\* ?#((?:end)?region) ([\w*-]+) ?\*\/$/,
  /^#pragma ((?:end)?region) ([\w*-]+)$/,
  /^<!-- #?((?:end)?region) ([\w*-]+) -->$/,
  /^#((?:End )Region) ([\w*-]+)$/,
  /^::#((?:end)region) ([\w*-]+)$/,
  /^# ?((?:end)?region) ([\w*-]+)$/,
];

/** Splits a Markdown table row into trimmed cells; `|` inside a code span or after a backslash does not split. */
function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells = [];
  let cur = '';
  let tick = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      let k = i;
      while (t[k] === '`') k++;
      const run = k - i;
      cur += t.slice(i, k);
      tick = tick === 0 ? run : tick === run ? 0 : tick;
      i = k - 1;
    } else if (ch === '|' && tick === 0) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** The tables of a list of consecutive-numbered lines `{n, text}`: `{ header: cells, line, rows: [{ n, cells }] }`. */
function tablesOf(lines) {
  const out = [];
  let cur = null;
  let last = -2;
  for (const { n, text } of lines) {
    const isRow = text.trim().startsWith('|');
    if (isRow && n === last + 1 && cur) {
      const cells = splitRow(text);
      if (cur.rows.length === 0 && cells.every((c) => /^:?-+:?$/.test(c))) cur.sep = true;
      else if (cur.sep) cur.rows.push({ n, cells });
      else cur = null;
    } else if (isRow) {
      cur = { header: splitRow(text), line: n, rows: [], sep: false };
      out.push(cur);
    } else cur = null;
    last = n;
  }
  return out.filter((t) => t.sep);
}

/** The code span texts of a table cell. */
const cellSpans = (cell) => [...cell.matchAll(/(`+)([\s\S]*?[^`])\1(?!`)/g)].map((m) => m[2].trim());

/** Words of every command a command line holds, split as a POSIX shell splits them (quotes respected); `&&`, `||`, `|` and `;` separate commands. */
function shellCommands(text) {
  const commands = [];
  let words = [];
  let cur = '';
  let has = false;
  const endWord = () => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      cur += text.slice(i + 1, end);
      has = true;
      i = end;
    } else if (ch === '"') {
      has = true;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\' && '"\\$`'.includes(text[i + 1] ?? '')) i++;
        cur += text[i];
      }
    } else if (ch === '\\') {
      if (i + 1 < text.length) {
        cur += text[++i];
        has = true;
      }
    } else if (/\s/.test(ch)) endWord();
    else if (ch === '#' && !has) break;
    else if (ch === ';') endCommand();
    else if ((ch === '&' && text[i + 1] === '&') || (ch === '|' && text[i + 1] === '|')) {
      endCommand();
      i++;
    } else if (ch === '|') endCommand();
    else {
      cur += ch;
      has = true;
    }
  }
  endCommand();
  return commands;
}

/** The command lines of a shell fence with `\` continuations joined: `{ n, text }`; console fences keep only `$ ` lines and their continuations. */
function logicalLines(fence) {
  const out = [];
  let open = null;
  for (const { n, text } of fence.lines) {
    if (open) {
      open.text = `${open.text.replace(/\\\s*$/, ' ')}${text}`;
      if (!/\\\s*$/.test(text)) open = null;
      continue;
    }
    if (!text.trim()) continue;
    let body = text;
    if (fence.lang === 'console') {
      if (!text.startsWith('$ ')) continue;
      body = text.slice(2);
    } else if (text.trim().startsWith('#')) continue;
    const entry = { n, text: body };
    out.push(entry);
    if (/\\\s*$/.test(body)) open = entry;
  }
  return out;
}

const commandStart = (words) => {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  return i;
};

/** The first word of a command that names a path inside the repository (a `--flag=value` value counts), or null. */
const repoPathWord = (words) => {
  for (const w of words.slice(1)) {
    const cand = w.startsWith('-') && w.includes('=') ? w.slice(w.indexOf('=') + 1) : w;
    if (REPO_PATH.test(cand)) return cand;
  }
  return null;
};

/** The subcommand of a `pnpm` or `cargo` command (`words[0]` is the program): its first word that is no flag or flag value. */
const pkgSubcommand = (words) => {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (PKG_VALUE_FLAGS.has(w)) i++;
    else if (!w.startsWith('-') && !w.startsWith('+')) return w;
  }
  return undefined;
};

/** Whether a command is a dependency edit: `pnpm add`, `pnpm remove`, `cargo add` or `cargo remove`. */
const isDepEdit = (words) => (words[0] === 'pnpm' || words[0] === 'cargo') && DEP_EDITS.has(pkgSubcommand(words) ?? '');

/** The task names a `mise run` or `mise watch` command names (`:::` separates tasks; `words[0]` is `mise`), or null for another mise command. */
function miseTasks(words) {
  let i = 1;
  for (; i < words.length && words[i].startsWith('-'); i++) if (words[i] === '-C' || words[i] === '--cd') i++;
  const sub = words[i];
  if (sub !== 'run' && sub !== 'r' && sub !== 'watch' && sub !== 'w') return null;
  const watch = sub === 'watch' || sub === 'w';
  const valueFlags = watch ? MISE_WATCH_VALUE_FLAGS : MISE_RUN_VALUE_FLAGS;
  const tasks = [];
  let expect = true;
  for (i++; i < words.length; i++) {
    const w = words[i];
    if (w === ':::') expect = true;
    else if (w === '--') {
      if (watch) break;
      expect = false;
    } else if (watch && (w === '-t' || w === '--task')) {
      if (words[i + 1] !== undefined) tasks.push(words[++i]);
    } else if (watch && w.startsWith('--task=')) tasks.push(w.slice('--task='.length));
    else if (!expect) continue;
    else if (valueFlags.has(w)) i++;
    else if (w.startsWith('-')) continue;
    else {
      tasks.push(w);
      if (!watch) expect = false;
    }
  }
  return tasks;
}

/** The task names `mise.toml` defines (`[tasks.name]` and `[tasks."name:x"]` headers), or null when it does not exist. */
function miseTaskNames(root) {
  const text = readIf(join(root, 'mise.toml'));
  if (text === null) return null;
  const names = new Set();
  for (const m of text.matchAll(/^\s*\[tasks\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_:-]+))\]\s*(?:#.*)?$/gm)) names.add(m[1] ?? m[2] ?? m[3]);
  return names;
}

/** Whether a task name a page shows is defined: a `<placeholder>` part matches any text, so `dev:<service>` matches `dev:chat`. */
function taskDefined(tasks, name) {
  if (!name.includes('<')) return tasks.has(name);
  const re = new RegExp(`^${name.split(/<[^>]*>/).map(esc).join('.+')}$`);
  return [...tasks].some((t) => re.test(t));
}

/** The body of the `[name]` table of a TOML text, or null. */
function tomlSection(text, name) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\[${esc(name)}\\]\\s*(#.*)?$`).test(l.trim()));
  if (at === -1) return null;
  const out = [];
  for (let i = at + 1; i < lines.length && !/^\s*\[[A-Za-z]/.test(lines[i]); i++) out.push(lines[i]);
  return out.join('\n');
}

/** `package.name` of a Cargo.toml text, or null. */
function cargoPackageName(text) {
  const body = tomlSection(text, 'package');
  const m = body === null ? null : /^\s*name\s*=\s*"([^"]+)"/m.exec(body);
  return m ? m[1] : null;
}

/** `workspace.members` strings of a Cargo.toml text. */
function cargoMembers(text) {
  const body = tomlSection(text.replace(/#.*$/gm, ''), 'workspace');
  const m = body === null ? null : /members\s*=\s*\[([\s\S]*?)\]/.exec(body);
  return m ? [...m[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2]) : [];
}

/** Directories (repo-relative) a workspace member pattern names; a segment may hold `*`. */
function expandMember(root, base, pattern) {
  let dirs = [''];
  for (const seg of pattern.split('/').filter((x) => x && x !== '.')) {
    const next = [];
    for (const d of dirs) {
      if (/[*?]/.test(seg)) {
        const re = new RegExp(`^${seg.split('*').map((x) => x.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.')).join('[^/]*')}$`);
        const at = join(root, base, d);
        if (existsSync(at)) for (const e of readdirSync(at, { withFileTypes: true })) if (e.isDirectory() && re.test(e.name)) next.push(posix.join(d, e.name));
      } else next.push(posix.join(d, seg));
    }
    dirs = next;
  }
  return dirs.map((d) => posix.normalize(posix.join(base, d)));
}

/** Workspace Rust packages of the root and examples Cargo workspaces: `{ name, dir, example }`. */
function rustPackages(root) {
  const out = [];
  for (const [manifest, base, example] of [['Cargo.toml', '', false], ['examples/Cargo.toml', 'examples', true]]) {
    const text = readIf(join(root, manifest));
    if (text === null) continue;
    for (const member of cargoMembers(text)) {
      for (const dir of expandMember(root, base, member)) {
        const name = cargoPackageName(readIf(join(root, dir, 'Cargo.toml')) ?? '');
        if (name) out.push({ name, dir, example });
      }
    }
  }
  return out;
}

/** `# region`-style lookup: line indexes (0-based) opening and closing `region` in `text`. */
function regionMarks(text, region) {
  const opens = [];
  const closes = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    for (const re of REGION_RES) {
      const m = re.exec(line);
      if (!m || m[2] !== region) continue;
      if (/^[rR]egion$/.test(m[1])) opens.push(i);
      else if (/^[Ee]nd ?[rR]egion$/.test(m[1])) closes.push(i);
      else continue;
      break;
    }
  });
  return { opens, closes };
}

/** The Extension guides section's tables of the docs-site LLD: `{ guides, tested, layout }` (each a table or null). */
function lldExtensionTables(lldText) {
  const lines = lldText.split('\n');
  const start = lines.findIndex((l) => /^## Extension guides\s*$/.test(l));
  const section = [];
  if (start !== -1) {
    for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) section.push({ n: i + 1, text: lines[i] });
  }
  const tables = tablesOf(section);
  const is = (t, want) => want.every((w, i) => t.header[i] === w);
  return {
    guides: tables.find((t) => is(t, ['Page', 'Task', 'Examples'])) ?? null,
    tested: tables.find((t) => is(t, TESTED_HEADER) && t.header.length === 5) ?? null,
    layout: tables.find((t) => is(t, ['Directory', 'Holds'])) ?? null,
  };
}

/**
 * The Extend group's checks (Extension guides): snippet imports on every page, then the Extend pages' fences, commands,
 * paths, config fragments, tested examples, tables and statements, and the example directories' READMEs.
 * @spec DOCS-GUIDE-001, DOCS-GUIDE-002, DOCS-GUIDE-003, DOCS-GUIDE-004, DOCS-GUIDE-005, DOCS-GUIDE-006, DOCS-GUIDE-007, DOCS-GUIDE-008, DOCS-GUIDE-009,
 * DOCS-GUIDE-011, DOCS-GUIDE-012, DOCS-GUIDE-013, DOCS-GUIDE-014, DOCS-GUIDE-015, DOCS-GUIDE-016, DOCS-GUIDE-017, DOCS-GUIDE-018, DOCS-GUIDE-019,
 * DOCS-GUIDE-020, DOCS-GUIDE-021, DOCS-GUIDE-022, DOCS-GUIDE-023, DOCS-GUIDE-024, DOCS-EX-005
 */
function extendChecks(root, pages, lldText, add) {
  const isExtend = (p) => p.rel.startsWith(EXTEND_DIR);
  const extendPages = [...pages.values()].filter(isExtend);
  const stripExt = (target) => target.replace(/\.(md|html)$/, '').replace(/\/+$/, '');
  const plainText = (p) => p.a.plain.map((l) => l.text).join(' ');
  const says = (p, re) => re.test(plainText(p));

  // ---- snippet imports on every hand-written page (DOCS-GUIDE-001, DOCS-GUIDE-002)
  const rootReal = existsSync(root) ? realpathSync(root) : root;
  for (const p of pages.values()) {
    p.imports = [];
    for (const sn of p.a.snippets) {
      let file = null;
      if (sn.path.startsWith('@/')) {
        const rel = posix.normalize(`docs/${sn.path.slice(2)}`);
        if (!rel.startsWith('../') && rel !== '..' && !posix.isAbsolute(rel)) {
          const abs = join(root, rel);
          try {
            if (statSync(abs).isFile() && (realpathSync(abs) + sep).startsWith(rootReal + sep)) file = rel;
          } catch {
            file = null;
          }
        }
      }
      if (file === null) {
        add(p.file, sn.n, 'DOCS-GUIDE-001', `snippet import ${JSON.stringify(sn.path)} does not name an existing file inside the repository (it must start with @/, which stands for docs/)`);
        continue;
      }
      p.imports.push({ ...sn, file });
      if (sn.region !== null) {
        const { opens, closes } = regionMarks(readFileSync(join(root, file), 'utf8'), sn.region);
        if (opens.length !== 1 || closes.length !== 1 || closes[0] < opens[0]) add(p.file, sn.n, 'DOCS-GUIDE-002', `snippet import region "${sn.region}" is not opened exactly once and closed exactly once after it in ${file}`);
      }
    }
    p.importedFiles = new Set(p.imports.map((i) => i.file));
  }

  // ---- Extend pages' fences (DOCS-GUIDE-004 to DOCS-GUIDE-009)
  const packages = rustPackages(root);
  const packageNames = new Set(packages.map((x) => x.name));
  const cfgText = readIf(join(root, 'config/config.example.yaml'));
  let cfgPaths = null;
  let cfgProblem = null;
  if (cfgText === null) cfgProblem = 'config/config.example.yaml does not exist';
  else {
    try {
      cfgPaths = keyPaths(parseYaml(cfgText));
    } catch (e) {
      cfgProblem = `config/config.example.yaml does not parse: ${String(e.message).split('\n')[0]}`;
    }
  }
  const existsRel = (rel) => existsSync(join(root, posix.normalize(rel)));
  for (const p of extendPages) {
    for (const fence of p.a.fences) {
      if (!FENCE_LANGS.has(fence.lang)) {
        add(p.file, fence.line, 'DOCS-GUIDE-004', `fenced block has ${fence.lang ? `language "${fence.lang}"` : 'no language'}; program code reaches an Extend page only through snippet imports (allowed: sh, bash, shell, zsh, console, yaml, yml, env, dotenv, text, txt)`);
        continue;
      }
      if (SHELL_LANGS.has(fence.lang)) {
        for (const { n, text } of logicalLines(fence)) {
          for (const words of shellCommands(text)) {
            const at = commandStart(words);
            const first = words[at];
            if (first !== undefined && !ALLOWED_COMMANDS.has(first)) add(p.file, n, 'DOCS-GUIDE-005', `command starts with "${first}"; a shell fence runs only ${[...ALLOWED_COMMANDS].join(', ')}`);
            if (OUTSIDE_CODE_COMMANDS.has(first) && !isDepEdit(words.slice(at))) {
              const inRepo = repoPathWord(words.slice(at));
              if (inRepo !== null) add(p.file, n, 'DOCS-GUIDE-005', `command "${first}" names ${inRepo}, a path inside the repository; a program in the checkout runs through its mise run task, and ${first} is for code kept outside the checkout`);
            }
            for (const w of words) {
              const cand = w.startsWith('-') && w.includes('=') ? w.slice(w.indexOf('=') + 1) : w;
              if (cand.startsWith('examples/') || cand.startsWith('./examples/')) {
                const rel = cand.replace(/^\.\//, '').replace(/\/+$/, '');
                if (!existsRel(rel)) add(p.file, n, 'DOCS-GUIDE-006', `path ${cand} names no file or directory`);
              }
            }
            if (first === 'cargo') {
              for (let i = at + 1; i < words.length; i++) {
                const w = words[i];
                let name = null;
                if (w === '--') break;
                if (w === '-p' || w === '--package') name = words[++i];
                else if (w.startsWith('--package=')) name = w.slice('--package='.length);
                else if (w.startsWith('-p=')) name = w.slice(3);
                else if (/^-p[^-]/.test(w)) name = w.slice(2);
                if (name !== null && name !== undefined && !packageNames.has(name)) add(p.file, n, 'DOCS-GUIDE-007', `cargo names package "${name}", which is no workspace Rust package`);
              }
            }
          }
        }
      } else if (fence.lang === 'yaml' || fence.lang === 'yml') {
        let value;
        let err = null;
        try {
          value = parseYaml(fence.lines.map((l) => l.text).join('\n'));
        } catch (e) {
          err = `does not parse as YAML: ${String(e.message).split('\n')[0]}`;
        }
        if (err === null && !(value && typeof value === 'object' && !Array.isArray(value))) err = 'is not a YAML mapping';
        if (err !== null) add(p.file, fence.line, 'DOCS-GUIDE-009', `yaml fence ${err}`);
        else if (cfgPaths === null) add(p.file, fence.line, 'DOCS-GUIDE-009', cfgProblem);
        else for (const kp of keyPaths(value)) if (!cfgPaths.has(kp)) add(p.file, fence.line, 'DOCS-GUIDE-009', `key path ${kp} is not a key path of config/config.example.yaml`);
      }
    }
    for (const span of p.a.spans) {
      if (!/^(packages|services|crates|examples|config|scripts)\//.test(span) || /[<>*{\s]/.test(span)) continue;
      const rel = span.replace(/#.*$/, '').replace(/:\d+(?:-\d+)?$/, '').replace(/\/+$/, '');
      let ok = existsRel(rel);
      const cm = /^(config\/.+)\.([^./]+)$/.exec(rel);
      if (!ok && cm) ok = existsRel(`${cm[1]}.example.${cm[2]}`);
      if (!ok) add(p.file, p.a.plain.find((l) => l.text.includes(span))?.n ?? 0, 'DOCS-GUIDE-008', `code span ${span} names no file or directory`);
    }
  }

  // ---- tested examples (DOCS-GUIDE-011)
  const testTexts = [];
  for (const base of ['packages', 'services']) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const td = join(dir, e.name, 'test');
      if (!existsSync(td)) continue;
      for (const f of readdirSync(td, { withFileTypes: true })) if (f.isFile() && f.name.endsWith('.test.ts')) testTexts.push(readFileSync(join(td, f.name), 'utf8'));
    }
  }
  const named = (path) => testTexts.some((t) => new RegExp(`${esc(path)}(?=["'\`\\s]|$)`).test(t));
  const rustTested = (file) => {
    const pkg = packages.find((x) => x.example && (file === x.dir || file.startsWith(`${x.dir}/`)));
    if (!pkg || !walk(join(root, pkg.dir, 'tests')).some((f) => f.endsWith('.rs'))) return false;
    const re = new RegExp(`(?<![\\w-])${esc(pkg.name)}(?![\\w-])`);
    return testTexts.some((t) => re.test(t));
  };
  for (const p of pages.values()) {
    for (const file of p.importedFiles) {
      if (!file.startsWith('examples/')) continue;
      if (named(file) || named(posix.dirname(file)) || rustTested(file)) continue;
      add(p.file, 0, 'DOCS-GUIDE-011', `imports ${file}, which no test file (packages/*/test/*.test.ts, services/*/test/*.test.ts) names, as itself or by its directory, and which lies in no example Rust package whose tests a test runs`);
    }
  }

  // ---- the Extension guides table (DOCS-GUIDE-012)
  const lld = lldText === null ? { guides: null, tested: null, layout: null } : lldExtensionTables(lldText);
  if (lldText !== null) {
    if (!lld.guides) add(LLD_REL, 0, 'DOCS-GUIDE-012', "cannot find the Extension guides table (Page, Task, Examples, Verified by) in the LLD's Extension guides section");
    else {
      for (const row of lld.guides.rows) {
        const pageRel = /`([^`]+)`/.exec(row.cells[0] ?? '')?.[1]?.replace(/^\/+/, '');
        const target = pageRel ? pages.get(pageRel.replace(/^advanced\//, 'advanced/')) : null;
        if (!target) continue;
        for (const entry of cellSpans(row.cells[2] ?? '')) {
          const met = entry.endsWith('/') ? [...target.importedFiles].some((f) => f.startsWith(entry)) : target.importedFiles.has(entry);
          if (!met) add(target.file, 0, 'DOCS-GUIDE-012', `must import ${entry} (the Extension guides table lists it)`);
        }
      }
    }
  }

  // ---- Extend guides' headings (DOCS-GUIDE-013)
  for (const p of extendPages) {
    const name = p.rel.slice(EXTEND_DIR.length);
    if (EXTEND_REFERENCES.has(name)) continue;
    const h2 = p.a.headings.filter((h) => h.level === 2).map((h) => h.text.replace(/\s*\{#[^}]*\}\s*$/, '').replace(/[‘’]/g, "'").trim());
    for (const want of GUIDE_HEADINGS) if (!h2.includes(want)) add(p.file, 0, 'DOCS-GUIDE-013', `needs a "## ${want}" heading`);
  }

  // ---- the Ways to extend cohost page (DOCS-GUIDE-014 to DOCS-GUIDE-017)
  const byTitle = new Map(extendPages.map((p) => [p.fm.title, p]));
  /** The Extend page a link href of `fromRel` names, or null. */
  const extendTarget = (fromRel, href) => {
    const r = resolveDocLink(fromRel, href);
    if (!r) return null;
    const t = stripExt(r.target);
    return pages.get(`${t}.md`) && isExtend(pages.get(`${t}.md`)) ? pages.get(`${t}.md`) : pages.get(`${t}/index.md`) && isExtend(pages.get(`${t}/index.md`)) ? pages.get(`${t}/index.md`) : null;
  };
  const index = pages.get(`${EXTEND_DIR}index.md`);
  if (index) {
    const tables = tablesOf(index.a.plain).filter((t) => JSON.stringify(t.header) === JSON.stringify(TESTED_HEADER));
    if (tables.length !== 1) add(index.file, 0, 'DOCS-GUIDE-014', `must hold exactly one table whose header row is ${TESTED_HEADER.join(', ')}; found ${tables.length}`);
    else {
      const table = tables[0];
      const linkOf = (cell) => {
        const m = /^\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)$/.exec(cell);
        return m ? extendTarget(index.rel, m[1]) : null;
      };
      for (const row of table.rows) {
        TESTED_HEADER.slice(1).forEach((col, k) => {
          const cell = row.cells[k + 1] ?? '';
          const target = cell === DASH ? null : linkOf(cell);
          if (cell !== DASH && !target) add(index.file, row.n, 'DOCS-GUIDE-014', `cell "${row.cells[0]}" / ${col} is ${JSON.stringify(cell)}; it must be ${DASH} or exactly one link to an Extend page`);
          else if (target && !(target.imports ?? []).some((i) => i.file.endsWith(LANG_EXT[col]))) add(index.file, row.n, 'DOCS-GUIDE-015', `row "${row.cells[0]}", column ${col}: ${target.file} imports no example file ending ${LANG_EXT[col]}`);
        });
      }
      if (lld.tested) {
        const want = lld.tested.rows;
        const n = Math.max(want.length, table.rows.length);
        for (let i = 0; i < n; i++) {
          const w = want[i];
          const got = table.rows[i];
          if (!w) {
            add(index.file, got.n, 'DOCS-GUIDE-016', `row ${i + 1} ("${got.cells[0]}") is not a row of the LLD's Tested examples table`);
            continue;
          }
          if (!got) {
            add(index.file, table.line, 'DOCS-GUIDE-016', `row ${i + 1} ("${w.cells[0]}") of the LLD's Tested examples table is missing`);
            continue;
          }
          if (got.cells[0] !== w.cells[0]) add(index.file, got.n, 'DOCS-GUIDE-016', `row ${i + 1}: expected Task "${w.cells[0]}", found "${got.cells[0]}"`);
          TESTED_HEADER.slice(1).forEach((col, k) => {
            const lc = w.cells[k + 1] ?? '';
            const pc = got.cells[k + 1] ?? '';
            if (lc === DASH) {
              if (pc !== DASH) add(index.file, got.n, 'DOCS-GUIDE-016', `row "${w.cells[0]}", column ${col}: expected ${DASH}, found ${JSON.stringify(pc)}`);
              return;
            }
            const want2 = byTitle.get(lc);
            if (!want2) add(index.file, got.n, 'DOCS-GUIDE-016', `row "${w.cells[0]}", column ${col}: no Extend page has the title "${lc}"`);
            else if (linkOf(pc) !== want2) add(index.file, got.n, 'DOCS-GUIDE-016', `row "${w.cells[0]}", column ${col}: expected a link to "${lc}" (${want2.rel}), found ${JSON.stringify(pc)}`);
          });
        }
      } else if (lldText !== null) add(LLD_REL, 0, 'DOCS-GUIDE-016', "cannot find the Tested examples table (Task, Python, TypeScript, Rust, Any language with curl) in the LLD's Extension guides section");
    }
    const linked = new Set(index.a.links.map((l) => extendTarget(index.rel, l.href)?.rel).filter(Boolean));
    for (const p of extendPages) if (p !== index && !linked.has(p.rel)) add(index.file, 0, 'DOCS-GUIDE-017', `must link the Extend page ${p.rel.slice(EXTEND_DIR.length)}`);
    if (!says(index, /no\s+tested\s+example/i)) add(index.file, 0, 'DOCS-GUIDE-017', 'must say, with the words "no tested example", that a language other than Python, TypeScript and Rust has no tested example and uses the contracts and their curl scripts');
  }

  // ---- statements each guide makes (DOCS-GUIDE-018 to DOCS-GUIDE-024)
  for (const name of ['hook-server-python.md', 'hook-server-typescript.md', 'hook-server-rust.md']) {
    const p = pages.get(`${EXTEND_DIR}${name}`);
    if (!p) continue;
    if (!says(p, /no\s+heartbeat/i)) add(p.file, 0, 'DOCS-GUIDE-018', 'must say, with the words "no heartbeat", that a hook server sends no heartbeat of its own');
    if (!spanNames(p.a.spans, 'hook.<name>')) add(p.file, 0, 'DOCS-GUIDE-018', 'must contain the code span `hook.<name>`');
  }
  for (const p of extendPages) {
    if ([...p.importedFiles].some((f) => NODE_22_18_FILES.has(f)) && !p.text.includes('22.18')) add(p.file, 0, 'DOCS-GUIDE-019', `imports ${[...p.importedFiles].filter((f) => NODE_22_18_FILES.has(f)).join(', ')} and must state that it runs with node on Node 22.18 or later (the text 22.18)`);
  }
  const model = pages.get(`${EXTEND_DIR}model-server.md`);
  if (model) {
    for (const tok of ['/chat/completions', '/models', 'brain.memory.embedder']) if (!spanNames(model.a.spans, tok)) add(model.file, 0, 'DOCS-GUIDE-020', `must name the code span \`${tok}\``);
  }
  const rustBus = pages.get(`${EXTEND_DIR}rust-bus.md`);
  if (rustBus) {
    if (!says(rustBus, /no\s+shared\s+runtime/i)) add(rustBus.file, 0, 'DOCS-GUIDE-021', 'must say, with the words "no shared runtime", that crates/cohost-bus has no shared runtime');
    for (const tok of ['service.heartbeat', 'control', 'inject.request']) if (!spanNames(rustBus.a.spans, tok)) add(rustBus.file, 0, 'DOCS-GUIDE-021', `must name the code span \`${tok}\``);
  }
  const proto = pages.get(`${EXTEND_DIR}connector-protocol.md`);
  if (proto) {
    const constRel = 'packages/bus/fixtures/contract/constants.json';
    let constants = null;
    try {
      constants = JSON.parse(readIf(join(root, constRel)) ?? 'null');
    } catch (e) {
      add(constRel, 0, 'DOCS-GUIDE-022', `cannot parse: ${e.message}`);
    }
    if (constants === null || typeof constants !== 'object') add(constRel, 0, 'DOCS-GUIDE-022', 'cannot read the contract constants');
    else {
      const rows = tablesOf(proto.a.plain).flatMap((t) => t.rows).map((r) => r.cells.slice(0, 2).map((c) => /^`([^`]+)`$/.exec(c)?.[1]?.trim() ?? null));
      const expected = [];
      for (const [key, value] of Object.entries(constants)) {
        if (key === 'names') continue;
        if (value && typeof value === 'object' && !Array.isArray(value)) for (const [m, v] of Object.entries(value)) expected.push([`${key}.${m}`, JSON.stringify(v)]);
        else expected.push([key, JSON.stringify(value)]);
      }
      for (const [key, text] of expected) {
        if (!rows.some(([a, b]) => a === key && b === text)) add(proto.file, 0, 'DOCS-GUIDE-022', `needs a table row whose first cell is the code span \`${key}\` and whose second cell is exactly the code span \`${text}\``);
      }
      const names = constants.names ?? {};
      const shorten = (s, pairs) => pairs.reduce((acc, [value, tag]) => (typeof value === 'string' && value ? acc.replace(value, tag) : acc), String(s ?? ''));
      const connectorKey = shorten(names.connectorKey, [[names.prefix, '<prefix>'], [names.id, '<id>']]);
      const audioIn = shorten(names.audioStream, [[names.prefix, '<prefix>'], [names.tag, '<tag>']]);
      for (const form of [connectorKey, audioIn, audioIn.replace('.in.', '.out.')]) if (!proto.a.spans.includes(form)) add(proto.file, 0, 'DOCS-GUIDE-023', `must name the code span \`${form}\``);
    }
    if (!proto.a.links.some((l) => l.href.replace(/[#?].*$/, '').replace(/\/+$/, '') === FIXTURES_TREE)) add(proto.file, 0, 'DOCS-GUIDE-023', `must link the contract fixtures directory ${FIXTURES_TREE}`);
    if (!says(proto, /no\s+SDK/i)) add(proto.file, 0, 'DOCS-GUIDE-024', 'must say, with the words "no SDK", that there is no connector SDK outside TypeScript');
    if (!says(proto, /not\s+a\s+supported\s+route/i)) add(proto.file, 0, 'DOCS-GUIDE-024', 'must say, with the words "not a supported route", that a connector in another language is not a supported route');
    if (!spanNames(proto.a.spans, '@cohost/bus')) add(proto.file, 0, 'DOCS-GUIDE-024', 'must name `@cohost/bus` as a code span');
  }

  // ---- example directories (DOCS-EX-005)
  if (lldText !== null) {
    if (!lld.layout) add(LLD_REL, 0, 'DOCS-EX-005', "cannot find the Example layout table (Directory, Holds, Owning segment) in the LLD's Extension guides section");
    else {
      const siteRoute = (href) => {
        if (!href.startsWith(SITE)) return null;
        return href.slice(SITE.length).replace(/[#?].*$/, '').replace(/\.html$/, '').replace(/\/+$/, '').replace(/(^|\/)index$/, '');
      };
      for (const row of lld.layout.rows) {
        const dir = (/`([^`]+)`/.exec(row.cells[0] ?? '')?.[1] ?? '').replace(/\/+$/, '');
        if (!dir || dir === 'examples/modules') continue;
        const readmeRel = `${dir}/README.md`;
        const text = readIf(join(root, readmeRel));
        if (text === null) {
          add(readmeRel, 0, 'DOCS-EX-005', 'does not exist');
          continue;
        }
        const ra = analyze(text);
        for (const span of cellSpans(row.cells[1] ?? '')) {
          const base = posix.basename(span);
          if (!base.includes('.')) continue;
          if (!ra.spans.includes(base)) add(readmeRel, 0, 'DOCS-EX-005', `must name the file ${span} as the code span \`${base}\``);
        }
        const guides = lld.guides ? lld.guides.rows.filter((r) => cellSpans(r.cells[2] ?? '').some((e) => e.startsWith(`${dir}/`))) : [];
        const routes = guides.map((r) => (/`([^`]+)`/.exec(r.cells[0] ?? '')?.[1] ?? '').replace(/\.md$/, '').replace(/(^|\/)index$/, ''));
        const linkedRoutes = ra.links.map((l) => siteRoute(l.href)).filter((x) => x !== null);
        if (!routes.some((r) => linkedRoutes.includes(r))) add(readmeRel, 0, 'DOCS-EX-005', `must link, at its ${SITE} URL, an Extend page whose Extension guides row lists a path under ${dir}/ (${routes.map((r) => `${SITE}${r}`).join(' or ') || 'none lists one'})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------- source pass

/**
 * Runs the source pass over the repository at `root`; returns problems `{ file, line, spec, msg }`.
 * @spec DOCS-BUILD-005, DOCS-PUB-001, DOCS-PUB-002, DOCS-PUB-004, DOCS-IA-001, DOCS-IA-002, DOCS-IA-003, DOCS-IA-004, DOCS-IA-005, DOCS-IA-006, DOCS-IA-007, DOCS-IA-008, DOCS-IA-009,
 * DOCS-PAGE-001, DOCS-PAGE-002, DOCS-PAGE-003, DOCS-PAGE-004, DOCS-PAGE-005, DOCS-PAGE-006, DOCS-PAGE-007, DOCS-GLOSS-001, DOCS-GLOSS-002, DOCS-GLOSS-003, DOCS-GLOSS-004,
 * DOCS-LINK-002, DOCS-FACT-001, DOCS-FACT-002, DOCS-FACT-003, DOCS-FACT-004, DOCS-FACT-005, DOCS-FACT-006, DOCS-ARCH-004, DOCS-ARCH-009,
 * DOCS-README-001, DOCS-README-002, DOCS-README-003, DOCS-README-004, DOCS-EX-001, DOCS-EX-002, DOCS-EX-003, DOCS-EX-004, DOCS-EX-005, DOCS-PAGE-006
 * (the Extend group's DOCS-GUIDE-* rules are in extendChecks)
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
    if (a.fences.length || a.snippets.length) {
      const v = /^verified:[ \t]*["']?([^\s"'#]*)["']?[ \t]*(?:#.*)?$/m.exec(p.fmRaw);
      if (!v || !/^[0-9a-f]{7,40}$/.test(v[1])) add(file, 0, 'DOCS-PAGE-002', `has a fenced code block or snippet import, so frontmatter needs verified: <7 to 40 lowercase hex characters>; found ${v ? JSON.stringify(v[1]) : 'none'}`);
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
      [/no\s+event\s+validation/i, 'say a process on neither client gets "no event validation"'],
      [/no\s+dashboard\s+control/i, 'say a process on neither client gets "no dashboard control"'],
      [/no\s+health\s+reporting/i, 'say a process on neither client gets "no health reporting"'],
    ];
    for (const [re, what] of need) if (!re.test(t)) add(extend.file, 0, 'DOCS-PAGE-006', `must ${what}`);
    for (const want of ['typescript-service', 'rust-bus']) {
      if (!extend.a.links.some((l) => resolveDocLink(extend.rel, l.href)?.target.replace(/\.html$/, '') === `advanced/extend/${want}`)) add(extend.file, 0, 'DOCS-PAGE-006', `must link the ${want === 'rust-bus' ? 'Rust bus client' : 'Add a TypeScript service'} page (${want}.md)`);
    }
    for (const { n, raw } of extend.a.prose) {
      if (/\bpython\b/i.test(raw) && /\bsupported\b/i.test(raw) && !/\b(not|isn't|never|no|unsupported)\b/i.test(raw)) add(extend.file, n, 'DOCS-PAGE-006', 'presents a process on neither bus client (Python) as a supported way to extend cohost');
    }
  }

  extendChecks(root, pages, lldText, add);

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

  // ---- facts: task names and direct commands, env vars, ports, config keys, event types
  const tasks = miseTaskNames(root);
  let missingMise = false;
  const envPage = pages.get(ENV_PAGE);
  const envSpans = envPage?.a.spans ?? [];
  const factTargets = [...pages.values()];
  const readme = readIf(join(root, 'README.md'));
  if (readme !== null) factTargets.push({ rel: 'README.md', file: 'README.md', a: analyze(readme), text: readme, fm: {}, readme: true });
  for (const p of factTargets) {
    const onExtend = !p.readme && p.rel.startsWith(EXTEND_DIR);
    for (const fence of p.a.fences) {
      if (SHELL_LANGS.has(fence.lang)) {
        for (const { n, cmd } of commandLines(fence)) {
          const { names } = leadingAssignments(cmd);
          for (const name of names) if (/^[A-Z][A-Z0-9_]*$/.test(name) && !spanNames(envSpans, name)) add(p.file, n, 'DOCS-FACT-002', `names variable ${name}, which the Environment and ports page (${ENV_PAGE}) does not name`);
        }
        const firstLine = fence.lines.find((l) => l.text.trim());
        const lines = logicalLines(fence);
        if (!firstLine || !lines.some((l) => l.n === firstLine.n)) continue;
        for (const { n, text } of lines) {
          for (const all of shellCommands(text)) {
            const words = all.slice(commandStart(all));
            const shown = words.join(' ');
            if (words[0] === 'mise') {
              const named = miseTasks(words);
              if (named === null) continue;
              if (tasks === null) {
                missingMise = true;
                continue;
              }
              for (const t of named) if (!taskDefined(tasks, t)) add(p.file, n, 'DOCS-FACT-001', `command "${shown}" names the task ${t}, which mise.toml does not define`);
            } else if (words[0] === 'pnpm' || words[0] === 'cargo') {
              if (isDepEdit(words)) continue;
              if (onExtend && repoPathWord(words) === null) continue;
              add(p.file, n, 'DOCS-FACT-001', `command "${shown}" runs ${words[0]} directly; run its mise task (mise run <task>), or use ${words[0]} add / ${words[0]} remove for a dependency edit`);
            }
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
  if (missingMise) add('mise.toml', 0, 'DOCS-FACT-001', 'does not exist, so no task a page runs with mise run or mise watch is defined');
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
      for (let i = start + 1; i < lines.length && !lines[i].startsWith('}'); i++) {
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
  const exampleReadmes = walk(join(root, 'examples'), EXAMPLES_SKIP).filter((f) => posix.basename(f) === 'README.md').map((f) => `examples/${f}`);
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
          const count = cmds.slice(di + 1).length;
          if (count > 5) add('README.md', fence.line, 'DOCS-README-003', `has ${count} command lines after the cd; at most five (a heredoc counts as one)`);
        }
        const body = fence.lines.map((l) => l.text).join('\n');
        if (!/scripts\/install\.sh/.test(body)) add('README.md', fence.line, 'DOCS-README-003', 'the quick start must run scripts/install.sh');
        if (!/(^|\n)\s*mise run dashboard(?![\w:-])/.test(body)) add('README.md', fence.line, 'DOCS-README-003', 'the quick start must start the dashboard with mise run dashboard');
        if (/\.env\b/.test(body)) add('README.md', fence.line, 'DOCS-README-003', 'the quick start must write nothing to .env: mock mode is an isolated start from the dashboard');
        const sectionText = ra.plain.filter((l) => inSec(l.n)).map((l) => l.text).join('\n');
        if (!/\bisolated\b/i.test(sectionText)) add('README.md', fence.line, 'DOCS-README-003', 'the Quick start prose must reach mock mode by an isolated start from the dashboard');
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
  const exDirs = existsSync(exDir) ? readdirSync(exDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !EXAMPLES_SKIP.has(d.name)).map((d) => d.name).sort() : [];
  const modules = readIf(join(exDir, 'modules/README.md'));
  if (modules === null) add('examples/modules/README.md', 0, 'DOCS-EX-002', 'does not exist');
  else {
    const ma = analyze(modules);
    for (const name of ['server.py', 'server.ts', 'rust/', 'try.sh', 'try.expected.txt', 'fixtures/', 'schemas/']) if (!ma.spans.includes(name)) add('examples/modules/README.md', 0, 'DOCS-EX-002', `must name ${name} as a code span`);
    const cmds = ma.fences.filter((f) => SHELL_LANGS.has(f.lang)).flatMap((f) => logicalLines(f).flatMap((l) => shellCommands(l.text).map((w) => w.slice(commandStart(w)))));
    for (const [lang, what] of [['py', 'Python'], ['ts', 'TypeScript'], ['rust', 'Rust']]) {
      if (!cmds.some((w) => w[0] === 'mise' && w[1] === 'run' && w.includes(`example:hook-server:${lang}`))) add('examples/modules/README.md', 0, 'DOCS-EX-002', `must show how to run the ${what} server: mise run example:hook-server:${lang} in a shell fence`);
    }
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

  await themeSourceChecks(root, add, configText);
  liveHealthSourceChecks(root, add);

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
  const readmes = ['README.md', ...walk(join(root, 'examples'), EXAMPLES_SKIP).filter((f) => posix.basename(f) === 'README.md').map((f) => `examples/${f}`)];
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
  themeDistChecks(root, dist, files, htmlFiles, add);
  liveHealthDistChecks(dist, add);
  return problems;
}

// ---------------------------------------------------------------------------------------------------- theme checks

// CSS, colour and markup helpers for the DOCS-THEME-* checks. They read text only; nothing here needs a browser.

const THEME_DIR = 'docs/.vitepress/theme/';
const TOKENS_REL = `${THEME_DIR}tokens.css`;
const STYLE_REL = `${THEME_DIR}style.css`;
const MARK_REL = `${THEME_DIR}components/CohostMark.vue`;
const FAVICON_REL = 'docs/public/favicon.svg';
const LLD_REL = 'docs/intent/docs-site/docs-site-design.md';
const MASCOT = ['mascot-body', 'mascot-face', 'mascot-headset'];
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return HTML_ENTITIES[e.toLowerCase()] ?? m;
  });

/** Parses `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA` into {r,g,b,a} (0-255, a 0-1), or null. */
function parseHex(hex) {
  let h = /^#([0-9a-f]+)$/i.exec(hex.trim())?.[1];
  if (!h || ![3, 4, 6, 8].includes(h.length)) return null;
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}
const luminance = ({ r, g, b }) => {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** WCAG 2.x contrast ratio of two parsed colours, the foreground first composited over the background when it has alpha. */
function contrast(fg, bg) {
  const over = fg.a < 1 ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) } : fg;
  const a = luminance(over);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---- CSS

/**
 * A small CSS reader: returns a tree of blocks {prelude, line, decls:[{prop,value,important,line}], children, stmts}. Understands comments,
 * strings, parentheses (so a `data:` URL with `;` inside `url()` is safe), nested at-rules and CSS nesting. Top-level statements
 * such as `@import "x";` are kept in `stmts`.
 */
function parseCss(text) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  let i = 0;
  const skipSpace = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? text.length : end + 2;
      } else return;
    }
  };
  /** Reads up to the next `{`, `;` or `}` outside strings and parentheses; returns {text, end, pos}. */
  const readItem = () => {
    skipSpace();
    const pos = i;
    let out = '';
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? text.length : end + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
        out += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === '{' || c === ';' || c === '}')) return { text: out.trim(), end: c, pos };
      out += c;
      i++;
    }
    return { text: out.trim(), end: '', pos };
  };
  const parseBody = (node) => {
    for (;;) {
      const item = readItem();
      if (item.end === '{') {
        i++;
        const child = { prelude: item.text, line: lineAt(item.pos), decls: [], children: [], stmts: [], parent: node };
        parseBody(child);
        node.children.push(child);
      } else if (item.end === ';' || item.end === '' || item.end === '}') {
        if (item.text) {
          const colon = item.text.indexOf(':');
          if (item.text.startsWith('@') || colon === -1) node.stmts.push({ text: item.text, line: lineAt(item.pos) });
          else {
            const prop = item.text.slice(0, colon).trim().toLowerCase();
            let value = item.text.slice(colon + 1).trim();
            const important = /!\s*important\s*$/i.test(value);
            if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
            node.decls.push({ prop: prop.startsWith('--') ? item.text.slice(0, colon).trim() : prop, value, important, line: lineAt(item.pos) });
          }
        }
        if (item.end === '}') {
          i++;
          return;
        }
        if (item.end === ';') i++;
        if (item.end === '') return;
      }
    }
  };
  const root = { prelude: '', line: 1, decls: [], children: [], stmts: [], parent: null };
  parseBody(root);
  return root;
}

/** Every block of a parsed CSS tree with its chain of ancestor blocks (outermost first). */
function cssBlocks(root, out = [], anc = []) {
  for (const c of root.children) {
    out.push({ block: c, anc });
    cssBlocks(c, out, [...anc, c]);
  }
  return out;
}

const ws = (s) => s.replace(/\s+/g, ' ').trim();
/** A selector with whitespace collapsed and attribute-selector values single-quoted, so spellings compare equal. */
function normSel(sel) {
  return ws(sel)
    .replace(/\[\s*([^\]=~|^$*\s]+)\s*([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/g, (_m, a, op, d, s, u) => `[${a}${op}'${d ?? s ?? u}']`)
    .replace(/(?<!:):(before|after)\b/g, '::$1');
}
const splitTop = (s, sep) => {
  const parts = [];
  let depth = 0;
  let q = null;
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && c === sep) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
};
/** Expands `:is(a, b)` / `:where(a, b)` groups into plain selectors. */
function expandIs(sel) {
  const m = /:(?:is|where)\(/.exec(sel);
  if (!m) return [sel];
  let depth = 1;
  let k = m.index + m[0].length;
  while (k < sel.length && depth > 0) {
    if (sel[k] === '(') depth++;
    else if (sel[k] === ')') depth--;
    k++;
  }
  const inner = sel.slice(m.index + m[0].length, k - 1);
  return splitTop(inner, ',').flatMap((alt) => expandIs(sel.slice(0, m.index) + alt.trim() + sel.slice(k)));
}
/** The comma-separated parts of a rule's selector, expanded and normalised. */
const selectorsOf = (prelude) => splitTop(prelude, ',').flatMap((p) => expandIs(p.trim())).map(normSel).filter(Boolean);
/** The last compound of a normalised selector (the part after the final combinator). */
const lastCompound = (sel) => {
  let depth = 0;
  let q = null;
  let start = 0;
  for (let k = 0; k < sel.length; k++) {
    const c = sel[k];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) start = k + 1;
  }
  return sel.slice(start);
};
const hasClass = (compound, cls) => new RegExp(`\\.${esc(cls)}(?![\\w-])`).test(compound);
const isMedia = (b, re) => b.prelude.toLowerCase().startsWith('@media') && re.test(b.prelude);
const MIN_WIDTH = /\(\s*min-width\s*:/i;
const inMinWidth = (anc) => anc.some((b) => isMedia(b, MIN_WIDTH));

/** The theme CSS parsed and indexed: [{file, block, anc, sels, decl(prop)}]. */
function indexCss(files) {
  const out = [];
  for (const [file, text] of files) {
    if (text === null) continue;
    for (const { block, anc } of cssBlocks(parseCss(text))) {
      const sels = block.prelude.startsWith('@') ? [] : selectorsOf(block.prelude);
      out.push({ file, block, anc, sels, line: block.line, decl: (p) => [...block.decls].reverse().find((d) => d.prop === p) });
    }
  }
  return out;
}
const lastDecl = (rules, prop) => {
  let found = null;
  for (const r of rules) for (const d of r.block.decls) if (d.prop === prop) found = d;
  return found;
};
const norm = (v) => (v === undefined || v === null ? '' : ws(v.replace(/!\s*important\s*$/i, '')).toLowerCase());
const BORDER_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);
/** Resolves a `border-<side>` or `outline` shorthand and its longhands from the rules into {width, style, color}. */
function resolveLine(rules, prefix) {
  const res = { width: null, style: null, color: null };
  const shorthand = lastDecl(rules, prefix);
  if (shorthand) {
    for (const t of splitTop(ws(shorthand.value), ' ')) {
      if (/^[\d.]/.test(t) || ['thin', 'medium', 'thick'].includes(t)) res.width = t.toLowerCase();
      else if (BORDER_STYLES.has(t.toLowerCase())) res.style = t.toLowerCase();
      else if (t) res.color = t;
    }
  }
  for (const k of ['width', 'style', 'color']) {
    const d = lastDecl(rules, `${prefix}-${k}`);
    if (d) res[k] = norm(d.value);
  }
  return res;
}
/** A CSS length as px, or null when it is not a plain px, rem or em length. */
function lengthPx(v) {
  const m = /^(-?\d*\.?\d+)\s*(px|rem|em)$/i.exec(norm(v));
  if (!m) return null;
  return parseFloat(m[1]) * (m[2].toLowerCase() === 'px' ? 1 : 16);
}
/** A CSS time as ms, or null. */
function timeMs(v) {
  const m = /^(-?\d*\.?\d+)\s*(ms|s)$/i.exec(norm(v));
  if (!m) return null;
  return parseFloat(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1);
}

// ---- markup (Vue templates, built HTML, SVG)

const TAG_RE = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[^\s=>/"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Tag events of a markup string: {close, name, attrs, index, end, selfClosing}. Script bodies are blanked first. */
function tagEvents(src) {
  const masked = src.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, a, b, c) => a + ' '.repeat(b.length) + c);
  const events = [];
  for (const m of masked.matchAll(TAG_RE)) {
    if (m[0].startsWith('<!--')) continue;
    const index = m.index;
    const end = index + m[0].length;
    if (m[1]) {
      events.push({ close: true, name: m[1].toLowerCase(), raw: m[1], attrs: {}, index, end, selfClosing: false });
      continue;
    }
    const attrs = {};
    for (const a of (m[3] ?? '').matchAll(ATTR_RE)) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    const name = m[2].toLowerCase();
    events.push({ close: false, name, raw: m[2], attrs, index, end, selfClosing: m[4] === '/' || VOID.has(name) });
  }
  return events;
}
const classTokens = (e) => (e.attrs.class ?? '').split(/\s+/).filter(Boolean);
const hasTok = (e, t) => classTokens(e).includes(t);
/** The region of the first element satisfying `pred` among `events`: {open, start, innerStart, innerEnd, end}. */
function regionOf(events, pred, from = 0) {
  for (let i = from; i < events.length; i++) {
    const o = events[i];
    if (o.close || !pred(o)) continue;
    if (o.selfClosing) return { open: o, idx: i, start: o.index, innerStart: o.end, innerEnd: o.end, end: o.end };
    let depth = 1;
    for (let j = i + 1; j < events.length; j++) {
      const e = events[j];
      if (e.name !== o.name || e.selfClosing) continue;
      depth += e.close ? -1 : 1;
      if (depth === 0) return { open: o, idx: i, start: o.index, innerStart: o.end, innerEnd: e.index, end: e.end };
    }
    return { open: o, idx: i, start: o.index, innerStart: o.end, innerEnd: events.at(-1).end, end: events.at(-1).end };
  }
  return null;
}
const regionsOf = (events, pred) => {
  const out = [];
  let from = 0;
  for (;;) {
    const r = regionOf(events, pred, from);
    if (!r) return out;
    out.push(r);
    from = r.idx + 1;
  }
};
const inside = (e, r) => r && e.index >= r.start && e.index < r.end;
const textOf = (html) => decodeEntities(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ''));

/** A Vue template as a tree of elements {name, attrs, children}; text is dropped. */
function vueTree(template) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const e of tagEvents(template)) {
    if (e.close) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === e.name) {
          stack.length = k;
          break;
        }
      }
    } else {
      const el = { name: e.name, attrs: e.attrs, children: [] };
      stack.at(-1).children.push(el);
      if (!e.selfClosing) stack.push(el);
    }
  }
  return root;
}
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const MARK_FORBIDDEN = new Set(['text', 'image', 'use', 'style', 'lineargradient', 'radialgradient', 'filter', 'mask']);
const EXPRESSIONS = ['idle', 'talking', 'lost'];

/** Evaluates a v-if condition of `expression === 'x'` atoms for one expression; an atom it cannot read counts as true. */
function evalCond(cond, expr) {
  const atoms = cond.replace(/(?:props\.)?\bexpression\s*(===|==|!==|!=)\s*(['"])(\w+)\2/g, (_m, op, _q, v) => String(op.startsWith('!') ? v !== expr : v === expr));
  if (!/^[\s!()&|truefals]*$/.test(atoms)) return true;
  try {
    // oxlint-disable-next-line typescript/no-implied-eval -- `atoms` is checked above to hold only true, false, !, &&, || and parentheses
    return Boolean(new Function(`return (${atoms});`)());
  } catch {
    return true;
  }
}
/** The shape elements one expression renders, counting v-if/v-else chains and numeric v-for. */
function shapesFor(children, expr, mult = 1) {
  let count = 0;
  let taken = false;
  for (const el of children) {
    let include = true;
    if ('v-if' in el.attrs) {
      include = evalCond(el.attrs['v-if'], expr);
      taken = include;
    } else if ('v-else-if' in el.attrs) {
      include = !taken && evalCond(el.attrs['v-else-if'], expr);
      taken ||= include;
    } else if ('v-else' in el.attrs) {
      include = !taken;
      taken = true;
    } else taken = false;
    if (!include) continue;
    let m = mult;
    const vf = el.attrs['v-for'];
    if (vf !== undefined) {
      const num = /\b(?:in|of)\s+(\d+)\s*$/.exec(vf);
      const arr = /\b(?:in|of)\s+\[([^\]]*)\]\s*$/.exec(vf);
      if (num) m *= parseInt(num[1], 10);
      else if (arr) m *= arr[1].trim() ? splitTop(arr[1], ',').length : 0;
    }
    if (SHAPES.has(el.name)) count += m;
    count += shapesFor(el.children, expr, m);
  }
  return count;
}
function vueWalk(el, fn) {
  for (const c of el.children) {
    fn(c);
    vueWalk(c, fn);
  }
}

// ---- LLD tables

/** The Palette table [{token, light, dark}] and the Contrast pairs table [{fg, bgs, min}] of the docs-site LLD. */
function lldTables(text) {
  const palette = [];
  const pairs = [];
  let mode = null;
  for (const line of text.split('\n')) {
    if (/^\|\s*Token\s*\|\s*Light\s*\|\s*Dark\s*\|/i.test(line)) mode = 'palette';
    else if (/^\|\s*Foreground\s*\|\s*Backgrounds\s*\|\s*Minimum\s*\|/i.test(line)) mode = 'pairs';
    else if (!line.startsWith('|')) mode = null;
    else if (mode === 'palette') {
      const m = /^\|\s*`([^`]+)`\s*\|\s*`(#[0-9a-fA-F]{6})`\s*\|\s*`(#[0-9a-fA-F]{6})`/.exec(line);
      if (m) palette.push({ token: m[1], light: m[2], dark: m[3] });
    } else if (mode === 'pairs') {
      const m = /^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*([\d.]+)\s*\|/.exec(line);
      if (m) pairs.push({ fg: m[1], bgs: [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]), min: parseFloat(m[3]) });
    }
  }
  return { palette, pairs };
}

/** Finds an installed Shiki theme module and returns its theme object, or null. */
async function loadShikiTheme(name, roots) {
  const dirs = [];
  for (const r of roots) {
    for (const base of [join(r, 'node_modules')]) {
      try {
        const vp = realpathSync(join(base, 'vitepress'));
        const shiki = realpathSync(join(vp, '..', 'shiki'));
        dirs.push(join(shiki, '..', '@shikijs', 'themes', 'dist'));
      } catch {
        // not installed here
      }
      dirs.push(join(base, '@shikijs', 'themes', 'dist'));
    }
  }
  for (const d of dirs) {
    const f = join(d, `${name}.mjs`);
    if (/^[\w.-]+$/.test(name) && existsSync(f)) return (await import(pathToFileURL(f).href)).default;
  }
  return null;
}

/** The balanced `{...}` object literal enclosing text index `at`, or null. */
function enclosingObject(text, at) {
  let depth = 0;
  let start = -1;
  for (let k = at; k >= 0; k--) {
    if (text[k] === '}') depth++;
    else if (text[k] === '{') {
      if (depth === 0) {
        start = k;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;
  depth = 0;
  for (let k = start; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}' && --depth === 0) return text.slice(start + 1, k);
  }
  return null;
}
const unquote = (v) => {
  const t = v.trim();
  const m = /^(['"`])(.*)\1$/s.exec(t);
  return m ? `'${m[2]}'` : t;
};

// ---------------------------------------------------------------------------------------------------- theme: source pass

/**
 * The source-pass theme checks.
 * @spec DOCS-THEME-001, DOCS-THEME-002, DOCS-THEME-003, DOCS-THEME-004, DOCS-THEME-005, DOCS-THEME-006, DOCS-THEME-007,
 * DOCS-THEME-008, DOCS-THEME-009, DOCS-THEME-011, DOCS-THEME-012, DOCS-THEME-013, DOCS-THEME-014, DOCS-THEME-017,
 * DOCS-THEME-021, DOCS-THEME-022, DOCS-THEME-023, DOCS-THEME-024, DOCS-THEME-028, DOCS-THEME-031, DOCS-THEME-032,
 * DOCS-THEME-034, DOCS-THEME-036, DOCS-THEME-037, DOCS-THEME-040, DOCS-THEME-041, DOCS-THEME-042, DOCS-THEME-043,
 * DOCS-THEME-044, DOCS-THEME-045, DOCS-THEME-046, DOCS-THEME-047, DOCS-THEME-048, DOCS-THEME-050, DOCS-THEME-052,
 * DOCS-THEME-053, DOCS-THEME-054, DOCS-THEME-055
 */
async function themeSourceChecks(root, add, configText) {
  const configRel = 'docs/.vitepress/config.ts';

  // ---- the theme entry
  const entry = readIf(join(root, `${THEME_DIR}index.ts`));
  if (entry === null) add(`${THEME_DIR}index.ts`, 0, 'DOCS-THEME-001', 'does not exist; the theme entry is docs/.vitepress/theme/index.ts');
  else {
    if (!/['"]vitepress\/theme['"]/.test(entry)) add(`${THEME_DIR}index.ts`, 0, 'DOCS-THEME-001', "must import VitePress's default theme from 'vitepress/theme'");
    else if (!/\bextends\b/.test(entry)) add(`${THEME_DIR}index.ts`, 0, 'DOCS-THEME-001', 'must extend the default theme (`extends: DefaultTheme`)');
  }

  // ---- the palette and the contrast pairs (the LLD tables)
  const lldText = readIf(join(root, LLD_REL));
  const { palette, pairs } = lldText === null ? { palette: [], pairs: [] } : lldTables(lldText);
  if (!palette.length) add(LLD_REL, 0, 'DOCS-THEME-003', 'has no Palette table (| Token | Light | Dark |) to compare tokens.css against');
  if (!pairs.length) add(LLD_REL, 0, 'DOCS-THEME-004', 'has no Contrast pairs table (| Foreground | Backgrounds | Minimum |)');

  // ---- tokens.css
  const tokensText = readIf(join(root, TOKENS_REL));
  const modes = { ':root': new Map(), '.dark': new Map() };
  let tokensOk = false;
  if (tokensText === null) add(TOKENS_REL, 0, 'DOCS-THEME-002', 'does not exist');
  else {
    tokensOk = true;
    const tree = parseCss(tokensText);
    for (const s of tree.stmts) add(TOKENS_REL, s.line, 'DOCS-THEME-002', `holds the statement "${s.text}"; the file holds only the :root and .dark blocks`);
    const seen = new Set();
    for (const b of tree.children) {
      const sel = ws(b.prelude);
      if (sel !== ':root' && sel !== '.dark') {
        add(TOKENS_REL, b.line, 'DOCS-THEME-002', `holds the rule "${sel}"; the file holds only the :root and .dark blocks`);
        continue;
      }
      if (seen.has(sel)) add(TOKENS_REL, b.line, 'DOCS-THEME-002', `declares the ${sel} block more than once`);
      seen.add(sel);
      for (const c of b.children) add(TOKENS_REL, c.line, 'DOCS-THEME-002', `nests the rule "${ws(c.prelude)}" in ${sel}`);
      for (const d of b.decls) {
        const m = /^--cohost-([a-z0-9-]+)$/.exec(d.prop);
        if (!m) {
          add(TOKENS_REL, d.line, 'DOCS-THEME-002', `${sel} declares ${d.prop}, which is not a --cohost-<token> custom property`);
          continue;
        }
        if (!HEX6.test(d.value) || d.important) add(TOKENS_REL, d.line, 'DOCS-THEME-002', `--cohost-${m[1]} in ${sel} is "${d.value}${d.important ? ' !important' : ''}", not a six-digit hex literal (#RRGGBB)`);
        modes[sel].set(m[1], d.value);
      }
    }
    for (const sel of [':root', '.dark']) if (!seen.has(sel)) add(TOKENS_REL, 0, 'DOCS-THEME-002', `has no ${sel} block`);
    for (const [sel, other] of [[':root', '.dark'], ['.dark', ':root']]) {
      for (const t of modes[sel].keys()) if (!modes[other].has(t)) add(TOKENS_REL, 0, 'DOCS-THEME-002', `--cohost-${t} is declared in ${sel} but not in ${other}`);
    }
  }
  const light = modes[':root'];
  const dark = modes['.dark'];

  if (tokensOk && palette.length) {
    const names = new Set(palette.map((p) => p.token));
    for (const p of palette) {
      for (const [sel, key] of [[':root', 'light'], ['.dark', 'dark']]) {
        const got = modes[sel].get(p.token);
        if (got === undefined) add(TOKENS_REL, 0, 'DOCS-THEME-003', `--cohost-${p.token} is missing from ${sel}; the Palette table says ${p[key]}`);
        else if (got.toLowerCase() !== p[key].toLowerCase()) add(TOKENS_REL, 0, 'DOCS-THEME-003', `--cohost-${p.token} in ${sel} is ${got}; the Palette table says ${p[key]}`);
      }
    }
    for (const t of new Set([...light.keys(), ...dark.keys()])) if (!names.has(t)) add(TOKENS_REL, 0, 'DOCS-THEME-003', `--cohost-${t} is not a token of the Palette table`);
  }

  // ---- contrast pairs
  if (tokensOk) {
    for (const { fg, bgs, min } of pairs) {
      for (const bg of bgs) {
        for (const { mode, map } of [{ mode: 'light', map: light }, { mode: 'dark', map: dark }]) {
          const a = map.get(fg) && parseHex(map.get(fg));
          const b = map.get(bg) && parseHex(map.get(bg));
          if (!a || !b) {
            add(TOKENS_REL, 0, 'DOCS-THEME-004', `cannot compute ${fg} on ${bg} (${mode}): ${!a ? fg : bg} has no hex value in the ${mode} block`);
            continue;
          }
          const ratio = contrast(a, b);
          if (ratio < min) add(TOKENS_REL, 0, 'DOCS-THEME-004', `${fg} on ${bg} (${mode}) has contrast ${ratio.toFixed(2)}; the minimum is ${min}`);
        }
      }
    }
  }

  // ---- style.css
  const styleText = readIf(join(root, STYLE_REL));
  if (styleText === null) add(STYLE_REL, 0, 'DOCS-THEME-005', 'does not exist');
  const css = indexCss([[TOKENS_REL, tokensText], [STYLE_REL, styleText]]);
  const styleCss = css.filter((r) => r.file === STYLE_REL);
  if (styleText !== null) {
    const tokenNames = new Set(palette.length ? palette.map((p) => p.token) : [...light.keys()]);
    const roots = styleCss.filter((r) => r.anc.length === 0 && r.sels.length === 1 && r.sels[0] === ':root');
    const VP = ['--vp-c-bg', '--vp-c-bg-alt', '--vp-c-bg-soft', '--vp-c-text-1', '--vp-c-text-2', '--vp-c-text-3', '--vp-c-brand-1', '--vp-c-brand-2', '--vp-c-brand-3', '--vp-button-brand-bg', '--vp-button-brand-hover-bg', '--vp-button-brand-text', '--vp-button-brand-hover-text', '--vp-code-block-bg', '--vp-code-bg', '--vp-code-color'];
    for (const t of ['tip', 'info', 'warning', 'danger', 'details']) VP.push(`--vp-custom-block-${t}-bg`, `--vp-custom-block-${t}-text`);
    for (const v of VP) {
      const d = lastDecl(roots, v);
      const m = d && !d.important ? /^var\(--cohost-([a-z0-9-]+)\)$/.exec(d.value.trim()) : null;
      if (!d) add(STYLE_REL, 0, 'DOCS-THEME-005', `does not set ${v} in a top-level :root rule`);
      else if (!m || !tokenNames.has(m[1])) add(STYLE_REL, d.line, 'DOCS-THEME-005', `sets ${v} to "${d.value}${d.important ? ' !important' : ''}"; it must be exactly var(--cohost-<token>) with a Palette token`);
    }
  }

  // ---- config: markdown.theme, appearance, head
  const shikiNames = { light: null, dark: null };
  if (configText !== null) {
    const obj = /\btheme\s*:\s*\{([^}]*)\}/.exec(configText);
    const str = /\btheme\s*:\s*(['"])([\w.-]+)\1/.exec(configText);
    if (obj) {
      shikiNames.light = /\blight\s*:\s*(['"])([\w.-]+)\1/.exec(obj[1])?.[2] ?? null;
      shikiNames.dark = /\bdark\s*:\s*(['"])([\w.-]+)\1/.exec(obj[1])?.[2] ?? null;
    } else if (str) shikiNames.light = shikiNames.dark = str[2];
    if (shikiNames.light !== 'github-light-high-contrast' || shikiNames.dark !== 'github-dark-default') {
      add(configRel, 0, 'DOCS-THEME-006', `markdown.theme must be { light: 'github-light-high-contrast', dark: 'github-dark-default' }, found light ${shikiNames.light ?? '(unset)'}, dark ${shikiNames.dark ?? '(unset)'}`);
    }
    const ap = /\bappearance\s*:\s*([^,\n}]+)/.exec(configText);
    if (ap && ap[1].trim() !== 'true') add(configRel, 0, 'DOCS-THEME-009', `appearance must be unset or true, found ${ap[1].trim()}`);
    const hm = /\bhead\s*:\s*\[/.exec(configText);
    if (hm) {
      let depth = 0;
      let k = hm.index + hm[0].length - 1;
      const start = k;
      for (; k < configText.length; k++) {
        if (configText[k] === '[') depth++;
        else if (configText[k] === ']' && --depth === 0) break;
      }
      if (/\[\s*(['"`])script\1/i.test(configText.slice(start, k + 1))) {
        add(configRel, 0, 'DOCS-THEME-011', "head holds a script element; the site adds no analytics or tracking code");
      }
    }
  }

  // ---- Shiki themes against code-bg
  if (tokensOk && configText !== null) {
    const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    for (const { mode, map } of [{ mode: 'light', map: light }, { mode: 'dark', map: dark }]) {
      const name = shikiNames[mode];
      const bgHex = map.get('code-bg');
      const bg = bgHex && parseHex(bgHex);
      if (!name || !bg) continue;
      const theme = await loadShikiTheme(name, [root, here]);
      if (!theme) {
        add(configRel, 0, 'DOCS-THEME-007', `cannot find the installed Shiki theme ${name} to check against code-bg (${mode}); run mise run install`);
        continue;
      }
      const colours = new Map();
      const note = (c, where) => {
        if (typeof c !== 'string') return;
        const key = c.toLowerCase();
        if (!colours.has(key)) colours.set(key, where);
      };
      note(theme.colors?.['editor.foreground'] ?? theme.fg, 'the editor foreground');
      for (const t of theme.tokenColors ?? []) {
        if (t.settings?.background) continue;
        note(t.settings?.foreground, `token ${Array.isArray(t.scope) ? t.scope[0] : (t.scope ?? 'default')}`);
      }
      for (const [c, where] of colours) {
        const fg = parseHex(c);
        if (!fg) continue;
        const ratio = contrast(fg, bg);
        if (ratio < 4.5) add(configRel, 0, 'DOCS-THEME-007', `Shiki theme ${name}: colour ${c} (${where}) has contrast ${ratio.toFixed(2)} against code-bg (${mode}); the minimum is 4.5`);
      }
    }
  }

  // ---- @font-face and font packages
  for (const r of css) if (r.block.prelude.toLowerCase().startsWith('@font-face')) add(r.file, r.line, 'DOCS-THEME-008', 'declares @font-face; the only web font is the Inter that VitePress bundles');
  const pkgText = readIf(join(root, 'package.json'));
  let pkg = null;
  try {
    pkg = pkgText === null ? null : JSON.parse(pkgText);
  } catch {
    add('package.json', 0, 'DOCS-THEME-032', 'is not valid JSON');
  }
  if (pkg) {
    for (const field of ['dependencies', 'devDependencies']) {
      for (const n of Object.keys(pkg[field] ?? {})) if (n.startsWith('@fontsource') || n.includes('font')) add('package.json', 0, 'DOCS-THEME-055', `${field} lists the font package ${n}; the site uses only the Inter that VitePress bundles`);
    }
    const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    for (const field of FIELDS) for (const n of ['mermaid', 'vitepress-plugin-mermaid']) if (n in (pkg[field] ?? {})) add('package.json', 0, 'DOCS-THEME-052', `${field} lists ${n}; no Mermaid code runs in the reader's browser`);
    const bm = pkg.devDependencies?.['beautiful-mermaid'];
    if (bm === undefined) add('package.json', 0, 'DOCS-THEME-032', 'devDependencies must list beautiful-mermaid');
    else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(bm)) add('package.json', 0, 'DOCS-THEME-032', `beautiful-mermaid is "${bm}"; it must be an exact version (no range operator)`);
    for (const field of FIELDS.filter((f) => f !== 'devDependencies')) if ('beautiful-mermaid' in (pkg[field] ?? {})) add('package.json', 0, 'DOCS-THEME-032', `${field} lists beautiful-mermaid; it belongs in devDependencies only`);
  }

  // ---- the mark component
  const vue = readIf(join(root, MARK_REL));
  if (vue === null) add(MARK_REL, 0, 'DOCS-THEME-012', 'does not exist');
  else {
    const t0 = vue.indexOf('<template');
    const tEnd = vue.lastIndexOf('</template>');
    const template = t0 === -1 || tEnd === -1 ? '' : vue.slice(vue.indexOf('>', t0) + 1, tEnd);
    const script = (/<script\b[^>]*>([\s\S]*?)<\/script>/.exec(vue) ?? [])[1] ?? '';
    const tree = vueTree(template);
    let svg = null;
    vueWalk(tree, (el) => {
      if (!svg && el.name === 'svg') svg = el;
    });
    if (!svg) add(MARK_REL, 0, 'DOCS-THEME-012', 'its template has no <svg>');
    else {
      if (!(svg.attrs.class ?? '').split(/\s+/).includes('cohost-mark')) add(MARK_REL, 0, 'DOCS-THEME-012', 'the <svg> must carry class="cohost-mark"');
      if (ws(svg.attrs.viewBox ?? '') !== '0 0 64 64') add(MARK_REL, 0, 'DOCS-THEME-012', `the <svg> viewBox is "${svg.attrs.viewBox ?? ''}"; it must be "0 0 64 64"`);
      for (const e of EXPRESSIONS) {
        const n = shapesFor([svg], e);
        if (n > 12) add(MARK_REL, 0, 'DOCS-THEME-012', `renders ${n} shape elements for the ${e} expression; at most 12`);
      }
      const bound = svg.attrs[':data-expression'] ?? svg.attrs['v-bind:data-expression'];
      if (!bound || !/^(?:props\.)?expression$/.test(bound.trim())) add(MARK_REL, 0, 'DOCS-THEME-014', 'the <svg> must bind data-expression to the expression prop (:data-expression="expression")');
    }
    vueWalk(tree, (el) => {
      if (MARK_FORBIDDEN.has(el.name)) add(MARK_REL, 0, 'DOCS-THEME-012', `uses the <${el.name}> element, which the mark may not use`);
      for (const [k, v] of Object.entries(el.attrs)) {
        const name = k.replace(/^(?:v-bind)?:/, '');
        if (name === 'fill' || name === 'stroke') {
          const value = k !== name ? v.trim().replace(/^(['"`])(.*)\1$/, '$2') : v.trim();
          if (value !== 'none' && !/^var\(--cohost-mascot-(?:body|face|headset)\)$/.test(value)) add(MARK_REL, 0, 'DOCS-THEME-013', `${name}="${v}" on <${el.name}> is not none or a var(--cohost-mascot-*) reference`);
        } else if (name === 'style') {
          for (const m of v.matchAll(/(?:^|;)\s*(fill|stroke)\s*:\s*([^;]+)/g)) {
            const value = m[2].trim();
            if (value !== 'none' && !/^var\(--cohost-mascot-(?:body|face|headset)\)$/.test(value)) add(MARK_REL, 0, 'DOCS-THEME-013', `${m[1]}: ${value} in a style attribute on <${el.name}> is not none or a var(--cohost-mascot-*) reference`);
          }
        }
      }
    });
    for (const e of EXPRESSIONS) if (!new RegExp(`(['"])${e}\\1`).test(script)) add(MARK_REL, 0, 'DOCS-THEME-014', `the expression prop does not name the value '${e}'`);
    if (!/\bexpression\s*:\s*(['"])idle\1/.test(script) && !/\bdefault\s*:\s*(['"])idle\1/.test(script)) add(MARK_REL, 0, 'DOCS-THEME-014', "the expression prop must default to 'idle'");
  }

  // ---- the favicon
  const fav = readIf(join(root, FAVICON_REL));
  if (fav === null) add(FAVICON_REL, 0, 'DOCS-THEME-017', 'does not exist');
  else {
    const rootTag = /<svg\b[^>]*>/i.exec(fav)?.[0] ?? '';
    const vb = /\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rootTag);
    if (!vb || ws(vb[1] ?? vb[2]) !== '0 0 64 64') add(FAVICON_REL, 0, 'DOCS-THEME-017', `viewBox is "${vb ? (vb[1] ?? vb[2]) : ''}"; it must be "0 0 64 64"`);
    const allowed = new Map();
    for (const t of MASCOT) {
      const v = light.get(t) ?? palette.find((p) => p.token === t)?.light;
      if (v) allowed.set(v.toLowerCase(), t);
    }
    const bad = (prop, value) => {
      const v = value.trim();
      if (v.toLowerCase() === 'none') return;
      if (!HEX6.test(v) || !allowed.has(v.toLowerCase())) add(FAVICON_REL, 0, 'DOCS-THEME-017', `${prop} is "${v}"; only the light mascot-body, mascot-face and mascot-headset hex literals (${[...allowed.keys()].join(', ')}) are allowed`);
    };
    const COLOR_PROPS = /^(fill|stroke|stop-color|flood-color|lighting-color|color)$/;
    for (const e of tagEvents(fav)) {
      if (e.close) continue;
      for (const [k, v] of Object.entries(e.attrs)) if (COLOR_PROPS.test(k)) bad(k, v);
      if (e.attrs.style) for (const m of e.attrs.style.matchAll(/(?:^|;)\s*(fill|stroke|stop-color|flood-color|lighting-color|color)\s*:\s*([^;]+)/g)) bad(m[1], m[2]);
    }
    for (const m of fav.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      for (const d of m[1].matchAll(/(?:^|[;{\s])(fill|stroke|stop-color|flood-color|lighting-color|color)\s*:\s*([^;}]+)/g)) bad(d[1], d[2]);
    }
  }

  // ---- track badges, aside, callouts, diagrams, home, motion, focus, small screens, print
  const sels = (r, pred) => r.sels.some(pred);
  const rulesWhere = (pred, filter = () => true) => css.filter((r) => r.file && r.sels.length && filter(r) && sels(r, pred));
  const tokenVar = (t) => `var(--cohost-${t})`;

  if (styleText !== null) {
    for (const track of TRACKS) {
      const rs = rulesWhere((s) => s.includes(`[data-track='${track}']`));
      const c = lastDecl(rs, 'color');
      const bg = lastDecl(rs, 'background-color') ?? lastDecl(rs, 'background');
      if (!c || norm(c.value) !== tokenVar(`badge-${track}-text`)) add(STYLE_REL, c?.line ?? 0, 'DOCS-THEME-021', `the ${track} badge ([data-track='${track}']) must set color to ${tokenVar(`badge-${track}-text`)}${c ? `, found ${c.value}` : ''}`);
      if (!bg || norm(bg.value) !== tokenVar(`badge-${track}-bg`)) add(STYLE_REL, bg?.line ?? 0, 'DOCS-THEME-021', `the ${track} badge ([data-track='${track}']) must set its background to ${tokenVar(`badge-${track}-bg`)}${bg ? `, found ${bg.value}` : ''}`);
    }

    // aside
    const aside = rulesWhere((s) => hasClass(lastCompound(s), 'cohost-aside') && !s.includes('::') && !hasClass(lastCompound(s), 'cohost-aside-title'));
    const abg = lastDecl(aside, 'background-color') ?? lastDecl(aside, 'background');
    if (!abg || norm(abg.value) !== tokenVar('aside-bg')) add(STYLE_REL, abg?.line ?? 0, 'DOCS-THEME-022', `.cohost-aside must have the background ${tokenVar('aside-bg')}${abg ? `, found ${abg.value}` : ''}`);
    const bl = resolveLine(aside, 'border-left');
    if (bl.width !== '4px') add(STYLE_REL, 0, 'DOCS-THEME-022', `.cohost-aside needs a 4px left border, found a ${bl.width ?? 'missing'} border width`);
    if (bl.style !== 'solid') add(STYLE_REL, 0, 'DOCS-THEME-022', `.cohost-aside needs a solid left border, found ${bl.style ?? 'no style'}`);
    if (norm(bl.color ?? '') !== tokenVar('accent')) add(STYLE_REL, 0, 'DOCS-THEME-022', `.cohost-aside's left border must be coloured ${tokenVar('accent')}, found ${bl.color ?? 'no colour'}`);
    const title = rulesWhere((s) => hasClass(lastCompound(s), 'cohost-aside-title') && !s.includes('::'));
    const tc = lastDecl(title, 'color');
    if (!tc || norm(tc.value) !== tokenVar('aside-title')) add(STYLE_REL, tc?.line ?? 0, 'DOCS-THEME-022', `.cohost-aside-title must have the colour ${tokenVar('aside-title')}${tc ? `, found ${tc.value}` : ''}`);
    for (const r of rulesWhere((s) => hasClass(s, 'cohost-aside'))) {
      const fs = r.decl('font-style');
      if (fs && /\bitalic\b/i.test(fs.value)) add(r.file, fs.line, 'DOCS-THEME-022', `sets font-style: italic on ${r.sels.join(', ')}; the aside is upright`);
    }
    const before = rulesWhere((s) => (hasClass(s, 'cohost-aside') || hasClass(s, 'cohost-aside-title')) && s.endsWith('::before'));
    const mask = lastDecl(before, 'mask-image');
    if (!before.length || !mask) add(STYLE_REL, 0, 'DOCS-THEME-023', "no .cohost-aside ... ::before rule sets mask-image; the aside title is preceded by the mark drawn as a mask");
    else {
      const urls = [...mask.value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gs)].map((m) => m[2]);
      if (!urls.length || urls.some((u) => !/^data:/i.test(u.trim()))) add(STYLE_REL, mask.line, 'DOCS-THEME-023', `mask-image must use a data: URL so nothing is fetched, found ${urls.find((u) => !/^data:/i.test(u.trim())) ?? mask.value.slice(0, 40)}`);
    }

    // callouts
    for (const t of ['tip', 'info', 'warning', 'danger', 'details']) {
      const tok = tokenVar(`${t === 'details' ? 'info' : t}-title`);
      const blockRules = rulesWhere((s) => s.includes(`.custom-block.${t}`) && !s.includes('::') && !/\.custom-block-title|summary/.test(s) && lastCompound(s).includes(`.${t}`));
      const b = resolveLine(blockRules, 'border-left');
      if (b.width !== '4px' || b.style !== 'solid' || norm(b.color ?? '') !== tok) add(STYLE_REL, 0, 'DOCS-THEME-024', `.custom-block.${t} needs a 4px solid left border in ${tok}, found ${[b.width, b.style, b.color].filter(Boolean).join(' ') || 'none'}`);
      const titleRules = rulesWhere((s) => s.includes(`.custom-block.${t}`) && (t === 'details' ? /summary|\.custom-block-title/.test(lastCompound(s)) : lastCompound(s).includes('custom-block-title')));
      const c = lastDecl(titleRules, 'color');
      if (!c || norm(c.value) !== tok) add(STYLE_REL, c?.line ?? 0, 'DOCS-THEME-024', `the title of .custom-block.${t} needs the colour ${tok}${c ? `, found ${c.value}` : ''}`);
    }

    // diagrams
    const fig = rulesWhere((s) => lastCompound(s) === '.cohost-diagram');
    const ox = lastDecl(fig, 'overflow-x');
    if (!ox || norm(ox.value) !== 'auto') add(STYLE_REL, ox?.line ?? 0, 'DOCS-THEME-031', `.cohost-diagram needs overflow-x: auto${ox ? `, found ${ox.value}` : ''}`);
    const dsvg = rulesWhere((s) => /(^|\s)\.cohost-diagram\s+svg$/.test(s) || /\.cohost-diagram\s+svg$/.test(s));
    const dw = lastDecl(dsvg, 'width');
    if (!dw || norm(dw.value) !== 'auto') add(STYLE_REL, dw?.line ?? 0, 'DOCS-THEME-031', `.cohost-diagram svg needs width: auto${dw ? `, found ${dw.value}` : ''}`);
    const dx = lastDecl(dsvg, 'max-width');
    if (!dx || norm(dx.value) !== 'none') add(STYLE_REL, dx?.line ?? 0, 'DOCS-THEME-031', `.cohost-diagram svg needs max-width: none${dx ? `, found ${dx.value}` : ''}`);
    const dm = lastDecl(dsvg, 'min-width');
    if (dm) add(STYLE_REL, dm.line, 'DOCS-THEME-031', `.cohost-diagram svg must not set min-width, found ${dm.value}`);

    // home cards
    const cards = [['accent', 1], ['badge-simple-text', 2], ['badge-advanced-text', 3]];
    for (const [tok, n] of cards) {
      const rs = rulesWhere((s) => /VPFeature/.test(s) && !/:hover|:focus|::/.test(s) && (!/:nth-/.test(s) || new RegExp(`:nth-(?:child|of-type)\\(\\s*${n}\\s*\\)`).test(s)));
      const bt = resolveLine(rs, 'border-top');
      if (bt.width !== '4px' || norm(bt.color ?? '') !== tokenVar(tok) || (bt.style && bt.style !== 'solid')) add(STYLE_REL, 0, 'DOCS-THEME-036', `feature card ${n} needs a 4px top border in ${tokenVar(tok)}, found ${[bt.width, bt.style, bt.color].filter(Boolean).join(' ') || 'none'}`);
    }

    // flow
    const flow = rulesWhere((s) => /\.cohost-flow\s+ol$/.test(s));
    const base = flow.filter((r) => !inMinWidth(r.anc));
    const wide = flow.filter((r) => r.anc.some((b) => isMedia(b, /\(\s*min-width\s*:\s*640px\s*\)/i)));
    if (norm(lastDecl(base, 'display')?.value) !== 'flex') add(STYLE_REL, 0, 'DOCS-THEME-037', '.cohost-flow ol needs display: flex outside any min-width media query');
    if (norm(lastDecl(base, 'flex-direction')?.value) !== 'column') add(STYLE_REL, 0, 'DOCS-THEME-037', '.cohost-flow ol needs flex-direction: column outside any min-width media query');
    if (norm(lastDecl(wide, 'flex-direction')?.value) !== 'row') add(STYLE_REL, 0, 'DOCS-THEME-037', '.cohost-flow ol needs flex-direction: row inside @media (min-width: 640px)');
    if (norm(lastDecl(wide, 'flex-wrap')?.value) !== 'wrap') add(STYLE_REL, 0, 'DOCS-THEME-037', '.cohost-flow ol needs flex-wrap: wrap inside @media (min-width: 640px)');
    for (const r of flow) {
      if (inMinWidth(r.anc)) continue;
      const fd = r.decl('flex-direction');
      if (fd && norm(fd.value) !== 'column') add(r.file, fd.line, 'DOCS-THEME-037', `.cohost-flow ol sets flex-direction: ${fd.value} outside a min-width media query`);
      const fw = r.decl('flex-wrap');
      if (fw) add(r.file, fw.line, 'DOCS-THEME-037', '.cohost-flow ol sets flex-wrap outside a min-width media query');
    }
  }

  // ---- motion, focus, small screens, print (over both theme CSS files)
  const NOPREF = /\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/i;
  const REDUCE = /\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i;
  for (const r of css) {
    if (r.block.prelude.startsWith('@keyframes') || r.anc.some((b) => /^@(?:-webkit-)?keyframes/i.test(b.prelude))) continue;
    for (const d of r.block.decls) {
      if (['animation', 'animation-name', 'transition'].includes(d.prop) && !r.anc.some((b) => isMedia(b, NOPREF))) add(r.file, d.line, 'DOCS-THEME-040', `${d.prop} must sit inside @media (prefers-reduced-motion: no-preference)`);
    }
  }
  const reduceRules = css.filter((r) => r.anc.some((b) => isMedia(b, REDUCE)));
  const universal = reduceRules.filter((r) => ['*', '*::before', '*::after'].every((s) => r.sels.map((x) => (x.startsWith('::') ? `*${x}` : x)).includes(s)));
  if (!universal.length) add(STYLE_REL, 0, 'DOCS-THEME-041', 'no @media (prefers-reduced-motion: reduce) rule applies to *, *::before and *::after');
  else {
    for (const p of ['animation-duration', 'transition-duration']) {
      const d = lastDecl(universal, p);
      const ms = d ? timeMs(d.value) : null;
      if (!d || ms === null || ms > 0.01 || !d.important) add(STYLE_REL, d?.line ?? 0, 'DOCS-THEME-041', `the reduced-motion rule must set ${p} to at most 0.01ms !important${d ? `, found ${d.value}${d.important ? ' !important' : ''}` : ''}`);
    }
    const ic = lastDecl(universal, 'animation-iteration-count');
    if (!ic || norm(ic.value) !== '1' || !ic.important) add(STYLE_REL, ic?.line ?? 0, 'DOCS-THEME-041', `the reduced-motion rule must set animation-iteration-count: 1 !important${ic ? `, found ${ic.value}${ic.important ? ' !important' : ''}` : ''}`);
    const sb = lastDecl(universal, 'scroll-behavior');
    if (!sb || norm(sb.value) !== 'auto' || !sb.important) add(STYLE_REL, sb?.line ?? 0, 'DOCS-THEME-041', `the reduced-motion rule must set scroll-behavior: auto !important${sb ? `, found ${sb.value}${sb.important ? ' !important' : ''}` : ''}`);
  }
  for (const r of css) {
    const an = r.decl('animation-name');
    if (!an) continue;
    const name = an.value.trim();
    if (r.decl('animation')) add(r.file, r.line, 'DOCS-THEME-042', `${r.sels.join(', ')} sets animation-name and the animation shorthand`);
    if (!/^-?[A-Za-z_][\w-]*$/.test(name)) add(r.file, an.line, 'DOCS-THEME-042', `animation-name is "${name}"; it must be a single name`);
    const dur = r.decl('animation-duration');
    const ms = dur ? timeMs(dur.value) : null;
    if (ms === null) add(r.file, an.line, 'DOCS-THEME-042', `a rule that sets animation-name must set animation-duration in s or ms${dur ? `, found ${dur.value}` : ''}`);
    const ic = r.decl('animation-iteration-count');
    const n = ic && /^\d*\.?\d+$/.test(norm(ic.value)) ? parseFloat(ic.value) : null;
    if (n === null) add(r.file, an.line, 'DOCS-THEME-042', `a rule that sets animation-name must set animation-iteration-count to a number${ic ? `, found ${ic.value}` : ''}`);
    else if (ms !== null && (ms * n) / 1000 > 5) add(r.file, an.line, 'DOCS-THEME-042', `the animation runs ${((ms * n) / 1000).toFixed(2)}s in all; at most 5 seconds`);
  }

  // focus
  const FOCUS_TARGETS = ['a', 'button', 'summary', 'input', 'select', 'textarea', '[tabindex]'];
  for (const target of FOCUS_TARGETS) {
    const rs = css.filter((r) => r.sels.some((s) => {
      const c = lastCompound(s);
      return c === `${target}:focus-visible` || (c.startsWith(`${target}:focus-visible`) && !c.startsWith(`${target}:focus-visible::`));
    }));
    if (!rs.length) {
      add(STYLE_REL, 0, 'DOCS-THEME-043', `no rule styles ${target}:focus-visible`);
      continue;
    }
    const o = resolveLine(rs, 'outline');
    if (o.width !== '2px' || o.style !== 'solid' || norm(o.color ?? '') !== tokenVar('focus')) add(STYLE_REL, rs[0].line, 'DOCS-THEME-043', `${target}:focus-visible needs outline: 2px solid ${tokenVar('focus')}, found ${[o.width, o.style, o.color].filter(Boolean).join(' ') || 'none'}`);
    const off = lastDecl(rs, 'outline-offset');
    if (!off || norm(off.value) !== '2px') add(STYLE_REL, rs[0].line, 'DOCS-THEME-043', `${target}:focus-visible needs outline-offset: 2px${off ? `, found ${off.value}` : ''}`);
  }
  for (const r of css) {
    for (const d of r.block.decls) {
      const v = norm(d.value);
      const zero = /^(0|0px)$/;
      let bad = false;
      if (d.prop === 'outline' || d.prop === 'outline-style') bad = splitTop(v, ' ').some((t) => t === 'none' || (d.prop === 'outline' && zero.test(t)));
      else if (d.prop === 'outline-width') bad = zero.test(v);
      if (bad) add(r.file, d.line, 'DOCS-THEME-044', `${d.prop}: ${d.value} removes an outline`);
    }
  }

  // small screens
  for (const r of css) {
    if (inMinWidth(r.anc)) continue;
    for (const d of r.block.decls) {
      if (!['width', 'min-width', 'flex-basis'].includes(d.prop)) continue;
      const px = lengthPx(d.value);
      if (px === null || px <= 328) continue;
      add(r.file, d.line, 'DOCS-THEME-045', `${d.prop}: ${d.value} (${px}px) is above 328px outside a min-width media query`);
    }
  }

  // print
  const PRINT = /^@media\s+print\b/i;
  const printRules = css.filter((r) => r.anc.some((b) => PRINT.test(b.prelude.trim())));
  const printStyle = printRules.filter((r) => r.file === STYLE_REL);
  const hidden = (r) => {
    const d = r.decl('display');
    return d && norm(d.value) === 'none';
  };
  for (const s of ['.VPNav', '.VPLocalNav', '.VPSidebar', '.VPDocAside', '.VPDoc .aside', '.VPDocFooter .prev-next']) {
    if (!printRules.some((r) => r.sels.includes(s) && hidden(r))) add(STYLE_REL, 0, 'DOCS-THEME-046', `the @media print block must hide ${s} (display: none)`);
  }
  for (const r of printRules) {
    if (r.sels.some((s) => hasClass(s, 'cohost-track-badge')) && (hidden(r) || norm(r.decl('visibility')?.value) === 'hidden')) add(r.file, r.line, 'DOCS-THEME-046', 'the @media print block hides .cohost-track-badge; the badge prints');
  }
  const DARK_SELS = new Set(['.dark', ':root.dark', 'html.dark', '.dark:root', 'html.dark:root']);
  const darkPrint = printStyle.filter((r) => r.sels.some((s) => DARK_SELS.has(s)));
  for (const [t, v] of light) {
    const d = lastDecl(darkPrint, `--cohost-${t}`);
    if (!d || d.value.trim().toLowerCase() !== v.toLowerCase()) add(STYLE_REL, d?.line ?? 0, 'DOCS-THEME-047', `the @media print block must set --cohost-${t} to its light value ${v} under .dark${d ? `, found ${d.value}` : ''}`);
  }
  const shikiColor = printStyle.filter((r) => r.sels.some((s) => hasClass(s, 'dark') && /\.shiki|\bspan\b|\bcode\b|\bpre\b/.test(s)));
  const sc = lastDecl(shikiColor, 'color');
  if (!sc || norm(sc.value) !== 'var(--shiki-light)') add(STYLE_REL, sc?.line ?? 0, 'DOCS-THEME-050', `the @media print block must colour highlighted code under .dark with var(--shiki-light)${sc ? `, found ${sc.value}` : ''}`);
  const codeBgLight = light.get('code-bg');
  const shikiBg = printStyle.filter((r) => r.sels.some((s) => hasClass(s, 'dark') && /language-|\.shiki|\bpre\b/.test(s)));
  const sbg = lastDecl(shikiBg, 'background-color') ?? lastDecl(shikiBg, 'background');
  if (!sbg || !(norm(sbg.value) === (codeBgLight ?? '').toLowerCase() || norm(sbg.value) === tokenVar('code-bg'))) add(STYLE_REL, sbg?.line ?? 0, 'DOCS-THEME-050', `the @media print block must give code blocks under .dark the light code-bg ${codeBgLight ?? ''}${sbg ? `, found ${sbg.value}` : ''}`);
  const wrap = printRules.filter((r) => r.sels.includes(normSel(".vp-doc div[class*='language-'] pre")));
  if (norm(lastDecl(wrap, 'white-space')?.value) !== 'pre-wrap') add(STYLE_REL, 0, 'DOCS-THEME-048', "the @media print block must set white-space: pre-wrap on .vp-doc div[class*='language-'] pre");
  for (const t of ['.cohost-diagram', '.cohost-aside', '.custom-block']) {
    const rs = printRules.filter((r) => r.sels.some((s) => lastCompound(s) === t));
    if (norm(lastDecl(rs, 'break-inside')?.value) !== 'avoid') add(STYLE_REL, 0, 'DOCS-THEME-053', `the @media print block must set break-inside: avoid on ${t}`);
  }
  for (const target of [".vp-doc a[href^='http']::after", ".vp-doc a[href^='//']::after"]) {
    const rs = printRules.filter((r) => r.sels.includes(normSel(target)));
    const c = lastDecl(rs, 'content');
    if (!c || ws(c.value.replace(/'/g, '"')) !== '" (" attr(href) ")"') add(STYLE_REL, c?.line ?? 0, 'DOCS-THEME-054', `the @media print block must set content: " (" attr(href) ")" on ${target}${c ? `, found ${c.value}` : ''}`);
  }

  // ---- the Mermaid renderer module
  const vpDir = join(root, 'docs/.vitepress');
  const modules = walk(vpDir, new Set(['node_modules', 'dist', 'cache'])).filter((f) => /\.(?:mjs|js|ts|mts|cjs)$/.test(f));
  const users = modules.filter((f) => /(?:from\s*|require\(\s*|import\(\s*)['"]beautiful-mermaid['"]/.test(readFileSync(join(vpDir, f), 'utf8')));
  if (!users.length) add('docs/.vitepress', 0, 'DOCS-THEME-028', 'no module imports beautiful-mermaid to render the mermaid fences');
  else {
    const EXPECT = { bg: "'var(--cohost-bg)'", fg: "'var(--cohost-text-1)'", muted: "'var(--cohost-text-2)'", line: "'var(--cohost-text-2)'", accent: "'var(--cohost-accent)'", surface: "'var(--cohost-bg-soft)'", border: "'var(--cohost-text-3)'", transparent: 'true', font: "'Inter'" };
    for (const f of users) {
      const rel = `docs/.vitepress/${f}`;
      const text = readFileSync(join(vpDir, f), 'utf8');
      const at = text.search(/\bbg\s*:/);
      const body = at === -1 ? null : enclosingObject(text, at);
      if (body === null) {
        add(rel, 0, 'DOCS-THEME-028', 'cannot find the beautiful-mermaid options object (an object literal with bg: ...)');
        continue;
      }
      const got = new Map();
      for (const entry of splitTop(body, ',')) {
        const e = entry.trim();
        if (!e) continue;
        const m = /^(['"]?)([\w$-]+)\1\s*:\s*([\s\S]+)$/.exec(e);
        if (m) got.set(m[2], unquote(m[3]));
        else got.set(e, '(spread or shorthand)');
      }
      for (const [k, v] of Object.entries(EXPECT)) {
        if (!got.has(k)) add(rel, 0, 'DOCS-THEME-028', `the beautiful-mermaid options lack ${k}: ${v}`);
        else if (got.get(k) !== v) add(rel, 0, 'DOCS-THEME-028', `the beautiful-mermaid option ${k} is ${got.get(k)}; it must be ${v}`);
      }
      for (const k of got.keys()) if (!(k in EXPECT)) add(rel, 0, 'DOCS-THEME-028', `the beautiful-mermaid options carry ${k}, which is not one of the specified options`);
    }
  }

  // ---- the home page's flow
  const idx = readIf(join(root, 'docs/index.md'));
  if (idx !== null) {
    const lines = analyze(idx).all;
    const starts = [];
    lines.forEach((l, k) => {
      if (/^\s*:::\s*flow\b/.test(l)) starts.push(k);
    });
    const F = 'docs/index.md';
    if (starts.length !== 1) add(F, 0, 'DOCS-THEME-034', `holds ${starts.length} "::: flow" containers; it needs exactly one`);
    else {
      let end = lines.findIndex((l, k) => k > starts[0] && /^\s*:::\s*$/.test(l));
      if (end === -1) {
        add(F, starts[0] + 1, 'DOCS-THEME-034', 'the ::: flow container is never closed by :::');
        end = lines.length;
      }
      const inner = lines.slice(starts[0] + 1, end);
      const items = [];
      let lists = 0;
      let lastItemEnd = -1;
      let inList = false;
      let blankBefore = false;
      inner.forEach((l, k) => {
        const m = /^\s{0,3}(\d+)[.)]\s+(.*)$/.exec(l);
        if (m) {
          if (!inList) lists++;
          inList = true;
          items.push({ text: m[2], line: starts[0] + 2 + k });
          lastItemEnd = k;
        } else if (l.trim() !== '' && inList) {
          if (/^\s{2,}\S/.test(l) || !blankBefore) {
            items.at(-1).text += ` ${l.trim()}`;
            lastItemEnd = k;
          } else inList = false;
        }
        blankBefore = l.trim() === '';
      });
      if (lists !== 1) add(F, starts[0] + 1, 'DOCS-THEME-034', `the flow container holds ${lists} ordered lists; it needs exactly one`);
      if (items.length !== 6) add(F, starts[0] + 1, 'DOCS-THEME-034', `the flow list has ${items.length} items; it needs exactly six`);
      const WORDS = [['chat'], ['salience'], ['cortex'], ['voice'], ['sink', 'discord'], ['avatar']];
      const plain = (t) => t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '');
      WORDS.forEach((alts, k) => {
        const it = items[k];
        if (!it) return;
        if (!alts.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(plain(it.text)))) add(F, it.line, 'DOCS-THEME-034', `flow item ${k + 1} must contain the word ${alts.join(' or ')}; it reads "${plain(it.text).slice(0, 50)}"`);
      });
      const after = inner.slice(lastItemEnd + 1).join('\n');
      const okLink = [...after.matchAll(/\]\(\s*<?([^)\s>]+)>?/g)].some((m) => ['start/how-it-works.md', 'start/how-it-works', '/start/how-it-works'].includes(m[1].replace(/#.*$/, '').replace(/^\.\//, '')));
      if (!okLink) add(F, starts[0] + 1, 'DOCS-THEME-034', 'the flow container must end with a link to the How it works page (start/how-it-works.md, start/how-it-works or /start/how-it-works) after the list');
    }
  }
}

// ---------------------------------------------------------------------------------------------------- theme: built-site pass

const TRACK_LABELS = { start: 'Start here', simple: 'Simple', advanced: 'Advanced', project: 'Project' };
const isExternal = (u) => /^(?:https?:|\/\/)/i.test(u.trim());
const FOCUSABLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'details']);

/** URLs a stylesheet fetches: @import targets and url() values. */
function cssRefs(css) {
  const out = [];
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/gi)) out.push(m[2]);
  for (const m of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gis)) out.push(m[2]);
  return out;
}
/** Resource references (URLs the browser fetches unprompted) of a built page. */
function resourceRefs(html, events) {
  const out = [];
  for (const e of events) {
    if (e.close) continue;
    const a = e.attrs;
    for (const k of ['src', 'poster', 'data']) if (a[k]) out.push(a[k]);
    if (a.srcset) for (const part of a.srcset.split(',')) out.push(part.trim().split(/\s+/)[0]);
    if (e.name === 'link') {
      const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
      if (a.href && !rel.some((r) => ['canonical', 'alternate', 'me'].includes(r))) out.push(a.href);
    }
    if (e.name === 'image' || e.name === 'use') for (const k of ['href', 'xlink:href']) if (a[k]) out.push(a[k]);
    if (a.style) out.push(...cssRefs(a.style));
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push(...cssRefs(m[1]));
  return out.filter(Boolean);
}

/** Plain text of a markdown heading: inline markup and a trailing {#id} removed, entities decoded. */
function plainHeading(text) {
  return decodeEntities(
    text
      .replace(/\s*\{[^}]*\}\s*$/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, '$2')
      .replace(/<[^>]+>/g, '')
      .replace(/(\*\*|__|\*|_|~~)/g, ''),
  ).trim();
}
/** The diagram labels a source markdown text requires, one per mermaid fence in order. */
function diagramLabels(markdown, fallbackTitle) {
  const a = analyze(markdown);
  return a.fences
    .filter((f) => f.lang === 'mermaid')
    .map((f) => {
      const h = [...a.headings].reverse().find((x) => x.n < f.line);
      return `Diagram: ${h ? plainHeading(h.text) : fallbackTitle}`;
    });
}

/**
 * The built-site theme checks over the files in dist.
 * @spec DOCS-THEME-010, DOCS-THEME-015, DOCS-THEME-016, DOCS-THEME-018, DOCS-THEME-019, DOCS-THEME-020, DOCS-THEME-025,
 * DOCS-THEME-026, DOCS-THEME-029, DOCS-THEME-030, DOCS-THEME-033, DOCS-THEME-035, DOCS-THEME-039, DOCS-THEME-051,
 * DOCS-THEME-052, DOCS-THEME-056
 */
function themeDistChecks(root, dist, files, htmlFiles, add) {
  const rel = (f) => `docs/.vitepress/dist/${f}`;

  // ---- source pages: track and diagram labels per built file
  const docs = join(root, 'docs');
  const sources = new Map();
  const isTemplate = (f) => /\[[^\]/]+\]\.md$/.test(f);
  for (const f of walk(docs, new Set(['node_modules', '.vitepress', 'public'])).filter((f) => f.endsWith('.md'))) {
    if (isTemplate(f) || REQUIRED_EXCLUDES.some((g) => globToRegExp(g).test(f))) continue;
    let data = {};
    let body = '';
    const text = readFileSync(join(docs, f), 'utf8');
    try {
      ({ data, body } = splitFrontmatter(text, `docs/${f}`));
    } catch {
      continue;
    }
    const out = f.endsWith('/index.md') || f === 'index.md' ? f.replace(/index\.md$/, 'index.html') : f.replace(/\.md$/, '.html');
    sources.set(out, { track: typeof data.track === 'string' ? data.track : null, title: String(data.title ?? ''), markdown: text, home: f === 'index.md', body });
  }
  const excerpts = new Map();
  if (existsSync(join(docs, 'advanced/architecture'))) {
    try {
      for (const e of loadDesign(root).pages) excerpts.set(`${e.route}.html`, { track: 'advanced', title: e.title, markdown: e.content });
    } catch {
      // the source pass reports a broken design tree
    }
  }
  const isExcerptPath = (f) => /^advanced\/architecture\/(?:design|segments|decisions)\/[^/]+\.html$/.test(f);

  // ---- stylesheets
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    const seen = new Set();
    for (const u of cssRefs(readFileSync(join(dist, f), 'utf8'))) {
      if (isExternal(u) && !seen.has(u)) {
        seen.add(u);
        add(rel(f), 0, 'DOCS-THEME-010', `loads ${u} from another origin`);
      }
    }
  }
  for (const f of files) if (/^assets\/(?:.*\/)?mermaid[^/]*\.js$/i.test(f)) add(rel(f), 0, 'DOCS-THEME-052', 'is a Mermaid script; no Mermaid code runs in the reader\'s browser');

  const home = htmlFiles.includes('index.html') ? 'index.html' : null;
  if (home === null) add(rel('index.html'), 0, 'DOCS-THEME-035', 'does not exist');

  for (const page of htmlFiles) {
    const html = readFileSync(join(dist, page), 'utf8');
    const events = tagEvents(html);
    const F = rel(page);

    // 010: no resource reference to another origin
    const seen = new Set();
    for (const u of resourceRefs(html, events)) {
      if (isExternal(decodeEntities(u)) && !seen.has(u)) {
        seen.add(u);
        add(F, 0, 'DOCS-THEME-010', `loads ${u} from another origin`);
      }
    }

    // 051: favicon link in the head
    const headEnd = events.find((e) => e.close && e.name === 'head')?.index ?? html.length;
    const hasIcon = events.some((e) => !e.close && e.name === 'link' && e.index < headEnd && (e.attrs.rel ?? '').trim() === 'icon' && e.attrs.type === 'image/svg+xml' && e.attrs.href === '/cohost/favicon.svg');
    if (!hasIcon) add(F, 0, 'DOCS-THEME-051', 'its <head> has no <link rel="icon" type="image/svg+xml" href="/cohost/favicon.svg">');

    // 015, 016, 056: the mark
    const nav = regionOf(events, (e) => hasTok(e, 'VPNav'));
    const marks = events.filter((e) => !e.close && e.name === 'svg' && hasTok(e, 'cohost-mark'));
    for (const m of marks) {
      if (inside(m, nav)) {
        if (m.attrs['aria-hidden'] !== 'true') add(F, 0, 'DOCS-THEME-015', 'the mark in the nav bar must carry aria-hidden="true"');
        if ('role' in m.attrs) add(F, 0, 'DOCS-THEME-015', `the mark in the nav bar must carry no role, found role="${String(m.attrs.role)}"`);
        if ('aria-label' in m.attrs) add(F, 0, 'DOCS-THEME-015', 'the mark in the nav bar must carry no aria-label');
      } else {
        if (m.attrs.role !== 'img') add(F, 0, 'DOCS-THEME-056', `a mark shown alone must carry role="img", found ${m.attrs.role === undefined ? 'no role' : `role="${m.attrs.role}"`}`);
        if (m.attrs['aria-label'] !== 'The cohost mascot') add(F, 0, 'DOCS-THEME-056', `a mark shown alone must carry aria-label="The cohost mascot", found ${m.attrs['aria-label'] === undefined ? 'no aria-label' : `"${m.attrs['aria-label']}"`}`);
      }
    }
    if (!nav) add(F, 0, 'DOCS-THEME-016', 'has no nav bar (.VPNav) to show the mark in');
    else {
      const title = regionOf(events, (e) => hasTok(e, 'VPNavBarTitle')) ?? nav;
      const first = marks.find((m) => inside(m, title));
      if (!first) add(F, 0, 'DOCS-THEME-016', 'the nav bar shows no cohost mark before the site title');
      else {
        if (first.attrs['data-expression'] !== 'idle') add(F, 0, 'DOCS-THEME-016', `the nav bar mark has data-expression="${first.attrs['data-expression'] ?? ''}"; it must be idle`);
        const endOfMark = events.find((e) => e.close && e.name === 'svg' && e.index > first.index)?.end ?? first.end;
        const beforeText = textOf(html.slice(title.innerStart, first.index)).trim();
        const afterText = textOf(html.slice(endOfMark, title.innerEnd));
        if (beforeText || !/cohost/i.test(afterText)) add(F, 0, 'DOCS-THEME-016', 'the nav bar mark must come before the site title text');
      }
    }

    // 035: hero
    if (page === home) {
      const hero = regionOf(events, (e) => hasTok(e, 'VPHero'));
      const talk = hero && marks.find((m) => inside(m, hero) && m.attrs['data-expression'] === 'talking');
      if (!hero) add(F, 0, 'DOCS-THEME-035', 'has no hero (.VPHero)');
      else if (!talk) add(F, 0, 'DOCS-THEME-035', 'the hero image slot must hold the cohost mark with data-expression="talking"');

      // 033: the flow container
      const flows = regionsOf(events, (e) => e.name === 'div' && hasTok(e, 'cohost-flow'));
      if (flows.length !== 1) add(F, 0, 'DOCS-THEME-033', `has ${flows.length} .cohost-flow containers; it needs exactly one`);
      else {
        const fl = flows[0];
        const inner = html.slice(fl.innerStart, fl.innerEnd);
        const innerEvents = events.filter((e) => e.index >= fl.innerStart && e.index < fl.innerEnd);
        const ol = regionOf(innerEvents, (e) => e.name === 'ol');
        if (!ol) add(F, 0, 'DOCS-THEME-033', 'the .cohost-flow container holds no ordered list (<ol>); its content must be parsed as markdown');
        else {
          const lis = innerEvents.filter((e) => !e.close && e.name === 'li' && inside(e, ol)).length;
          if (lis !== 6) add(F, 0, 'DOCS-THEME-033', `the flow list has ${lis} items; it needs six`);
        }
        if (/:::/.test(textOf(inner))) add(F, 0, 'DOCS-THEME-033', 'the .cohost-flow container holds an unparsed ::: line');
      }
    }

    // 018, 019, 020: track badges
    const badges = regionsOf(events, (e) => hasTok(e, 'cohost-track-badge'));
    for (const b of badges) {
      const track = b.open.attrs['data-track'];
      const label = TRACK_LABELS[track];
      const inner = html.slice(b.innerStart, b.innerEnd);
      const text = textOf(inner);
      if (label === undefined) add(F, 0, 'DOCS-THEME-018', `a track badge has data-track="${track ?? ''}"; it must be one of ${TRACKS.join(', ')}`);
      else if (text !== `Track: ${label}`) add(F, 0, 'DOCS-THEME-018', `the ${track} badge reads "${text}"; it must read "Track: ${label}"`);
      const lead = /^\s*<([A-Za-z][\w-]*)\b([^>]*)>\s*Track:\s*<\/\1\s*>/.exec(inner);
      if (!lead || !/\b(?:visually-hidden|sr-only)\b/.test(lead[2]) || /aria-hidden|(?<![\w-])hidden(?![\w-])/.test(lead[2])) add(F, 0, 'DOCS-THEME-019', 'the badge must begin with "Track: " in an element hidden visually (class visually-hidden) but not from screen readers');
      const kids = events.filter((e) => !e.close && e.index >= b.start && e.index < b.end);
      for (const k of kids) {
        if (FOCUSABLE.has(k.name) || 'tabindex' in k.attrs || 'href' in k.attrs || k.attrs.contenteditable !== undefined) add(F, 0, 'DOCS-THEME-019', `the track badge is or contains a link or other focusable element (<${k.name}>)`);
      }
    }
    const src = sources.get(page);
    const exc = excerpts.get(page) ?? (isExcerptPath(page) && !src ? { track: 'advanced' } : null);
    const want = src && !src.home && src.track ? src.track : exc ? exc.track : null;
    if (want) {
      const matching = badges.filter((b) => b.open.attrs['data-track'] === want).length;
      if (badges.length !== 1 || matching !== 1) add(F, 0, 'DOCS-THEME-020', `must contain exactly one .cohost-track-badge with data-track="${want}"; it has ${badges.length}${badges.length ? ` (${badges.map((b) => b.open.attrs['data-track'] ?? '').join(', ')})` : ''}`);
    }

    // 025, 026, 029, 030: diagrams
    for (const e of events) {
      if (!e.close && (e.attrs.class ?? '').includes('language-mermaid')) add(F, 0, 'DOCS-THEME-026', 'holds an element with class language-mermaid; a mermaid fence was left as a code block');
    }
    const figs = regionsOf(events, (e) => e.name === 'figure' && hasTok(e, 'cohost-diagram'));
    const expected = src ? diagramLabels(src.markdown, src.title) : exc && exc.markdown ? diagramLabels(exc.markdown, exc.title) : null;
    if (expected && figs.length !== expected.length) add(F, 0, 'DOCS-THEME-025', `holds ${figs.length} <figure class="cohost-diagram">; its source has ${expected.length} mermaid fence${expected.length === 1 ? '' : 's'}`);
    figs.forEach((f, k) => {
      if (f.open.attrs.tabindex !== '0') add(F, 0, 'DOCS-THEME-025', 'a <figure class="cohost-diagram"> must carry tabindex="0"');
      const fe = events.filter((e) => e.index >= f.innerStart && e.index < f.innerEnd);
      const svg = fe.find((e) => !e.close && e.name === 'svg');
      if (!svg) {
        add(F, 0, 'DOCS-THEME-025', 'a <figure class="cohost-diagram"> must hold the diagram as an inline <svg>');
        return;
      }
      if (/@import/i.test(html.slice(f.innerStart, f.innerEnd))) add(F, 0, 'DOCS-THEME-029', 'a rendered diagram still holds an @import rule');
      if (svg.attrs.role !== 'img') add(F, 0, 'DOCS-THEME-030', `a diagram's <svg> must carry role="img", found ${svg.attrs.role === undefined ? 'no role' : svg.attrs.role}`);
      const label = svg.attrs['aria-label'];
      if (!label || !label.startsWith('Diagram: ')) add(F, 0, 'DOCS-THEME-030', `a diagram's <svg> aria-label must start with "Diagram: ", found ${label === undefined ? 'none' : `"${label}"`}`);
      else if (expected && expected[k] !== undefined && label !== expected[k]) add(F, 0, 'DOCS-THEME-030', `diagram ${k + 1} is labelled "${label}"; the nearest heading gives "${expected[k]}"`);
    });
  }

  // ---- 404
  const nf = htmlFiles.includes('404.html') ? readFileSync(join(dist, '404.html'), 'utf8') : null;
  if (nf === null) add(rel('404.html'), 0, 'DOCS-THEME-039', 'does not exist');
  else {
    const ev = tagEvents(nf);
    const nav = regionOf(ev, (e) => hasTok(e, 'VPNav'));
    const outside = (e) => !inside(e, nav);
    const h1 = regionsOf(ev, (e) => e.name === 'h1').some((r) => textOf(nf.slice(r.innerStart, r.innerEnd)).replace(/[​\s]+/g, ' ').trim() === 'Page not found');
    if (!h1) add(rel('404.html'), 0, 'DOCS-THEME-039', 'has no <h1> with the text "Page not found"');
    for (const href of ['/cohost/', '/cohost/start/what-is-cohost']) {
      if (!ev.some((e) => !e.close && e.name === 'a' && e.attrs.href === href && outside(e))) add(rel('404.html'), 0, 'DOCS-THEME-039', `has no <a href="${href}"> outside the nav bar`);
    }
    if (!ev.some((e) => !e.close && hasTok(e, 'cohost-aside'))) add(rel('404.html'), 0, 'DOCS-THEME-039', 'has no element with the class cohost-aside');
    const lost = ev.filter((e) => !e.close && e.name === 'svg' && hasTok(e, 'cohost-mark') && e.attrs['data-expression'] === 'lost' && outside(e));
    if (!lost.length) add(rel('404.html'), 0, 'DOCS-THEME-039', 'has no <svg class="cohost-mark" data-expression="lost" role="img"> outside the nav bar');
    else if (!lost.some((e) => e.attrs.role === 'img')) add(rel('404.html'), 0, 'DOCS-THEME-039', 'the lost mark must carry role="img"');
  }
}

// ---------------------------------------------------------------------------------------------------- served by the dashboard

const LIVE_VUE_REL = `${THEME_DIR}components/LiveHealth.vue`;
const LIVE_MJS_REL = `${THEME_DIR}live-health.mjs`;
const HEALTH_REL = 'docs/guide/operate/health.md';
const HEALTH_DIST = 'guide/operate/health.html';
const LIVE_NOTE = 'Live data shows here when you open these docs from your dashboard.';

/** The string literals of JavaScript source, comments skipped: [{text, line}]. Regular-expression literals are not recognised. */
function stringLiterals(code) {
  const out = [];
  let i = 0;
  let line = 1;
  while (i < code.length) {
    const c = code[i];
    if (c === '\n') {
      line++;
      i++;
    } else if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      for (; i < stop; i++) if (code[i] === '\n') line++;
    } else if (c === "'" || c === '"' || c === '`') {
      const start = line;
      let text = '';
      i++;
      while (i < code.length && code[i] !== c) {
        if (code[i] === '\\') {
          text += code[i + 1] ?? '';
          if (code[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        if (code[i] === '\n') {
          line++;
          if (c !== '`') break;
        }
        text += code[i++];
      }
      i++;
      out.push({ text, line: start });
    } else i++;
  }
  return out;
}

/** The text between the `{` that opens the body of the function `name` and its closing `}`, or null. */
function functionBody(text, name) {
  const at = text.search(new RegExp(`\\b${name}\\b`));
  if (at === -1) return null;
  const skip = (from, open, close) => {
    let depth = 0;
    for (let k = from; k < text.length; k++) {
      if (text[k] === open) depth++;
      else if (text[k] === close && --depth === 0) return k;
    }
    return -1;
  };
  const p = text.indexOf('(', at);
  if (p === -1) return null;
  const pe = skip(p, '(', ')');
  if (pe === -1) return null;
  const b = /^\s*(?:=>\s*)?\{/.exec(text.slice(pe + 1));
  if (!b) return null;
  const open = pe + 1 + b[0].length - 1;
  const close = skip(open, '{', '}');
  return close === -1 ? null : text.slice(open + 1, close);
}

/**
 * The live health component's source checks.
 * @spec DOCS-LIVE-001, DOCS-LIVE-002, DOCS-LIVE-011, DOCS-LIVE-013
 */
function liveHealthSourceChecks(root, add) {
  // ---- registration
  const entry = readIf(join(root, `${THEME_DIR}index.ts`));
  const vue = readIf(join(root, LIVE_VUE_REL));
  if (vue === null) add(LIVE_VUE_REL, 0, 'DOCS-LIVE-001', 'does not exist; the theme registers the component LiveHealth from ./components/LiveHealth.vue');
  if (entry !== null) {
    const F = `${THEME_DIR}index.ts`;
    const imp = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])\.\/components\/LiveHealth\.vue\2/.exec(entry);
    if (!imp) add(F, 0, 'DOCS-LIVE-001', "must import the component from './components/LiveHealth.vue'");
    const body = functionBody(entry, 'enhanceApp');
    if (body === null) add(F, 0, 'DOCS-LIVE-001', 'must define enhanceApp and register the component LiveHealth in it');
    else {
      const reg = /\.component\(\s*(['"])LiveHealth\1\s*,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(body);
      if (!reg) add(F, 0, 'DOCS-LIVE-001', "enhanceApp must register the component globally under the name LiveHealth (app.component('LiveHealth', ...))");
      else if (imp && reg[2] !== imp[1]) add(F, 0, 'DOCS-LIVE-001', `enhanceApp registers ${reg[2]} as LiveHealth, not the component imported from ./components/LiveHealth.vue (${imp[1]})`);
    }
  }

  // ---- one element on the Service health page
  const md = readIf(join(root, HEALTH_REL));
  if (md === null) add(HEALTH_REL, 0, 'DOCS-LIVE-002', 'does not exist; it holds the one <LiveHealth /> element');
  else {
    const prose = analyze(md).plain.map((l) => l.text).join('\n').replace(/(`+)[\s\S]*?[^`]\1(?!`)/g, ' ');
    const n = [...prose.matchAll(/<LiveHealth(?=[\s/>])[^>]*>/g)].length;
    if (n !== 1) add(HEALTH_REL, 0, 'DOCS-LIVE-002', `holds ${n} LiveHealth elements outside fenced code; it needs exactly one`);
  }

  // ---- no style block, no animation or transition
  if (vue !== null && /<style\b/i.test(vue)) add(LIVE_VUE_REL, 0, 'DOCS-LIVE-011', 'has a <style> block; the component is styled in style.css');
  const css = indexCss([[TOKENS_REL, readIf(join(root, TOKENS_REL))], [STYLE_REL, readIf(join(root, STYLE_REL))]]);
  for (const r of css) {
    if (r.block.prelude.startsWith('@') || !r.block.prelude.includes('.cohost-live-health')) continue;
    for (const d of r.block.decls) if (/^(?:animation|transition)/.test(d.prop)) add(r.file, d.line, 'DOCS-LIVE-011', `${ws(r.block.prelude)} declares ${d.prop}; .cohost-live-health rules have no animation or transition`);
  }

  // ---- no absolute URL, no socket, the URL /services
  const mjs = readIf(join(root, LIVE_MJS_REL));
  if (mjs === null) add(LIVE_MJS_REL, 0, 'DOCS-LIVE-013', 'does not exist; the component logic is live-health.mjs');
  let named = false;
  const ABS = /^(?:https?:|\/\/)/i;
  for (const [rel, text] of [[LIVE_VUE_REL, vue], [LIVE_MJS_REL, mjs]]) {
    if (text === null) continue;
    const scripts = rel.endsWith('.vue') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]) : [text];
    for (const code of scripts) {
      for (const lit of stringLiterals(code)) {
        if (ABS.test(lit.text)) add(rel, lit.line, 'DOCS-LIVE-013', `holds the string literal "${lit.text.slice(0, 40)}", which begins with http:, https: or //; the component loads nothing absolute`);
        if (lit.text === '/services') named = true;
      }
    }
    const sock = /\b(WebSocket|EventSource)\b/.exec(text);
    if (sock) add(rel, 0, 'DOCS-LIVE-013', `refers to ${sock[1]}; the component only polls /services`);
    if (rel.endsWith('.vue')) {
      for (const e of tagEvents(text)) {
        if (e.close) continue;
        for (const [k, v] of Object.entries(e.attrs)) {
          if (ABS.test(v) || stringLiterals(v).some((l) => ABS.test(l.text))) add(rel, 0, 'DOCS-LIVE-013', `the <${e.name}> attribute ${k}="${v.slice(0, 40)}" begins with http:, https: or //`);
        }
      }
    }
  }
  if (!named && (vue !== null || mjs !== null)) add(mjs !== null ? LIVE_MJS_REL : LIVE_VUE_REL, 0, 'DOCS-LIVE-013', "no string literal '/services' in the component's files; the component names the URL /services");
}

/**
 * The built-site checks for the Service health page.
 * @spec DOCS-LIVE-003, DOCS-LIVE-012
 */
function liveHealthDistChecks(dist, add) {
  const rel = `docs/.vitepress/dist/${HEALTH_DIST}`;
  const html = readIf(join(dist, HEALTH_DIST));
  if (html === null) {
    add(rel, 0, 'DOCS-LIVE-003', 'does not exist; the built Service health page holds the cohost-live-health element');
    add(rel, 0, 'DOCS-LIVE-012', 'does not exist; the built Service health page holds the element with id the-states');
    return;
  }
  const ev = tagEvents(html);
  const regions = regionsOf(ev, (e) => hasTok(e, 'cohost-live-health'));
  if (regions.length !== 1) add(rel, 0, 'DOCS-LIVE-003', `holds ${regions.length} elements with the class cohost-live-health; it needs exactly one`);
  else {
    const r = regions[0];
    const text = textOf(html.slice(r.innerStart, r.innerEnd)).replace(/[\s​]+/g, ' ');
    if (!text.includes(LIVE_NOTE)) add(rel, 0, 'DOCS-LIVE-003', `the cohost-live-health element does not contain the note "${LIVE_NOTE}"`);
    if (ev.some((e) => !e.close && e.name === 'table' && e.index >= r.innerStart && e.index < r.innerEnd)) add(rel, 0, 'DOCS-LIVE-003', 'the built cohost-live-health element holds a <table>; it renders only the note until the browser has live data');
  }
  if (!ev.some((e) => !e.close && e.attrs.id === 'the-states')) add(rel, 0, 'DOCS-LIVE-012', 'has no element with id the-states; the dashboard links guide/operate/health#the-states');
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
