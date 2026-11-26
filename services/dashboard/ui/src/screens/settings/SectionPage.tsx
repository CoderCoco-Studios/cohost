import { useEffect, useId } from "react";
import { PageHeading } from "../../components/PageHeading";
import { ErrorState, LoadingState } from "../../components/StateBlocks";
import { FieldControl, isEmbedded, isLabelable, type Wiring } from "./controls";
import { usePickLists } from "./picklists";
import { RowShell } from "./RowShell";
import { AvatarRenderer } from "./AvatarRenderer";
import { SaveBar } from "./SaveBar";
import { SecretPair, SecretRow, pairOf } from "./secrets";
import { McpServers, ToolList } from "./ToolSettings";
import { keyGroups, matchIssue, noteFor, sourceLabel, type JsonSchema, type KeyModel, type KeyRead, type SectionModel } from "./schemaModel";
import { useSettings, useSettingsState, type SectionState } from "./store";
import { egressNote, useEgress, type EgressEntry } from "../../state/egress";
import { validateKey, type Errors } from "./validate";

/** What a live section's save says about the units that read it (DASH-SET-002). */
export const LIVE_LINE = "a save applies at once, open pages included, and restarts nothing";

/** The settings keys whose engine or provider sends private data somewhere, and the service that sends it (DASH-SET-034). */
const EGRESS_KEYS: Record<string, EgressEntry["service"]> = {
  "voice.engine": "voice", "ears.stt_engine": "ears", "ears.stt_fallback_engine": "ears", "vision.provider": "eyes", "llm.provider": "cortex",
};

/** A key the answer carries that the schema does not describe: shown with the generic control for its value's type, never hidden. */
function undescribed(key: string, info: KeyRead): KeyModel {
  const v = info.value;
  const schema: JsonSchema = typeof v === "boolean" ? { type: "boolean" } : typeof v === "number" ? { type: "number" } : typeof v === "string" ? { type: "string" }
    : Array.isArray(v) && v.every((x) => typeof x === "string") ? { type: "array", items: { type: "string" } } : {};
  const control = info.secret ? { kind: "secret" as const } : schema.type === "boolean" ? { kind: "switch" as const } : schema.type === "number" ? { kind: "number" as const }
    : schema.type === "string" ? { kind: "text" as const } : schema.type === "array" ? { kind: "lines" as const } : { kind: "json" as const };
  return { key, label: key.split(".").pop()!.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), schema, control, sensitive: false, secret: !!info.secret };
}

/** Everything one section shows: its described keys, then any key of the answer the schema lacks. */
function keysOf(section: SectionModel, st: SectionState | undefined): SectionModel {
  // A secret under a key the section describes (`servers.<name>.token` under `servers`) belongs to that key's widget, not a row of its own.
  const extra = Object.entries(st?.keys ?? {}).filter(([k, i]) => !section.keys.some((m) => m.key === k || (i.secret && k.startsWith(`${m.key}.`)))).map(([k, i]) => undescribed(k, i));
  return extra.length ? { ...section, keys: [...section.keys, ...extra] } : section;
}

