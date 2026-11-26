// @spec DOCS-LIVE-003, DOCS-LIVE-004, DOCS-LIVE-005, DOCS-LIVE-006, DOCS-LIVE-007, DOCS-LIVE-008, DOCS-LIVE-009, DOCS-LIVE-010, DOCS-LIVE-013
//
// The behaviour and the text of the live health table on the Service health page. A plain ES module with no Vue import:
// `fetch`, the timers and the document are passed in, so the node tests run it under stubs and LiveHealth.vue is only a
// view over it. Every value from the dashboard reaches the page as text, never as HTML.

export const SERVICES_URL = '/services';
export const TIMEOUT_MS = 4000;
export const INTERVAL_MS = 5000;

export const NOTE = 'Live data shows here when you open these docs from your dashboard.';
export const LIVE_TEXT = 'Live from your dashboard.';
export const STALE_TEXT = 'Not updating: the dashboard is not answering.';
export const CAPTION = 'Your services right now, from your dashboard';
export const COLUMNS = ['Service', 'State', 'Mode', 'Last heartbeat', 'Restarts'];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when an answer is usable: status 200, a JSON content type, and `services` an array of {service, state} strings. */
export function isValidAnswer({ status, contentType, body }) {
  if (status !== 200) return false;
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) return false;
  if (!isObject(body) || !Array.isArray(body.services)) return false;
  return body.services.every((s) => isObject(s) && typeof s.service === 'string' && typeof s.state === 'string');
}

/** The cell texts of one row: service, state, needs ('' when none), mode, lastHeartbeat, restarts. */
export function rowTexts(item) {
  const needs = Array.isArray(item.needs)
    ? item.needs.filter((n) => isObject(n) && typeof n.service === 'string' && typeof n.state === 'string').map((n) => `needs ${n.service} (${n.state})`)
    : [];
  const mode = isObject(item.heartbeat) && typeof item.heartbeat.mode === 'string' ? item.heartbeat.mode : '—';
  const age = item.lastSeenAgeMs;
  return {
    service: item.service,
    state: item.state,
    needs: needs.join(', '),
    mode,
    lastHeartbeat: typeof age === 'number' && Number.isFinite(age) ? `${Math.floor(age / 1000)} s ago` : 'never',
    restarts: typeof item.restarts === 'number' && Number.isFinite(item.restarts) ? String(item.restarts) : '—',
  };
}

/**
 * The request schedule. `onChange({ status, rows })` is called when there is something new to show: rows is null until
 * the first valid answer. Nothing it runs throws.
 */
export function createLiveHealth({ fetch, setTimeout, clearTimeout, document, onChange }) {
  let status = NOTE;
  let rows = null;
  let stopped = false;
  let halted = false; // the first request failed: no more requests
  let inFlight = false;
  let hasValid = false;
  let timer = null;
  let abortTimer = null;
  let controller = null;
  let listening = false;

  const emit = () => {
    try {
      onChange({ status, rows });
    } catch {
      // a view that cannot render is not the poller's problem
    }
  };
  const visible = () => document.visibilityState === 'visible';
  const clearNext = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const listen = (on) => {
    if (on === listening) return;
    listening = on;
    if (on) document.addEventListener('visibilitychange', onVisibility);
    else document.removeEventListener('visibilitychange', onVisibility);
  };

  async function ask(signal, aborted) {
    const work = (async () => {
      const res = await fetch(SERVICES_URL, { method: 'GET', cache: 'no-store', headers: { accept: 'application/json' }, signal });
      const contentType = res.headers.get('content-type');
      const body = res.status === 200 ? await res.json() : null;
      return { status: res.status, contentType, body };
    })();
    work.catch(() => {});
    return Promise.race([work, aborted]);
  }

  async function request() {
    if (stopped || halted || inFlight) return;
    clearNext();
    inFlight = true;
    const ac = new AbortController();
    controller = ac;
    const aborted = new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    aborted.catch(() => {});
    abortTimer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let answer = null;
    try {
      const got = await ask(ac.signal, aborted);
      if (isValidAnswer(got)) answer = got.body.services;
    } catch {
      answer = null;
    }
    if (abortTimer !== null) clearTimeout(abortTimer);
    abortTimer = null;
    inFlight = false;
    controller = null;
    if (stopped) return;
    if (answer !== null) {
      hasValid = true;
      status = LIVE_TEXT;
      rows = answer.map(rowTexts);
      emit();
    } else if (hasValid) {
      if (status !== STALE_TEXT) {
        status = STALE_TEXT;
        emit();
      }
    } else {
      halted = true;
      listen(false);
      return;
    }
    if (visible()) timer = setTimeout(() => { timer = null; if (visible()) void request(); }, INTERVAL_MS);
  }

  function onVisibility() {
    if (stopped || halted) return;
    if (visible()) {
      if (!inFlight) void request();
    } else clearNext();
  }

  return {
    start() {
      if (stopped) return;
      listen(true);
      if (visible()) void request();
    },
    stop() {
      stopped = true;
      clearNext();
      if (abortTimer !== null) clearTimeout(abortTimer);
      abortTimer = null;
      listen(false);
      if (controller) controller.abort();
    },
  };
}
