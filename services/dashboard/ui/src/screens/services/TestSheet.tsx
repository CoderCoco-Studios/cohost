import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "../../app/providers";
import { ActionStatus } from "../../components/ActionStatus";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import { FilePicker } from "../../components/FilePicker";
import { SideSheet } from "../../components/SideSheet";
import { useAction, useApi } from "../../state/hooks";
import type { ApiResult } from "../../state/api";
import type { FeedEvent, UnitDescriptor } from "../../state/types";
import { TOOLS_UNIT } from "../../state/tools";
import { sampleFor } from "./samples";
import { unitTest } from "./model";

const KEEP = 50;
const clip = (v: unknown): string => JSON.stringify(v).slice(0, 300);
const fail = (detail: string): ApiResult<never> => ({ ok: false, status: 0, detail });
const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** One bus-event form: a JSON textarea starting from the type's sample. */
function BusForm({ type, onSend }: { type: string; onSend: (type: string, text: string) => void }) {
  const [text, setText] = useState(() => JSON.stringify(sampleFor(type), null, 2));
  return (
    <div className="td-form">
      <Field label={`${type} data (JSON)`} help="A bus event, marked injected where its schema allows.">
        {(p) => <textarea {...p} className="field mono" rows={6} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />}
      </Field>
      <Button size="sm" onClick={() => onSend(type, text)}>{`Send ${type}`}</Button>
    </div>
  );
}

/**
 * The per-unit test side sheet (a modal `<dialog>`): the unit's isolated start where control is on, one input form per
 * entry of the manifest's `test.inputs` (text, image and audio through the real pipeline, a bus event type as editable
 * JSON), one status line, and the live events the unit declares in `test.observe` plus the `inject.result` events answering
 * this sheet's injections. A result that beats the HTTP answer is cached and shown once the answer names its id.
 */
