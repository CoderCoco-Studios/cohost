/**
 * Sample payloads by bus event type, for the test sheet's bus-event forms: each is valid for its type's schema, ready to
 * edit and send. A type with no sample gets `{}`.
 */
const SAMPLES: Record<string, () => Record<string, unknown>> = {
  "chat.message": () => ({ platform: "twitch", user: "injected_viewer", text: "hello cohost, how is the stream going?" }),
  "speech.heard": () => ({ speaker: "injected", text: "hello cohost", durationMs: 0 }),
  "vision.summary": () => ({ text: "A boss fight has started.", changed: true }),
  "brain.say": () => ({ id: `test-${Date.now()}`, text: "This is a test line.", emotion: "neutral" }),
  "attention.focus": () => ({ reason: "test", score: 1, focus: { kind: "chat", who: "injected_viewer", text: "hello cohost", mention: true } }),
  "affect.state": () => ({ valence: 0.5, arousal: 0.5, mood: "happy" }),
  "memory.recall.request": () => ({ id: `test-${Date.now()}`, query: "test", k: 3 }),
};

export const sampleFor = (type: string): Record<string, unknown> => SAMPLES[type]?.() ?? {};
