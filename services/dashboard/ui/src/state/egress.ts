import { useEffect, useState } from "react";
import { useApi } from "./hooks";

/** One destination of `GET /egress` (`egressDestinations`): the service that sends the data, what it is, and where it goes. */
export interface EgressEntry {
  service: "voice" | "ears" | "eyes" | "cortex" | "tools";
  data: "text" | "audio" | "frames";
  engine: string;
  host?: string;
  hosted?: string;
  offLan: boolean;
}

/**
 * The egress sentence for one entry, shared by the Services and Settings screens (DASH-UI-037). It names the host, or the hosted
 * provider where the entry has no host; `undefined` for an entry that stays on the LAN.
 */
// @spec DASH-UI-037
export function egressNote(e: EgressEntry): string | undefined {
  if (!e.offLan) return undefined;
  const where = e.host ?? e.hosted ?? "an unnamed destination";
  if (e.service === "voice") return `spoken text goes to ${where}`;
  if (e.service === "cortex") return `the conversation goes to ${where}`;
  if (e.service === "ears") return `audio goes to ${where}`;
  if (e.service === "eyes") return `screen frames go to ${where}`;
  return `tool requests go to ${where}`;
}

/**
 * Reads `GET /egress` once when the screen mounts. A failure, or a body without the list, yields no entries, so a screen
 * renders without its marks rather than failing (DASH-UI-037).
 */
// @spec DASH-UI-037, DASH-SET-034
export function useEgress(): EgressEntry[] {
  const api = useApi();
  const [entries, setEntries] = useState<EgressEntry[]>([]);
  useEffect(() => {
    let alive = true;
    void api.get<{ destinations?: EgressEntry[] }>("/egress").then((r) => {
      if (alive) setEntries(r.ok && Array.isArray(r.data?.destinations) ? r.data!.destinations! : []);
    });
    return () => { alive = false; };
  }, [api]);
  return entries;
}
