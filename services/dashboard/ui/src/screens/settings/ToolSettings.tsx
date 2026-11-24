// The Tools settings page's two widgets: `mcp-servers` (the `tools.servers` map) and `tool-list` (the `tools.allow` map), driven by
// the saved values of the section and the latest `tool.catalog` the page heard on the feed. Everything a server or its tools say about
// themselves (names, URLs, descriptions, detail text) is untrusted: it is rendered as React text children only, never as markup.
import { useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { Switch } from "../../components/Switch";
import { useFeed } from "../../state/hooks";
import type { CatalogServer, CatalogTool, ToolCatalog } from "../../state/tools";
import type { KeyModel, SectionModel } from "./schemaModel";
import { useSettings, type SectionState } from "./store";

type Entry = Record<string, unknown>;
type EntryMap = Record<string, Entry>;
const isObj = (v: unknown): v is Entry => typeof v === "object" && v !== null && !Array.isArray(v);
/** C0 controls and DEL: a secret is one line of printable characters (DASH-SECRET-006). */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const asMap = (v: unknown): EntryMap => (isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, e]) => [k, isObj(e) ? e : {}])) : {});

/** The map a widget shows: the staged edit when there is one, else what the file holds. */
function mapOf(st: SectionState, key: string): EntryMap {
  return asMap(st.edits[key] ? st.edits[key]!.value : st.keys[key]?.value);
}

/** The latest catalog, or null while the page has none or has heard none for three of its intervals (DASH-TOOL-023). */
function useCatalog(): ToolCatalog | null {
  const c = useFeed((f) => f.catalog);
  return c && !c.stale ? c.data : null;
}

/** The notice shown in place of states and descriptions while the tools service is silent. */
function NotRunning() {
  return (
    <div className="note note-warn small" role="note">
      <p>The tools service is not running, so servers show no state and tools no description. Your settings still save. <a href="#services">Start tools on the Services screen</a>.</p>
    </div>
  );
}

// ---- servers -------------------------------------------------------------------------------------------------------

/** Names the config grammar accepts for a server (CFG-SCH-083): a letter, then letters, digits or hyphens, at most 32. */
const SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A header name (RFC 9110 token characters); blank means Authorization. */
const HTTP_HEADER = /^(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+)?$/;
/** Query parameter names that suggest a credential (CFG-SCH-086). */
const CREDENTIAL_QUERY_NAMES = ["key", "token", "api_key", "apikey", "secret", "auth", "password", "access_token"];

interface UrlView { ok: boolean; display: string; host: string; params: string[] }
/** A saved URL as it may be shown: no userinfo, no query string, no fragment; and the names (never values) of credential-like query parameters. */
function viewUrl(raw: unknown): UrlView {
  try {
    const u = new URL(typeof raw === "string" ? raw : "");
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    const params = [...new Set([...u.searchParams.keys()].filter((k) => CREDENTIAL_QUERY_NAMES.includes(k.toLowerCase())))];
    return { ok: true, display: `${u.protocol}//${u.host}${u.pathname}`, host: u.hostname, params };
  } catch {
    return { ok: false, display: "not a valid http or https URL", host: "", params: [] };
  }
}

/** Why an add is refused on the page (nothing is written), or undefined. */
function refuseAdd(name: string, url: string, header: string, taken: string[]): string | undefined {
  if (!SERVER_NAME.test(name)) return "A server name is lower case: a letter, then letters, digits or hyphens, at most 32 characters.";
  if (taken.includes(name)) return `There is already a server named ${name}. Remove it first to replace it.`;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "Give the server's address as an http or https URL."; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Give the server's address as an http or https URL.";
  if (parsed.username !== "" || parsed.password !== "") return "The address cannot hold a user name or password: the token goes in the Token field.";
  if (!HTTP_HEADER.test(header)) return "The header name has characters a header cannot have.";
  return undefined;
}

/**
 * The MCP servers: one row per saved server (name, URL without userinfo or query, state and detail from the latest catalog, the external
 * note, advisories, the left-out count, Remove) and the add form. Adding writes the map and then the token secret; removing clears the
 * secret and then writes the map; neither probes a URL that is not saved.
 */
