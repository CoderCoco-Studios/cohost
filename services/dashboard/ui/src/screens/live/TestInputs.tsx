import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Field, TextAreaField, TextField } from "../../components/Field";
import { SegmentedGroup } from "../../components/SegmentedGroup";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { useApi } from "../../state/hooks";
import { DEFAULT_LIMITS, IMAGE_ACCEPT, INJECT_TARGET, PLATFORMS, failureText, formatMiB, parseLimits, tooLarge, type BusAs, type InjectKind, type Limits } from "./inject";
import { BROWSER_TIMERS, useInjectStatus, type Timers } from "./useInjectStatus";

const KINDS: { value: InjectKind; label: string }[] = [{ value: "text", label: "Text" }, { value: "image", label: "Image" }, { value: "audio", label: "Audio" }];
const AS: { value: BusAs; label: string }[] = [{ value: "chat", label: "Chat" }, { value: "speech", label: "Speech" }, { value: "vision", label: "Vision" }];
const ACTION = "Send test input";

/** Whether this browser can record the microphone (`MediaRecorder` and `getUserMedia`). */
const canRecord = (): boolean => typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/**
 * The test-inputs panel (DASH-UI-009, -010, -034): one kind selector (Text, Image, Audio), the inputs of the selected kind,
 * a "Store in memory" switch (off by default), one Send button and one status line. Text posts `/inject/text`; an image or
 * audio file is posted raw to `/inject/image` or `/inject/audio` after a check against the size limit read from
 * `GET /config/dashboard`. The Advanced disclosure switches to Bus only (Text only, chat, speech or vision, no service
 * result). A service-level injection waits for its `inject.result`; a failure is an alert with the HTTP status and detail.
 */
