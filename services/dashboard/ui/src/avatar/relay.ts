// The renderer's reports to the relay (DASH-AVP-023, DASH-AVP-039, DASH-AVP-040). Pure: the send is passed in.
import type { ModelReport } from "./model-loader";

export interface ModelMessage { type: "model"; version: string; state: string; detail: string }

/**
 * The model reports to the relay. A preview sends none (DASH-AVP-039): a loopback preview must not overwrite the health
 * line of the page OBS loads. The last report is kept so a reconnect sends it again (DASH-AVP-040): the relay holds the
 * model state per socket, so a new socket starts with none until it is told.
 */
// @spec DASH-AVP-039, DASH-AVP-040
export function createModelRelay(opts: { preview: boolean; send(msg: ModelMessage): void }): { report(r: ModelReport): void; resend(): void } {
  let last: ModelReport | null = null;
  const message = (r: ModelReport): ModelMessage => ({ type: "model", version: r.version, state: r.state, detail: r.detail });
  return {
    report(r) {
      last = r;
      if (!opts.preview) opts.send(message(r));
    },
    resend() {
      if (!opts.preview && last !== null) opts.send(message(last));
    },
  };
}