// @spec DASH-TOOL-006, DASH-TOOL-007, DASH-TOOL-008, DASH-TOOL-009, DASH-TOOL-010, DASH-TOOL-011, DASH-TOOL-012, DASH-TOOL-013, DASH-TOOL-023
export function McpServers({ section, km, st }: { section: SectionModel; km: KeyModel; st: SectionState }) {
  const settings = useSettings();
  const catalog = useCatalog();
  const map = mapOf(st, km.key);
  const names = Object.keys(map);
  const byName = new Map<string, CatalogServer>((catalog?.servers ?? []).map((s) => [s.name, s]));
  const nameRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const [external, setExternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>();
  const [secretFailure, setSecretFailure] = useState<{ message: string; detail: string } | undefined>();

  const current = (): SectionState => settings.state.get().sections[section.path] ?? st;
  const saved = (): boolean => settings.state.get().bars[section.path]?.kind === "ok";

  // @spec DASH-TOOL-007
  const add = async (): Promise<void> => {
    const name = nameRef.current?.value.trim() ?? "";
    const url = urlRef.current?.value.trim() ?? "";
    const header = headerRef.current?.value.trim() ?? "";
    const token = tokenRef.current?.value ?? "";
    setSecretFailure(undefined);
    const taken = Object.keys(mapOf(current(), km.key));
    const why = refuseAdd(name, url, header, taken);
    if (why) { setRefusal(why); return; }
    if (CONTROL_CHARS.test(token.trim())) { setRefusal("The token must be a single line of printable characters."); return; }
    setRefusal(undefined); setBusy(true);
    // A token already stored under this name would be merged into the new server: it is cleared first, a clear always works (DASH-TOOL-007).
    const cleared = await settings.setSecrets(section.path, { [`servers.${name}.token`]: null }, `Clear a stored token of ${name}`);
    if (!cleared.ok) { setRefusal(`Could not clear the token stored under ${name}, so the server was not added: ${cleared.detail}`); setBusy(false); return; }
    settings.edit(section.path, km.key, { ...mapOf(current(), km.key), [name]: { url, ...(header ? { header } : {}), ...(external ? { external: true } : {}) } });
    await settings.run([section.path], false);
    if (!saved()) { settings.revert(section.path, km.key); setBusy(false); return; } // the bar names the failure; no secret is stored for a server the file does not hold
    if (token !== "") {
      const r = await settings.setSecrets(section.path, { [`servers.${name}.token`]: token }, `Set ${section.path}.servers.${name}.token`);
      if (!r.ok) setSecretFailure({ message: "server added without a token", detail: r.detail });
    }
    for (const r of [nameRef, urlRef, headerRef, tokenRef]) if (r.current) r.current.value = "";
    setExternal(false); setBusy(false);
  };

  // @spec DASH-TOOL-009
  const remove = async (name: string): Promise<void> => {
    setBusy(true); setRefusal(undefined); setSecretFailure(undefined);
    const tokenKey = `servers.${name}.token`;
    // Always: a token the page does not show as set may still be in secrets.yaml, and a later server of this name would take it (DASH-TOOL-009).
    const r = await settings.setSecrets(section.path, { [tokenKey]: null }, `Clear ${section.path}.${tokenKey}`);
    if (!r.ok) { setRefusal(`Could not clear the token of ${name}, so the server stays: ${r.detail}`); setBusy(false); return; }
    const { [name]: _gone, ...rest } = mapOf(current(), km.key);
    settings.edit(section.path, km.key, rest);
    await settings.run([section.path], false);
    if (!saved()) settings.revert(section.path, km.key); // the bar names the failure
    setBusy(false);
  };

  return (
    <div className="tool-servers stack-y">
      <p className="help">{km.help}</p>
      <p className="help">Cohost cannot see what a server on the LAN itself sends on.</p>
      {catalog === null ? <NotRunning /> : null}
      {names.length === 0 ? <p className="muted small">No servers yet. Add one below.</p> : null}
      {names.map((name) => {
        const entry = map[name]!;
        const view = viewUrl(entry.url);
        const cs = byName.get(name);
        const isExternal = cs ? cs.external : entry.external === true;
        const header = typeof entry.header === "string" ? entry.header : "";
        const tokenSet = st.keys[`servers.${name}.token`]?.set === true;
        return (
          <div className="tool-server" data-server={name} key={name}>
            <div className="tool-server-h">
              <span className="mono tool-name">{name}</span>
              <span className="mono small wrap">{view.display}</span>
              <Button variant="danger" size="sm" aria-label={`Remove ${name}`} disabled={busy} onClick={() => void remove(name)}>Remove</Button>
            </div>
            <p className="small muted">{[header ? `header ${header}` : "", tokenSet ? "token set" : "no token"].filter((x) => x !== "").join(" · ")}</p>
            {cs ? <p className="small"><span className="tag">{cs.state}</span>{cs.detail ? ` ${cs.detail}` : ""}</p> : null}
            {isExternal && view.host ? <p className="small">{`tool requests go to ${view.host}`}</p> : null}
            {cs && cs.leftOut > 0 ? <p className="small muted">{`${cs.leftOut} left out`}</p> : null}
            {view.params.map((p) => <p className="small note note-warn" key={p}>{`The address has a query parameter named ${p}. A secret belongs in the header, not the address.`}</p>)}
          </div>
        );
      })}
      <div className="tool-add stack-y">
        <h3>Add a server</h3>
        <form className="stack-y" onSubmit={(e) => { e.preventDefault(); if (!busy) void add(); }}>
          <Labelled label="Name" help="Lower case: a letter, then letters, digits or hyphens.">{(id) => <input id={id} ref={nameRef} className="field" type="text" autoComplete="off" spellCheck={false} />}</Labelled>
          <Labelled label="URL" help="An http or https address, with no user name or password.">{(id) => <input id={id} ref={urlRef} className="field" type="text" autoComplete="off" spellCheck={false} />}</Labelled>
          <Labelled label="Header name" help="The header the token is sent in; leave it empty for Authorization.">{(id) => <input id={id} ref={headerRef} className="field" type="text" autoComplete="off" spellCheck={false} />}</Labelled>
          <Labelled label="Token" help="Kept in secrets.yaml and never shown again. Leave it empty for a server that needs none.">{(id) => <input id={id} ref={tokenRef} className="field" type="password" autoComplete="off" spellCheck={false} />}</Labelled>
          <Switch label="External" checked={external} onChange={setExternal} />
          <p className="help">Mark a server External to treat it as off the LAN whatever its address. Its tools appear only after tools has restarted and connected.</p>
          <div><Button variant="primary" type="submit" busy={busy}>Add server</Button></div>
        </form>
        {refusal ? <div className="action-error" role="alert"><span>{refusal}</span></div> : null}
        {secretFailure ? <div className="action-error" role="alert"><span>{secretFailure.message}</span><span className="small muted">{` ${secretFailure.detail}`}</span></div> : null}
      </div>
    </div>
  );
}

function Labelled({ label, help, children }: { label: string; help: string; children: (id: string) => ReactNode }) {
  const id = useRef(`tool-add-${label.toLowerCase().replace(/\W+/g, "-")}`).current;
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      {children(id)}
      <p className="help">{help}</p>
    </div>
  );
}

