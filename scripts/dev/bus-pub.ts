/**
 * Publish one validated event onto the bus.
 *
 *   node --import tsx scripts/dev/bus-pub.ts chat.message '{"platform":"twitch","user":"viewer","text":"hi Coco!","mentionsCohost":true}'
 *   node --import tsx scripts/dev/bus-pub.ts --list        # event types + required fields
 *
 * Payload goes through the same zod schema as Bus.publish, so a typo fails
 * here instead of being silently dropped by every subscriber. REDIS_URL
 * defaults to redis://127.0.0.1:6379.
 */
import { Bus, EventPayloads, EVENT_TYPES, type EventType } from "../../packages/bus/src/index.js";

const [type, json] = process.argv.slice(2);
if (!type || type === "--help" || type === "-h") {
  console.error("usage: bus-pub.ts <event.type> '<json payload>'   |   bus-pub.ts --list");
  process.exit(type ? 0 : 2);
}
if (type === "--list") {
  for (const t of EVENT_TYPES) console.log(t);
  process.exit(0);
}
if (!(type in EventPayloads)) {
  console.error(`unknown event type "${type}". known: ${EVENT_TYPES.join(", ")}`);
  process.exit(2);
}

let data: unknown;
try {
  data = JSON.parse(json ?? "{}");
} catch (e) {
  console.error(`payload is not valid JSON: ${e}`);
  process.exit(2);
}

const bus = new Bus("dev-pub");
try {
  const id = await bus.publish(type as EventType, data as never);
  console.log(`published ${type} ${id}`);
} catch (e) {
  console.error(`rejected: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  bus.stop();
}
