// A small `GET /config/schema` payload that covers every control kind the Settings screen renders, plus the
// `GET /config/<section>` answers that go with it. Shapes follow `GET /config/schema` and `GET /config/:section`
// (services/dashboard/src/settings.ts, packages/config/src/editor.ts).

export const GROUPS = ["Identity", "Brain", "Senses", "Voice and body", "System"];

const reflexItem = {
  type: "object",
  properties: {
    match: { type: "string", minLength: 1, description: "A pattern tested against each line." },
    on: { type: "array", items: { type: "string", enum: ["chat", "speech", "vision"] }, default: ["chat", "speech", "vision"], description: "Which senses this reflex listens to." },
    say: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "What the co-host says." },
    emotion: { type: "string", enum: ["neutral", "happy", "laugh", "surprised", "smug", "sad", "angry", "confused", "think"], default: "surprised", description: "The emotion shown." },
    gesture: { type: "string", description: "An optional avatar gesture." },
    cooldown_ms: { type: "integer", minimum: 0, default: 30000, description: "How long the reflex stays quiet." },
  },
  required: ["match", "say"],
};

export const schemaPayload = {
  groups: GROUPS,
  sections: [
    {
      path: "demo", title: "Demo", group: "Brain", about: "A section with one control of every kind.", services: ["voice", "mouth"], secrets: ["api_key"],
      schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: true, description: "Switch it on." },
          mode: { type: "string", enum: ["calm", "lively", "wild"], default: "calm", description: "How it behaves." },
          provider: { type: "string", enum: ["ollama", "openai", "claude", "bedrock", "groq", "other"], default: "ollama", description: "Where it runs." },
          temperature: { type: "number", minimum: 0, maximum: 2, default: 0.7, description: "How adventurous." },
          top_k: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "How many to keep." },
          port: { type: "integer", minimum: 1, maximum: 65535, default: 3000, description: "The port." },
          timeout_ms: { type: "integer", minimum: 0, default: 5000, description: "How long to wait." },
          name: { type: "string", minLength: 1, default: "Coco", description: "A plain name." },
          prompt: { type: "string", default: "short", description: "A long prompt." },
          ignore: { type: "array", items: { type: "string" }, default: [], description: "One per line." },
          senses: { type: "array", items: { type: "string", enum: ["chat", "speech", "vision"] }, default: ["chat"], description: "Which senses." },
          sources: { type: "array", items: { type: "string" }, default: ["chat"], description: "Where events come from." },
          timezone: { type: "string", default: "UTC", description: "The time zone." },
          model: { type: "string", default: "", description: "The model." },
          voice: { type: "string", default: "af_heart", description: "The voice." },
          mystery: { type: "string", default: "x", description: "A key whose widget is unknown." },
          url: { type: "string", default: "http://a", description: "Where requests go.", "x-sensitive": true },
          api_key: { type: "string", "x-secret": true, description: "A key." },
          nested: { type: "object", properties: { deep: { type: "boolean", default: false, description: "A nested switch." }, limit: { type: "integer", minimum: 0, default: 1, description: "A nested limit." } } },
          extras: { type: "object", additionalProperties: { type: "string" }, default: {}, description: "Free-form pairs." },
          reflexes: { type: "array", items: reflexItem, default: [], description: "Canned reactions." },
          secret_note: { type: "string", default: "", description: "Another string." },
        },
      },
      keys: {
        enabled: { help: "Switch it on." },
        mode: { help: "How it behaves.", widget: { type: "options", options: [{ value: "calm", label: "Calm" }, { value: "lively", label: "Lively" }, { value: "wild", label: "Wild" }] } },
        provider: { help: "Where it runs." },
        temperature: { help: "How adventurous.", label: "Temperature" },
        top_k: { help: "How many to keep." },
        port: { help: "The port." },
        timeout_ms: { help: "How long to wait.", unit: "ms" },
        name: { help: "A plain name." },
        prompt: { help: "A long prompt.", widget: { type: "textarea" } },
        ignore: { help: "One per line." },
        senses: { help: "Which senses.", widget: { type: "options", options: [{ value: "chat", label: "Chat" }, { value: "speech", label: "Speech" }, { value: "vision", label: "Vision" }] } },
        sources: { help: "Where events come from.", widget: { type: "sources" } },
        timezone: { help: "The time zone.", widget: { type: "timezone" } },
        model: { help: "The model.", widget: { type: "model", kind: "chat" } },
        voice: { help: "The voice.", widget: { type: "voice" } },
        mystery: { help: "A key whose widget is unknown.", widget: { type: "hologram" } },
        url: { help: "Where requests go.", sensitive: true },
        api_key: { help: "A key." },
        "nested.deep": { help: "A nested switch." },
        "nested.limit": { help: "A nested limit." },
        extras: { help: "Free-form pairs." },
        reflexes: {
          help: "Canned reactions.",
          items: {
            match: { help: "A pattern tested against each line." },
            on: { help: "Which senses this reflex listens to.", label: "Listens to" },
            say: { help: "What the co-host says.", label: "Lines to say" },
            emotion: { help: "The emotion shown." },
            gesture: { help: "An optional avatar gesture." },
            cooldown_ms: { help: "How long the reflex stays quiet.", unit: "ms" },
          },
        },
        secret_note: { help: "Another string." },
      },
    },
    {
      path: "extra", title: "Extra", group: "Brain", about: "Shown on the Demo page.", page: "demo", services: ["voice"],
      schema: { type: "integer", minimum: 1, default: 24, description: "A leaf section." },
      secrets: [],
      keys: { extra: { help: "A leaf section.", label: "Extra events" } },
    },
    {
      path: "llm", title: "Account", group: "System", about: "Credentials.", services: [], secrets: ["bedrock.access_key_id", "bedrock.secret_access_key", "token"],
      schema: {
        type: "object",
        properties: {
          bedrock: { type: "object", properties: { access_key_id: { type: "string", "x-secret": true, description: "ID" }, secret_access_key: { type: "string", "x-secret": true, description: "Key" } } },
          token: { type: "string", "x-secret": true, description: "A token." },
          region: { type: "string", default: "us-east-1", description: "Region." },
        },
      },
      keys: {
        "bedrock.access_key_id": { help: "The access key id." },
        "bedrock.secret_access_key": { help: "The secret access key." },
        token: { help: "A token." },
        region: { help: "Region." },
      },
    },
    {
      path: "plain", title: "Plain", group: "Identity", about: "No key metadata.", services: [], secrets: [],
      schema: { type: "object", properties: { speak_rate_ms: { type: "integer", minimum: 0, default: 10 }, "deep_thing": { type: "boolean", default: false } } },
      keys: {},
    },
  ],
};

