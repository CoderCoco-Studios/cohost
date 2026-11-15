// @spec DOCS-THEME-033
// markdown-it plugin for the home page flow: `::: flow` ... `:::` renders its content (parsed as markdown) in
// <div class="cohost-flow">. The same block-rule shape as aside-container.mjs, fixed to this one container.
const OPEN = 'container_flow_open';
const CLOSE = 'container_flow_close';

export function flowContainer(md) {
  function rule(state, startLine, endLine, silent) {
    const first = state.bMarks[startLine] + state.tShift[startLine];
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const m = /^(:{3,})\s*flow\s*$/.exec(state.src.slice(first, state.eMarks[startLine]));
    if (!m) return false;
    if (silent) return true;

    let nextLine = startLine;
    let closed = false;
    while (++nextLine < endLine) {
      const pos = state.bMarks[nextLine] + state.tShift[nextLine];
      const max = state.eMarks[nextLine];
      if (pos < max && state.sCount[nextLine] < state.blkIndent) break;
      const c = /^(:{3,})\s*$/.exec(state.src.slice(pos, max));
      if (c && c[1].length >= m[1].length && state.sCount[nextLine] - state.blkIndent < 4) {
        closed = true;
        break;
      }
    }

    const oldParent = state.parentType;
    const oldLineMax = state.lineMax;
    state.parentType = 'container';
    state.lineMax = nextLine;
    const open = state.push(OPEN, 'div', 1);
    open.markup = m[1];
    open.block = true;
    open.info = 'flow';
    open.map = [startLine, nextLine];
    state.md.block.tokenize(state, startLine + 1, nextLine);
    const close = state.push(CLOSE, 'div', -1);
    close.markup = m[1];
    close.block = true;
    state.parentType = oldParent;
    state.lineMax = oldLineMax;
    state.line = nextLine + (closed ? 1 : 0);
    return true;
  }

  md.block.ruler.before('fence', 'container_flow', rule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules[OPEN] = () => '<div class="cohost-flow">\n';
  md.renderer.rules[CLOSE] = () => '</div>\n';
}