// @spec DASH-UI-009, DASH-UI-010, DASH-UI-015, DASH-UI-034
export function TestInputs({ timers = BROWSER_TIMERS }: { /** Replaceable timer functions, for tests. */ timers?: Timers }) {
  const api = useApi();
  const track = useInjectStatus(timers);
  const [kind, setKind] = useState<InjectKind>("text");
  const [bus, setBus] = useState(false);
  const [as, setAs] = useState<BusAs>("chat");
  const [text, setText] = useState("");
  const [user, setUser] = useState("");
  const [platform, setPlatform] = useState<string>(PLATFORMS[0]);
  const [isMod, setMod] = useState(false);
  const [isSub, setSub] = useState(false);
  const [remember, setRemember] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<{ stop: () => void } | null>(null);
  const mounted = useRef(true);
  const latest = useRef({ user, remember, limits });
  latest.current = { user, remember, limits };

  // The size limits (DASH-UI-034): the defaults stand in until the answer arrives and when it fails.
  useEffect(() => {
    let live = true;
    void api.get("/config/dashboard").then((r) => { if (live && r.ok) setLimits(parseLimits(r.data)); });
    return () => { live = false; };
  }, [api]);

  // Leaving the screen while recording releases the microphone and sends nothing.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; recorder.current?.stop(); }; }, []);

  const fileError = (f: File | null, limit: number): string | undefined => (f && f.size > limit ? tooLarge(f.name, f.size, limit) : undefined);
  const imageError = fileError(imageFile, limits.image), audioError = fileError(audioFile, limits.audio);

  const pickKind = (k: InjectKind) => { setKind(k); setImageFile(null); setAudioFile(null); track.reset(); };
  const pickBus = (on: boolean) => { setBus(on); if (on) pickKind("text"); };

  /** Reports a request's outcome: a refusal is a failure with its status and detail; a 202 follows the `inject.result` of its id. */
  async function finish(kindSent: InjectKind, level: "service" | "bus", request: Promise<Awaited<ReturnType<typeof api.post>>>) {
    const r = await request;
    if (!mounted.current) return;
    if (!r.ok) { track.fail(failureText(r)); return; }
    const id = (r.data as { id?: unknown } | undefined)?.id;
    if (level === "bus") track.ok("published at bus level (no service result)");
    else if (typeof id === "string") track.track(id, kindSent);
    else track.info(`sent to ${INJECT_TARGET[kindSent]} (the server returned no id to follow)`);
  }

  async function sendFile(k: "image" | "audio", blob: Blob, type: string) {
    const { user: who, remember: keep } = latest.current;
    const q = new URLSearchParams({ level: "service", remember: keep ? "1" : "0" });
    if (k === "audio" && who.trim()) q.set("user", who.trim());
    await finish(k, "service", api.post(`/inject/${k}?${q}`, blob, { auth: "control", action: ACTION, contentType: type || "application/octet-stream" }));
  }

  async function send() {
    if (busy) return;
    track.reset();
    if (kind === "text") {
      const line = text.trim();
      if (!line) { track.fail("Type a message first."); return; }
      const who = user.trim();
      const viewer = !bus || as === "chat";
      const body = { level: bus ? "bus" : "service", ...(bus ? { as } : {}), text: line, remember,
        ...(who && (!bus || as !== "vision") ? { user: who } : {}), ...(viewer ? { platform, isMod, isSub } : {}) };
      setBusy(true);
      try { await finish("text", bus ? "bus" : "service", api.post("/inject/text", body, { auth: "control", action: ACTION })); } finally { if (mounted.current) setBusy(false); }
      return;
    }
    const file = kind === "image" ? imageFile : audioFile;
    if (!file) { track.fail(`Choose ${kind === "image" ? "an image" : "an audio"} file first.`); return; }
    const err = kind === "image" ? imageError : audioError;
    if (err) { track.fail(err); return; }
    setBusy(true);
    try { await sendFile(kind, file, file.type); } finally { if (mounted.current) setBusy(false); }
  }

  async function toggleRecording() {
    if (recorder.current) { recorder.current.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recorder.current = null;
        if (!mounted.current) return;
        setRecording(false);
        const type = (rec.mimeType || "audio/webm").split(";")[0]!;
        const clip = new Blob(chunks, { type });
        const tooBig = clip.size > latest.current.limits.audio ? tooLarge("The recording", clip.size, latest.current.limits.audio) : undefined;
        if (tooBig) track.fail(tooBig);
        else { setBusy(true); void sendFile("audio", clip, type).finally(() => { if (mounted.current) setBusy(false); }); }
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      recorder.current = null;
      track.fail(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const kinds = bus ? KINDS.filter((k) => k.value === "text") : KINDS;
  const { status } = track;
  return (
    <section className="card live-test" aria-labelledby="live-test-h">
      <div className="card-h"><h2 id="live-test-h">Test inputs</h2></div>
      <form className="card-b stack-y" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <SegmentedGroup legend="Input kind" name="inject-kind" value={kind} onChange={(v) => pickKind(v as InjectKind)} options={kinds} />

        {kind === "text" ? (
          <>
            <TextAreaField label="Message" value={text} onChange={setText} rows={3} placeholder={bus && as !== "chat" ? "The speech or screen line to publish…" : "Type a fake viewer message…"} />
            {!bus || as !== "vision" ? <TextField label="Viewer name" value={user} onChange={setUser} placeholder="injected_viewer" autoComplete="off" /> : null}
            {!bus || as === "chat" ? (
              <>
                <Select label="Platform" value={platform} onChange={setPlatform} options={PLATFORMS.map((p) => ({ value: p, label: p }))} />
                <div className="row"><Switch label="Moderator" checked={isMod} onChange={setMod} /><Switch label="Subscriber" checked={isSub} onChange={setSub} /></div>
              </>
            ) : null}
          </>
        ) : null}

        {kind === "image" ? (
          <Field label="Image file" help={`PNG, JPEG or WebP. Limit: ${formatMiB(limits.image)} MiB.`} error={imageError}>
            {(p) => <input {...p} className="field" type="file" accept={IMAGE_ACCEPT} onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />}
          </Field>
        ) : null}

        {kind === "audio" ? (
          <>
            <Field label="Audio file" help={`Any audio type. Limit: ${formatMiB(limits.audio)} MiB.`} error={audioError}>
              {(p) => <input {...p} className="field" type="file" accept="audio/*" onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)} />}
            </Field>
            <TextField label="Viewer name" value={user} onChange={setUser} placeholder="injected_viewer" autoComplete="off" />
            {canRecord() ? <div className="row"><Button onClick={() => void toggleRecording()} aria-pressed={recording}>{recording ? "Stop and send" : "Record from microphone"}</Button></div> : null}
          </>
        ) : null}

        <Switch label="Store in memory" checked={remember} onChange={setRemember} describedBy="live-remember-help" />
        <p className="help" id="live-remember-help">Off: the memory region ignores this input and any reply to it.</p>
        <p className="note">The co-host treats test inputs as real and may answer them aloud.</p>
        {bus ? <p className="note note-warn">Bus only is on: the input skips perception and publishes straight to the bus.</p> : null}

        <div className="row">
          <Button variant="primary" type="submit" busy={busy}>Send</Button>
          <output className={`inject-status${status.tone === "ok" ? " action-ok" : ""}`}>{status.tone === "info" || status.tone === "ok" ? status.text : ""}</output>
        </div>
        {status.tone === "bad" ? (
          <div className="action-error" role="alert">
            <span>{status.text}</span>
            <Button variant="ghost" size="sm" onClick={track.reset}>Dismiss</Button>
          </div>
        ) : null}

        <details>
          <summary>Advanced: skip perception and publish straight to the bus</summary>
          <div className="stack-y live-advanced">
            <SegmentedGroup legend="Pipeline" name="inject-pipeline" value={bus ? "bus" : "real"} onChange={(v) => pickBus(v === "bus")}
              options={[{ value: "real", label: "Real pipeline" }, { value: "bus", label: "Bus only" }]} showLegend />
            {bus ? (
              <>
                <SegmentedGroup legend="Publish as" name="inject-as" value={as} onChange={(v) => setAs(v as BusAs)} options={AS} showLegend />
                <p className="help">Bus only skips the service that perceives the input, so no service result follows. Image and audio need the real pipeline.</p>
              </>
            ) : <p className="help">The real pipeline sends the input to the service that perceives it, as a viewer, microphone or screen would.</p>}
          </div>
        </details>
      </form>
    </section>
  );
}