// @spec DASH-SET-034
function Row({ section, km, st, picks, egress }: { section: SectionModel; km: KeyModel; st: SectionState; picks: ReturnType<typeof usePickLists>; egress: EgressEntry[] }) {
  const settings = useSettings();
  const id = useId();
  const info = st.keys[km.key];
  const edit = st.edits[km.key];
  const value = edit ? edit.value : info?.value;
  const path = km.key === section.path.split(".").pop() && section.keys.length === 1 ? section.path : `${section.path}.${km.key}`;
  const embedded = isEmbedded(km.control);
  const errors: Errors = { ...(edit ? validateKey(km, value) : {}) };
  for (const i of st.issues) {
    const m = matchIssue(section.path, Object.keys(st.keys), i.path);
    if (m?.key === km.key) errors[m.rest] = i.message;
  }
  const note = noteFor(km, info);
  const service = EGRESS_KEYS[`${section.path}.${km.key}`];
  const egressNotes = service ? egress.filter((e) => e.service === service).map(egressNote).filter((n): n is string => n !== undefined) : [];
  const overriders = info?.isolation?.overriddenBy ?? [];
  const ids = { help: `${id}-help`, note: `${id}-note`, sens: `${id}-sens`, iso: `${id}-iso`, err: `${id}-err` };
  const describedBy = [
    !embedded && km.help ? ids.help : null, note ? ids.note : null, km.sensitive ? ids.sens : null, overriders.length ? ids.iso : null, errors[""] ? ids.err : null,
  ].filter(Boolean).join(" ") || undefined;
  const wiring: Wiring = { id, describedBy, invalid: !!errors[""] || !!edit?.error };
  return (
    <RowShell section={section.path} name={km.key} path={path} label={km.label} labelFor={isLabelable(km.control) ? id : undefined} hideLabel={embedded} source={sourceLabel(info)}>
      {km.control.kind === "mcp-servers" ? <McpServers section={section} km={km} st={st} /> : km.control.kind === "tool-list" ? <ToolList section={section} km={km} st={st} />
        : km.control.kind === "avatar-model" ? <AvatarRenderer section={section} km={km} st={st} /> : <FieldControl control={km.control} label={km.label} value={value} settled={info?.value} schema={km.schema} unit={km.unit} wiring={wiring} help={km.help}
        placeholder={undefined} models={picks.models} voices={picks.voices} errors={errors}
        onChange={(v, error) => settings.edit(section.path, km.key, v, error)} />}
      {!embedded && km.help ? <p className="help" id={ids.help}>{km.help}</p> : null}
      {note ? <p className="help" id={ids.note}>{note}</p> : null}
      {egressNotes.map((n, i) => <p className="help egress-note" key={i}>{n}</p>)}
      {km.sensitive ? <p className="help" id={ids.sens}>Changing this from another machine needs the control token.</p> : null}
      {overriders.length > 0 ? (
        <div className="note note-warn small" id={ids.iso}>
          {`${overriders.join(", ")} ${overriders.length === 1 ? "runs" : "run"} isolated: its ${info!.isolation!.name} override is set, and a restart keeps it. Your saved value applies again once it is started without isolation.`}
        </div>
      ) : null}
      {errors[""] ? <p className={`help field-error`} id={ids.err} role={embedded ? "alert" : undefined}>{errors[""]}</p> : null}
    </RowShell>
  );
}

/** A group of keys. `liveNote` puts the live section's save line at its head (a member of a page; the page header carries the primary's). */
function Group({ title, section, keys, st, picks, egress, liveNote }: { title: string; section: SectionModel; keys: KeyModel[]; st: SectionState; picks: ReturnType<typeof usePickLists>; egress: EgressEntry[]; liveNote?: boolean }) {
  const done = new Set<string>();
  const rows = keys.flatMap((km) => {
    if (done.has(km.key)) return [];
    const pair = km.secret ? pairOf(section, km.key) : undefined;
    if (pair) {
      pair.keys.forEach((k) => done.add(k));
      const models = pair.keys.map((k) => keys.find((x) => x.key === k)!) as [KeyModel, KeyModel];
      return [<SecretPair key={pair.keys[0]} section={section} title={pair.title} keys={pair.keys} models={models} reads={[st.keys[pair.keys[0]], st.keys[pair.keys[1]]]} />];
    }
    if (km.control.kind === "secret") return [<SecretRow key={km.key} section={section} km={km} info={st.keys[km.key]} />];
    return [<Row key={km.key} section={section} km={km} st={st} picks={picks} egress={egress} />];
  });
  return (
    <details className="sgroup" open>
      <summary>{title}</summary>
      {liveNote && section.live ? <p className="help live-note">A save applies at once, open pages included, and restarts nothing.</p> : null}
      <div>{rows}</div>
    </details>
  );
}

