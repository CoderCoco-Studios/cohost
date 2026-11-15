// @spec DOCS-THEME-025, DOCS-THEME-027, DOCS-THEME-028, DOCS-THEME-029, DOCS-THEME-030
// markdown-it plugin: a fenced code block with language `mermaid` is rendered at build time to inline SVG by
// `beautiful-mermaid` and wrapped in <figure class="cohost-diagram" tabindex="0">. Nothing Mermaid-related runs in the
// reader's browser. A fence the renderer cannot parse fails the build, naming the source file and the fence's line.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMermaidSVG } from 'beautiful-mermaid';

// The palette as CSS variable references, so one rendered diagram follows light and dark mode.
export const MERMAID_OPTIONS = {
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Removes every `@import` rule (the renderer adds one for a hosted web font) from the SVG's <style>. */
export function stripImports(svg) {
  return svg.replace(/@import\s+(?:url\([^)]*\)|'[^']*'|"[^"]*")[^;]*;\s*/g, '');
}

/** Plain text of a heading: inline markup and a trailing `{#id}` removed. */
export function headingText(raw) {
  return raw
    .replace(/\s*\{#[^}]*\}\s*$/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The nearest heading before token `idx`, as plain text, or null. */
function nearestHeading(tokens, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    if (tokens[i].type === 'heading_open') {
      const inline = tokens[i + 1];
      const text = inline && inline.type === 'inline' ? headingText(inline.content) : '';
      return text || null;
    }
  }
  return null;
}

/** The repo-relative file a page is rendered from: the excerpt's "Source:" file, else the markdown file itself. */
function sourceFile(env, src) {
  const m = /^Source: \[`([^`]+)`\]/m.exec(src || '');
  if (m) return { rel: m[1], abs: join(REPO_ROOT, m[1]) };
  if (env && typeof env.path === 'string' && existsSync(env.path)) {
    const rel = env.path.startsWith(REPO_ROOT) ? env.path.slice(REPO_ROOT.length + 1) : env.path;
    return { rel, abs: env.path };
  }
  return null;
}

/** 1-based line of the opening fence of the `nth` mermaid fence in `file` whose body is `body`. */
function fenceLine(file, body, nth) {
  try {
    const lines = readFileSync(file.abs, 'utf8').split('\n');
    const bodyLines = body.replace(/\n$/, '').split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*(`{3,}|~{3,})\s*mermaid\b/.test(lines[i])) continue;
      if (bodyLines.every((l, k) => (lines[i + 1 + k] ?? '').trim() === l.trim())) hits.push(i + 1);
    }
    return hits[nth] ?? hits[0] ?? null;
  } catch {
    return null;
  }
}

function frontmatterTitle(env, src) {
  const fm = env && env.frontmatter;
  if (fm && typeof fm.title === 'string' && fm.title) return fm.title;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src || '');
  const t = m && /^title:\s*(.+)$/m.exec(m[1]);
  return t ? t[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
}

export function mermaidFence(md) {
  // markdown-it hands the fence renderer no source text, so keep it per render for locating the fence.
  md.core.ruler.push('cohost_mermaid_src', (state) => {
    state.env.__cohostSrc = state.src;
    state.env.__cohostMermaidSeen = {};
  });

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0];
    if (lang !== 'mermaid') return defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);

    const src = env.__cohostSrc || '';
    const seen = env.__cohostMermaidSeen || (env.__cohostMermaidSeen = {});
    const nth = (seen[token.content] = (seen[token.content] ?? -1) + 1);
    const file = sourceFile(env, src);
    let svg;
    try {
      svg = renderMermaidSVG(token.content, MERMAID_OPTIONS);
    } catch (e) {
      const line = file ? fenceLine(file, token.content, nth) : null;
      const where = file ? `${file.rel}${line ? `:${line}` : ''}` : String(env.relativePath || 'unknown page');
      throw new Error(`${where}: cannot render the mermaid diagram: ${String(e && e.message).split('\n')[0]}`);
    }
    const label = `Diagram: ${nearestHeading(tokens, idx) ?? frontmatterTitle(env, src)}`;
    const labelled = stripImports(svg).replace(/^<svg\b/, `<svg role="img" aria-label="${md.utils.escapeHtml(label)}"`);
    return `<figure class="cohost-diagram" tabindex="0">${labelled}</figure>\n`;
  };
}
