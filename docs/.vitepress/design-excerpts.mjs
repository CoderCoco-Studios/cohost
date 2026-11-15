// Build-time loaders for the architecture section: excerpts of the HLD, each leaf LLD's Context and Design
// Philosophy, and the current decision documents. Nothing here writes a file; the `*.paths.mjs` loaders under
// docs/advanced/architecture/ hand these pages to VitePress dynamic routes, and sidebar.mjs and the docs check
// call the same functions so the three always agree.
//
// @spec DOCS-ARCH-001, DOCS-ARCH-002, DOCS-ARCH-003, DOCS-ARCH-004, DOCS-ARCH-005, DOCS-ARCH-006, DOCS-ARCH-007, DOCS-ARCH-008, DOCS-ARCH-010
//
// Every failure throws an Error whose message starts with the repo-relative path of the file at fault.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GITHUB = 'https://github.com/CoderCoco-Studios/cohost';

const HLD_PATH = 'docs/high-level-design.md';
const HLD_SECTIONS = [
  { heading: 'Problem', slug: 'problem', title: 'Problem' },
  { heading: 'Approach', slug: 'approach', title: 'Approach' },
  { heading: 'Tenets', slug: 'tenets', title: 'Tenets' },
  { heading: 'System Design', slug: 'system-design', title: 'System design' },
  { heading: 'Key Design Decisions', slug: 'key-decisions', title: 'Key design decisions' },
];
const CONTEXT_HEADING = 'Context and Design Philosophy';

/** Resolves `yaml` from the workspace (packages/config depends on it), wherever this module is bundled or run. */
function loadYaml() {
  const candidates = [];
  try {
    candidates.push(fileURLToPath(new URL('../../packages/config/package.json', import.meta.url)));
  } catch {
    // import.meta.url unavailable: fall through to cwd
  }
  candidates.push(join(process.cwd(), 'packages/config/package.json'));
  for (const c of candidates) {
    try {
      return createRequire(c)('yaml');
    } catch {
      // try the next candidate
    }
  }
  throw new Error('docs/.vitepress/design-excerpts.mjs: cannot load the workspace "yaml" package (run pnpm install)');
}
let yamlModule;
/** Parses YAML text with the workspace's parser. */
export function parseYaml(text) {
  yamlModule ??= loadYaml();
  return yamlModule.parse(text);
}

/** Reads a repo file as text, failing with the file's path. */
function readText(repoRoot, rel) {
  try {
    return readFileSync(join(repoRoot, rel), 'utf8');
  } catch (e) {
    throw new Error(`${rel}: cannot read: ${e.message}`);
  }
}

/** Splits `---` frontmatter from a document. Throws (naming `rel`) when it is unterminated or not valid YAML. */
export function splitFrontmatter(text, rel) {
  const src = text.replace(/\r\n/g, '\n');
  if (!/^---[ \t]*\n/.test(src)) return { data: {}, body: src };
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) throw new Error(`${rel}: frontmatter is not closed by a --- line`);
  let data;
  try {
    data = parseYaml(m[1]) ?? {};
  } catch (e) {
    throw new Error(`${rel}: cannot parse frontmatter: ${String(e.message).split('\n')[0]}`);
  }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error(`${rel}: frontmatter is not a mapping`);
  return { data, body: src.slice(m[0].length) };
}

