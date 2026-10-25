/**
 * Live-tail the bus, one line per event.
 *
 *   node --import tsx scripts/dev/bus-tail.ts                       # new events only
 *   node --import tsx scripts/dev/bus-tail.ts --replay 20          # last 20, then live
 *   node --import tsx scripts/dev/bus-tail.ts brain.say voice.utterance   # filter by type
 *   node --import tsx scripts/dev/bus-tail.ts --json                # raw JSON lines
 *
 * Uses a non-group XREAD (like the dashboard), so it never steals events from
 * a service's consumer group. Long arrays (voice envelope) are elided.
 */
import { Bus, EVENT_TYPES, type BusEvent } from "../../packages/bus/src/index.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const ri = args.indexOf("--replay");
const replay = ri >= 0 ? Number(args[ri + 1] ?? 20) : 0;
const types = new Set(args.filter((a, i) => !a.startsWith("--") && !(ri >= 0 && i === ri + 1)));
for (const t of types) if (!(EVENT_TYPES as string[]).includes(t)) { console.error(`unknown event type "${t}"`); process.exit(2); }

const short = (_k: string, v: unknown) => (Array.isArray(v) && v.length > 8 ? `[${v.length} items]` : v);
const show = (ev: BusEvent) => {
  if (types.size && !types.has(ev.type)) return;
  console.log(json ? JSON.stringify(ev) : `${new Date(ev.ts).toISOString().slice(11, 23)} ${ev.source.padEnd(10)} ${ev.type.padEnd(22)} ${JSON.stringify(ev.data, short)}`);
};

const bus = new Bus("dev-tail");
let from = "$";
if (replay > 0) {
  const past = await bus.recent(replay);
  past.forEach(show);
  from = past.at(-1)?.id ?? "$";
}
process.on("SIGINT", () => { bus.stop(); process.exit(0); });
console.error(`tailing ${types.size ? [...types].join(",") : "all events"} (ctrl-c to stop)`);
await bus.tail(show, from);
