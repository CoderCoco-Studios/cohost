// The renderer's reports to the relay (DASH-AVP-023, DASH-AVP-039). Pure: the send is passed in.
import type { ModelReport } from "./model-loader";

/**
 * A `model` report to the relay. A preview sends none (DASH-AVP-039): a loopback preview must not overwrite the health line
 * of the page OBS loads.
 */
// @spec DASH-AVP-039
export function createModelRelay(opts: { preview: boolean; send(msg: { type: "model"; version: string; state: string; detail: string }): void }): (r: ModelReport) => void {
  return (r) => {
    if (opts.preview) return;
    opts.send({ type: "model", version: r.version, state: r.state, detail: r.detail });
  };
}