/** Index ranges of the lines outside fenced code blocks, as a Set of line numbers that are inside a fence. */
function fencedLines(lines) {
  const inside = new Set();
  let fence = null;
  lines.forEach((line, i) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      inside.add(i);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^\s{0,3}(`+|~+)\s*$/.test(line)) fence = null;
    } else if (m) {
      fence = m[1];
      inside.add(i);
    }
  });
  return inside;
}

/** The text of the `## heading` section, from its heading up to the next `##` heading; null when absent. */
export function extractSection(body, heading) {
  const lines = body.split('\n');
  const fenced = fencedLines(lines);
  const isH2 = (i) => !fenced.has(i) && /^## (?!#)/.test(lines[i]);
  const start = lines.findIndex((l, i) => isH2(i) && l.slice(3).trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isH2(i)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

/** Rows of the HLD `### Segments` table: [{ taxonomy, segment, role }]. */
function parseSegmentsTable(hldBody) {
  const lines = hldBody.split('\n');
  const fenced = fencedLines(lines);
  const at = lines.findIndex((l, i) => !fenced.has(i) && /^### Segments\s*$/.test(l));
  if (at === -1) throw new Error(`${HLD_PATH}: no "### Segments" table`);
  const rows = [];
  let header = null;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) {
      if (header) break;
      continue;
    }
    const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const col = (name) => cells[header.findIndex((h) => h.startsWith(name))] ?? '';
    rows.push({ taxonomy: col('taxonomy'), segment: col('segment').replace(/`/g, ''), role: col('role').replace(/`/g, '') });
  }
  if (!rows.length) throw new Error(`${HLD_PATH}: the "### Segments" table has no rows`);
  return rows;
}

/** Rewrites relative markdown links in `text` (from repo file `sourceRel`) to GitHub URLs, fragments kept. */
export function rewriteLinks(text, sourceRel, repoRoot) {
  const dir = posix.dirname(sourceRel);
  const rewrite = (href) => {
    if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(href)) return href;
    const hash = href.indexOf('#');
    const pathPart = hash === -1 ? href : href.slice(0, hash);
    const frag = hash === -1 ? '' : href.slice(hash);
    const target = pathPart === '' ? sourceRel : posix.normalize(posix.join(dir, pathPart));
    let isDir = pathPart.endsWith('/');
    if (!isDir) {
      try {
        isDir = statSync(join(repoRoot, target)).isDirectory();
      } catch {
        // missing target: treated as a file; the docs check reports it
      }
    }
    return `${GITHUB}/${isDir ? 'tree' : 'blob'}/main/${target}${frag}`;
  };
  const inline = (segment) =>
    segment
      .replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_m, open, href, close) => open + rewrite(href) + close)
      .replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/, (_m, open, href) => open + rewrite(href));
  const lines = text.split('\n');
  const fenced = fencedLines(lines);
  return lines
    .map((line, i) => {
      if (fenced.has(i)) return line;
      // leave code spans alone: only odd-numbered split parts are spans
      return line
        .split(/((`+)[\s\S]*?\2)/)
        .map((part, k, parts) => (k % 3 === 0 ? inline(part) : k % 3 === 1 ? part : parts[k] && undefined))
        .filter((p) => p !== undefined)
        .join('');
    })
    .join('\n');
}

function frontmatterBlock(title, description) {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\ntrack: advanced\n---\n`;
}

/** Page content: frontmatter, the source line, then the excerpt with Vue interpolation off. */
function pageContent({ title, description, source, body, h1 }) {
  const sourceLine = `Source: [\`${source}\`](${GITHUB}/blob/main/${source}). This page is an excerpt; the full document is there.`;
  const heading = h1 ? `# ${title}\n\n` : '';
  return `${frontmatterBlock(title, description)}\n${sourceLine}\n\n${heading}::: v-pre\n${body.trim()}\n:::\n`;
}

function listMd(repoRoot, relDir) {
  const abs = join(repoRoot, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => `${relDir}/${d.name}`)
    .sort();
}

/**
 * Loads every design-excerpt page from the repository at `repoRoot`:
 * `{ design, segments, decisions, pages }`, each page `{ route, slug, title, description, track, source, content }`
 * (segments also carry `taxonomy`). Throws, naming the file, on any design-tree inconsistency.
 */
export function loadDesign(repoRoot) {
  const root = resolve(repoRoot);
  const hldText = readText(root, HLD_PATH);
  const hld = splitFrontmatter(hldText, HLD_PATH).body;

  const design = HLD_SECTIONS.map((s) => {
    const section = extractSection(hld, s.heading);
    if (section === null) throw new Error(`${HLD_PATH}: missing the "## ${s.heading}" section`);
    const body = rewriteLinks(section, HLD_PATH, root);
    const title = s.title;
    const description = `The HLD's ${s.heading} section, shown as written.`;
    return {
      route: `advanced/architecture/design/${s.slug}`, slug: s.slug, title, description, track: 'advanced', source: HLD_PATH,
      content: pageContent({ title, description, source: HLD_PATH, body }),
    };
  });

  const table = parseSegmentsTable(hld);
  const intentDir = join(root, 'docs/intent');
  const leaves = existsSync(intentDir)
    ? readdirSync(intentDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(intentDir, d.name, `${d.name}-design.md`)) && existsSync(join(intentDir, d.name, `${d.name}-specs.md`)))
        .map((d) => d.name)
        .sort()
    : [];
  const tableNames = table.map((r) => r.segment);
  for (const n of leaves) if (!tableNames.includes(n)) throw new Error(`${HLD_PATH}: the Segments table does not list the leaf LLD "${n}" (docs/intent/${n}/${n}-design.md)`);
  for (const n of tableNames) if (!leaves.includes(n)) throw new Error(`${HLD_PATH}: the Segments table lists "${n}" but there is no leaf LLD docs/intent/${n}/${n}-design.md with ${n}-specs.md`);

  const segments = table.map((row) => {
    const source = `docs/intent/${row.segment}/${row.segment}-design.md`;
    const body = splitFrontmatter(readText(root, source), source).body;
    const section = extractSection(body, CONTEXT_HEADING);
    if (section === null) throw new Error(`${source}: missing the "## ${CONTEXT_HEADING}" section`);
    return {
      route: `advanced/architecture/segments/${row.segment}`, slug: row.segment, taxonomy: row.taxonomy, title: row.segment,
      description: row.role, track: 'advanced', source,
      content: pageContent({ title: row.segment, description: row.role, source, body: rewriteLinks(section, source, root), h1: true }),
    };
  });

  const decisionFiles = [...listMd(root, 'docs/decisions')];
  if (existsSync(intentDir)) {
    for (const d of readdirSync(intentDir, { withFileTypes: true })) {
      if (d.isDirectory()) decisionFiles.push(...listMd(root, `docs/intent/${d.name}/decisions`));
    }
  }
  const bySlug = new Map();
  const docs = decisionFiles.map((rel) => {
    const slug = posix.basename(rel, '.md');
    if (bySlug.has(slug)) throw new Error(`${rel}: decision documents must have unique names; ${bySlug.get(slug)} has the same name`);
    bySlug.set(slug, rel);
    return { rel, slug, ...splitFrontmatter(readText(root, rel), rel) };
  });
  const superseded = new Set();
  for (const doc of docs) {
    const raw = doc.data.supersedes;
    if (raw === undefined || raw === null) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const entry of list) {
      if (typeof entry !== 'string') throw new Error(`${doc.rel}: supersedes must be a path or a list of paths`);
      const target = posix.normalize(posix.join(posix.dirname(doc.rel), entry));
      if (!existsSync(join(root, target)) || !statSync(join(root, target)).isFile()) throw new Error(`${doc.rel}: supersedes names ${entry}, which is no file`);
      superseded.add(target);
    }
  }
  const decisions = docs
    .filter((doc) => !superseded.has(doc.rel))
    .map((doc) => {
      const h1 = /^# (.+)$/m.exec(doc.body);
      const title = (h1 ? h1[1].trim() : doc.slug).replace(/^Decision:\s*/i, '') || doc.slug;
      const description = `Design decision: ${title}`;
      return {
        route: `advanced/architecture/decisions/${doc.slug}`, slug: doc.slug, title, description, track: 'advanced', source: doc.rel,
        content: pageContent({ title, description, source: doc.rel, body: rewriteLinks(doc.body, doc.rel, root) }),
      };
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  return { design, segments, decisions, pages: [...design, ...segments, ...decisions] };
}

/** The `{ params, content }` entries a dynamic route's `paths()` returns for one page kind. */
export function routePaths(repoRoot, kind, param) {
  return loadDesign(repoRoot)[kind].map((p) => ({ params: { [param]: p.slug }, content: p.content }));
}

/** The repository root, from this module's location (docs/.vitepress/ -> repo root), falling back to the cwd. */
export function defaultRepoRoot() {
  try {
    const r = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    if (existsSync(join(r, HLD_PATH))) return r;
  } catch {
    // fall through
  }
  return process.cwd();
}

/** The sidebar items of the Architecture group below "Reading the design": Design, Segments (by taxonomy), Decisions. */
export function architectureSidebar(repoRoot) {
  const { design, segments, decisions } = loadDesign(repoRoot);
  const link = (p) => ({ text: p.title, link: `/${p.route}` });
  const taxonomies = [...new Set(segments.map((s) => s.taxonomy))];
  return [
    { text: 'Reading the design', link: '/advanced/architecture/' },
    { text: 'Design', collapsed: true, items: design.map(link) },
    {
      text: 'Segments',
      collapsed: true,
      items: taxonomies.map((t) => ({ text: t, collapsed: true, items: segments.filter((s) => s.taxonomy === t).map(link) })),
    },
    { text: 'Decisions', collapsed: true, items: decisions.map(link) },
  ];
}