/** The keys `config.yaml` holds that the schema does not define, for every section of the page (DASH-SET-033). */
function UnknownKeys({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="note note-warn small" role="note" aria-label="Unrecognised keys">
      <p>{`config.yaml holds ${paths.length === 1 ? "a key that is" : "keys that are"} not recognised and ${paths.length === 1 ? "is" : "are"} ignored (a misspelt name is the usual cause). A save leaves ${paths.length === 1 ? "it" : "them"} as ${paths.length === 1 ? "it is" : "they are"}. To remove ${paths.length === 1 ? "it" : "them"}, edit config.yaml.`}</p>
      <ul className="plain mono">{paths.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>
  );
}

/**
 * One settings page: the title, the about line, the config path with the setting count and readers, then the keys in
 * collapsible groups and the save bar (design: Page header, Rows and groups). A section shown on this page (`page`) is a group.
 */
// @spec DASH-SET-002, DASH-SET-003, DASH-SET-004, DASH-SET-025, DASH-SET-033
export function SectionPage({ primary, members }: { primary: SectionModel; members: SectionModel[] }) {
  const settings = useSettings();
  const sections = useSettingsState((s) => s.sections);
  const wanted = (kind: string) => members.some((m) => m.keys.some((k) => k.control.kind === kind));
  const picks = usePickLists(wanted("model"), wanted("voice"), primary.path);
  // GET /egress is read again after each save: a saved engine or provider changes the destinations (DASH-SET-034).
  const saveKey = members.map((m) => sections[m.path]?.etag ?? "").join("|");
  const egress = useEgress(saveKey);
  // The members' paths as one string: `members` is a new array on each render, and the sections are loaded again only when they change.
  const memberPaths = members.map((m) => m.path).join("|");
  useEffect(() => { for (const path of memberPaths.split("|")) void settings.loadSection(path); }, [settings, memberPaths]);
  const st = sections[primary.path];
  const failed = members.find((m) => sections[m.path]?.status === "error" && !Object.keys(sections[m.path]!.keys).length);
  const loaded = members.every((m) => sections[m.path]?.status === "ready");
  const full = keysOf(primary, st);
  const count = full.keys.length;
  return (
    <section className="card" aria-label="Section settings">
      <div className="card-h block">
        <PageHeading>{primary.title}</PageHeading>
        {primary.about ? <p className="muted">{primary.about}</p> : null}
        <p className="small muted">
          {`config.yaml · `}<code className="mono">{primary.path}</code>{` · ${count} ${count === 1 ? "setting" : "settings"} · `}
          {primary.services.length > 0 ? `read by ${primary.services.join(", ")}` : "read by the dashboard itself"}
          {primary.live ? ` · ${LIVE_LINE}` : primary.services.length > 0 ? " · changes apply when they restart" : " · applies at its next start"}
        </p>
      </div>
      <div className="card-b">
        {failed ? <ErrorState message={`Could not read ${failed.title}: ${sections[failed.path]!.error}`} onRetry={() => void settings.loadSection(failed.path)} />
          : !loaded ? <LoadingState label="Loading settings…" />
          : (
            <>
              <UnknownKeys paths={members.flatMap((m) => sections[m.path]?.unknown ?? [])} />
              {keyGroups(full).map((g) => <Group key={g.id || "general"} title={g.title} section={full} keys={g.keys} st={sections[primary.path]!} picks={picks} egress={egress} />)}
              {members.slice(1).map((m) => { const mm = keysOf(m, sections[m.path]); return <Group key={m.path} title={m.title} section={mm} keys={mm.keys} st={sections[m.path]!} picks={picks} egress={egress} liveNote />; })}
            </>
          )}
      </div>
      <SaveBar members={members} />
    </section>
  );
}