// ---- tools ---------------------------------------------------------------------------------------------------------

const BUILT_IN = "Built in";
const LABELS: Record<CatalogTool["label"], string> = { read: "Read only", acts: "Changes things", unlabelled: "Not labelled by the server" };

/** The entry's mark as the catalog reports it, to say where the saved mark will differ until tools restarts (DASH-TOOL-021). */
function marksDiffer(e: Entry, t: CatalogTool): boolean {
  return (e.acts === true) !== t.acts || (e.chat === true) !== t.chat || (e.confirm !== false) !== t.confirm;
}

interface Row {
  name: string;
  tool?: CatalogTool;
  entry: Entry;
  group: string;
}

/**
 * The tools of the catalog, grouped under their server or Built in, each with its name, description, label badge and the switches
 * that write its `tools.allow` entry; then the entries that name no listed tool. Without a catalog (none yet, or none for three of its
 * intervals) the saved entries are listed from the file alone, every switch still editable.
 */
// @spec DASH-TOOL-014, DASH-TOOL-015, DASH-TOOL-016, DASH-TOOL-017, DASH-TOOL-018, DASH-TOOL-019, DASH-TOOL-020, DASH-TOOL-021, DASH-TOOL-022, DASH-TOOL-023, DASH-TOOL-025
export function ToolList({ section, km, st }: { section: SectionModel; km: KeyModel; st: SectionState }) {
  const settings = useSettings();
  const catalog = useCatalog();
  const allow = mapOf(st, km.key);
  const servers = Object.keys(mapOf(st, "servers"));
  const write = (name: string, patch: Entry): void => settings.edit(section.path, km.key, { ...allow, [name]: { ...(allow[name] ?? {}), ...patch } });
  const drop = (name: string): void => { const { [name]: _gone, ...rest } = allow; settings.edit(section.path, km.key, rest); };

  const listed: Row[] = catalog
    ? catalog.tools.map((t) => ({ name: t.name, tool: t, entry: allow[t.name] ?? {}, group: t.server ?? BUILT_IN }))
    : Object.keys(allow).map((name) => {
      const head = name.includes("__") ? name.slice(0, name.indexOf("__")) : "";
      return { name, entry: allow[name]!, group: servers.includes(head) ? head : BUILT_IN };
    });
  const unlisted: Row[] = catalog ? Object.keys(allow).filter((n) => !catalog.tools.some((t) => t.name === n)).map((name) => ({ name, entry: allow[name]!, group: "" })) : [];
  const groups = [...new Set(listed.map((r) => r.group))];

  return (
    <div className="tool-list stack-y">
      <p className="help">{km.help}</p>
      <p className="help">Ask me before it runs: a listed source covers everyone who speaks through it, a listed Discord source including guests in that channel.</p>
      {catalog === null ? <p className="small muted">The tools service is not running, so these tools are listed from your saved settings, without descriptions.</p> : null}
      {groups.map((g) => (
        <section className="tool-group" data-tool-group={g} aria-label={g} key={g}>
          <h3>{g}</h3>
          {listed.filter((r) => r.group === g).map((r) => <ToolRow key={r.name} row={r} write={write} />)}
        </section>
      ))}
      {unlisted.length > 0 ? (
        <section className="tool-group" aria-label="Entries with no tool">
          <h3>Not listed</h3>
          {unlisted.map((r) => (
            <div className="tool-row" data-tool={r.name} key={r.name}>
              <div className="tool-row-h">
                <span className="mono tool-name">{r.name}</span>
                <span className="tag">Not found on any server</span>
                <Button variant="danger" size="sm" aria-label={`Remove ${r.name}`} onClick={() => drop(r.name)}>Remove</Button>
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function ToolRow({ row, write }: { row: Row; write: (name: string, patch: Entry) => void }) {
  const { name, tool: t, entry: e } = row;
  // An approval made in this unsaved edit counts: the entry pins the definition the owner saw (DASH-TOOL-016) before the catalog reflects the save.
  const approved = t?.hash !== undefined && e.hash === t.hash;
  const approvalNeeded = !approved && (t?.reason === "changed" || t?.reason === "not_approved");
  const enabled = e.enabled === true && !approvalNeeded;
  const acts = enabled && e.acts === true;
  const chat = enabled && e.chat === true;
  const acting = t ? (t.effect === "acts" || e.acts === true) : e.acts === true;
  const askable = acting && !(name === "timer" && t?.server === undefined);
  const confirmOn = enabled && e.confirm !== false;
  const pin = t?.server !== undefined && t.hash !== undefined ? { hash: t.hash } : {};
  return (
    <div className="tool-row" data-tool={name}>
      <div className="tool-row-h">
        <span className="mono tool-name">{name}</span>
        {t ? <span className={`tag${t.label === "read" ? "" : " tag-warn"}`} title="As the server describes it">{LABELS[t.label]}</span> : null}
      </div>
      {t && t.description ? <p className="small tool-desc">{t.description}</p> : null}
      {approvalNeeded && t?.reason === "changed" ? <p className="small note note-warn">Changed since you approved it. It stays off until you allow it again.</p> : null}
      {approvalNeeded && t?.reason === "not_approved" ? <p className="small note note-warn">Not approved yet.</p> : null}
      {t?.reason === "server_down" ? <p className="small muted">Its server is down, so the tool cannot run.</p> : null}
      {t && e.enabled === true && t.label !== "read" && e.acts !== true ? <p className="small note note-warn">Not offered to the co-host until you allow it to act.</p> : null}
      {t && marksDiffer(e, t) ? <p className="small muted">Applies when tools restarts.</p> : null}
      <div className="tool-switches">
        <Switch label="Allowed" checked={enabled} onChange={(v) => write(name, v ? { enabled: true, ...pin } : { enabled: false, acts: false, chat: false })} />
        <Switch label="May act" checked={acts} disabled={!enabled} onChange={(v) => write(name, v ? { acts: true, chat: false } : { acts: false })} />
        <Switch label="Usable for viewer chat" checked={chat} disabled={!enabled} onChange={(v) => write(name, v ? { chat: true, acts: false } : { chat: false })} />
        {askable ? <Switch label="Ask me before it runs" checked={confirmOn} disabled={!enabled} onChange={(v) => write(name, { confirm: v })} /> : null}
      </div>
      {acts ? <p className="small muted">May act makes the tool count as acting, whatever its server claims, and it cannot be on together with Usable for viewer chat.</p> : null}
      {askable ? <p className="small muted">Turning off Ask me before it runs applies only to the dashboard and to speech from a source listed in tools.owner_sources, and only for the first tool round of a reply.</p> : null}
    </div>
  );
}