// @spec MOD-TEST-001, DASH-UI-032, DASH-UI-015
export function TestSheet({ unit, controlOn, blocked, onClose }: { unit: UnitDescriptor; controlOn: boolean; blocked: string | undefined; onClose: () => void }) {
  const api = useApi();
  const { feed } = useRuntime();
  const act = useAction();
  const { inputs, observe } = unitTest(unit);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [asking, setAsking] = useState(false);
  const ours = useRef(new Set<string>());      // ids of service-level injections made from this sheet
  const answers = useRef(new Set<string>());   // data.id of injected bus events: a reply carrying it answers the injection
  const results = useRef(new Map<string, FeedEvent>()); // inject.result by data.id, whether or not it is ours yet
  const textRef = useRef<HTMLTextAreaElement>(null);
  const toolRef = useRef<HTMLInputElement>(null);
  const argsRef = useRef<HTMLTextAreaElement>(null);
  const fileRefs = useRef(new Map<string, HTMLInputElement>());

  const add = useCallback((ev: FeedEvent) => setEvents((list) => [...list, ev].slice(-KEEP)), []);
  useEffect(() => feed.onEvent((ev, replay) => {
    if (replay) return;
    if (ev.type === "inject.result") {
      const id = (ev.data as { id?: unknown }).id;
      if (typeof id !== "string") return;
      results.current.set(id, ev);
      if (results.current.size > KEEP) results.current.delete(results.current.keys().next().value as string);
      if (ours.current.has(id)) add(ev);
    } else if (observe.includes(ev.type)) add(ev);
  }), [feed, add, observe.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const track = (id: string) => { ours.current.add(id); const early = results.current.get(id); if (early) add(early); };
  const gate = { auth: "control" as const };

  const sendText = () => {
    const text = textRef.current?.value.trim() ?? "";
    if (!text) { void act.run(async () => fail("Type some text first."), ""); return; }
    void act.run(async () => {
      const r = await api.post<{ id: string }>("/inject/text", { level: "service", text }, { ...gate, action: `Send test text to ${unit.id}` });
      if (r.ok) track(r.data.id);
      return r;
    }, (d) => `Sent text (id ${d.id}), waiting for its result…`);
  };
  // A tool call: service-level text marked `as: "tool"` whose text is the JSON {tool, arguments}. The route is token-gated whether or not control mode is on, so the token is asked for before anything is sent.
  // @spec MOD-MAN-010, MOD-TEST-005, DASH-INJ-011
  const sendTool = () => {
    const tool = toolRef.current?.value.trim() ?? "";
    const raw = argsRef.current?.value.trim() ?? "";
    if (!tool) { void act.run(async () => fail("Name a tool first."), ""); return; }
    let args: unknown;
    try { args = raw === "" ? {} : JSON.parse(raw); } catch (e) { void act.run(async () => fail(`Arguments are not valid JSON: ${e instanceof Error ? e.message : String(e)}`), ""); return; }
    if (typeof args !== "object" || args === null || Array.isArray(args)) { void act.run(async () => fail("Arguments must be a JSON object."), ""); return; }
    void act.run(async () => {
      const r = await api.post<{ id: string }>("/inject/text", { level: "service", as: "tool", text: JSON.stringify({ tool, arguments: args }) }, { ...gate, requireToken: true, action: "Send a test tool call" });
      if (r.ok) track(r.data.id);
      return r;
    }, (d) => `Sent tool call (id ${d.id}), waiting for its result…`);
  };
  const sendFile = (kind: "image" | "audio") => {
    const file = fileRefs.current.get(kind)?.files?.[0];
    if (!file) { void act.run(async () => fail(kind === "image" ? "Choose an image first." : "Choose an audio file first."), ""); return; }
    const path = kind === "image" ? "/inject/image?level=service" : `/inject/audio?level=service&target=${encodeURIComponent(unit.id)}`;
    void act.run(async () => {
      const r = await api.post<{ id: string }>(path, file, { ...gate, contentType: file.type, action: `Send test ${kind} to ${unit.id}` });
      if (r.ok) track(r.data.id);
      return r;
    }, (d) => `Sent ${kind} (id ${d.id}), waiting for its result…`);
  };
  const sendBus = (type: string, text: string) => {
    let data: unknown;
    try { data = JSON.parse(text); } catch (e) { void act.run(async () => fail(`Data is not valid JSON: ${e instanceof Error ? e.message : String(e)}`), ""); return; }
    void act.run(async () => {
      const r = await api.post<{ id: string }>("/inject/event", { unit: unit.id, type, data }, { ...gate, action: `Send ${type} to ${unit.id}` });
      if (r.ok && data && typeof (data as { id?: unknown }).id === "string") answers.current.add((data as { id: string }).id);
      return r;
    }, (d) => `Published ${type} (bus id ${d.id}); replies that carry the same id are marked.`);
  };
  const startIsolated = async () => {
    const r = await act.run(() => api.lifecycle(unit.id, "start", { isolated: true }, `Start ${unit.id} isolated`), `${unit.id} started isolated`);
    if (r.ok) setAsking(false);
  };

  const askError = asking && act.state.kind === "error" ? act.state.message : undefined;
  const shown = askError !== undefined ? { kind: "idle" as const } : act.state;
  const label = `Start ${unit.id} isolated`;

  return (
    <>
      <SideSheet open title={`Test ${unit.id}`} onClose={onClose}>
        {controlOn ? (
          <div className="row">
            <Button size="sm" onClick={() => { act.dismiss(); setAsking(true); }}>{label}</Button>
            <span className="help">Only this service, with mock or off backends.</span>
          </div>
        ) : null}
        {inputs.map((type) => {
          if (type === "text" && unit.id === TOOLS_UNIT) return (
            <div className="td-form" key={type}>
              <Field label="Tool" help="The tool's name, as in the Tools settings (for example stream_info or weather__forecast).">{(p) => <input {...p} ref={toolRef} className="field mono" type="text" autoComplete="off" spellCheck={false} />}</Field>
              <Field label="Arguments, as a JSON object" help="Run as the dashboard asking: an acting tool still waits for your confirmation.">{(p) => <textarea {...p} ref={argsRef} className="field mono" rows={4} spellCheck={false} placeholder="{}" />}</Field>
              <Button size="sm" onClick={sendTool}>Send text</Button>
            </div>
          );
          if (type === "text") return (
            <div className="td-form" key={type}>
              <Field label="Message, sent as a chat message through the real pipeline">{(p) => <textarea {...p} ref={textRef} className="field" rows={3} placeholder="Type a fake viewer message…" />}</Field>
              <Button size="sm" onClick={sendText}>Send text</Button>
            </div>
          );
          if (type === "image" || type === "audio") return (
            <div className="td-form" key={type}>
              <Field label={type === "image" ? "Image, through the real pipeline" : "Audio, through the real pipeline"}>
                {(p) => <FilePicker {...p} inputRef={(el) => { if (el) fileRefs.current.set(type, el); else fileRefs.current.delete(type); }} accept={type === "image" ? "image/png,image/jpeg,image/webp" : "audio/*"} />}
              </Field>
              <Button size="sm" onClick={() => sendFile(type)}>{type === "image" ? "Send image" : "Send audio"}</Button>
            </div>
          );
          return <BusForm key={type} type={type} onSend={sendBus} />;
        })}
        <div className="row"><ActionStatus state={shown} onDismiss={act.dismiss} /></div>
        <h3 className="td-h">Live events</h3>
        <div role="log" aria-label="Live events" className="feed td-feed">
          {events.length === 0 ? <p className="muted small">Nothing yet. Events of the types this service declares appear here.</p> : (
            <ul className="plain-list">
              {events.map((ev, i) => {
                const id = (ev.data as { id?: unknown }).id;
                const mine = typeof id === "string" && answers.current.has(id) && ev.type !== "inject.result";
                return (
                  <li key={`${ev.id}-${i}`} className="ev">
                    <time>{time(ev.ts)}</time>
                    <span className="k">{ev.type}</span>
                    <p className="mono">{clip(ev.data)}{mine ? <> <span className="tag">answers your injection</span></> : null}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SideSheet>
      <ConfirmDialog open={asking} title={`${label}?`} confirmLabel={label} disabledReason={blocked} busy={act.state.kind === "pending"} error={askError}
        onConfirm={() => void startIsolated()} onCancel={() => setAsking(false)}>
        <p>{`Only ${unit.id} starts, with mock or off backends. Anything it uses that is not running stays off.`}</p>
      </ConfirmDialog>
    </>
  );
}