export interface KeyRead { source?: "literal" | "default"; editable: boolean; value?: unknown; raw?: string; secret?: true; set?: boolean; isolation?: { name: string; overriddenBy: string[] } }

const lit = (value: unknown): KeyRead => ({ source: "literal", editable: true, value, raw: JSON.stringify(value) });
const def = (value: unknown): KeyRead => ({ source: "default", editable: true, value });

export const demoRead = {
  section: "demo", etag: "e1", unknown: [],
  keys: {
    enabled: lit(true), mode: lit("calm"), provider: def("ollama"), temperature: lit(0.7), top_k: def(10), port: lit(3000), timeout_ms: def(5000),
    name: lit("Coco"), prompt: def("short"), ignore: def([]), senses: lit(["chat"]), sources: lit(["chat"]), timezone: lit("UTC"), model: lit(""), voice: lit("af_heart"),
    mystery: lit("x"), url: lit("http://a"), api_key: { editable: false, secret: true, set: true },
    "nested.deep": def(false), "nested.limit": def(1), extras: def({}), reflexes: lit([{ match: "gg", on: ["chat"], say: ["gg!"], emotion: "happy", gesture: "", cooldown_ms: 1000 }]),
    secret_note: def(""),
  } as Record<string, KeyRead>,
};

export const extraRead = { section: "extra", etag: "x1", unknown: [], keys: { extra: lit(24) } as Record<string, KeyRead> };

export const accountRead = {
  section: "llm", etag: "a1", unknown: [],
  keys: {
    "bedrock.access_key_id": { editable: false, secret: true, set: false } as KeyRead,
    "bedrock.secret_access_key": { editable: false, secret: true, set: false } as KeyRead,
    token: { editable: false, secret: true, set: true } as KeyRead,
    region: def("us-east-1"),
  },
};

export const plainRead = { section: "plain", etag: "p1", unknown: [], keys: { speak_rate_ms: def(10), deep_thing: def(false) } as Record<string, KeyRead> };
