import { useEffect, useState } from "react";
import { useApi } from "../../state/hooks";

/** A pick list: undefined while loading, null when its route failed, the names otherwise. */
export type PickList = string[] | null | undefined;

/**
 * Reads the model and voice pick lists once, when the page that needs them opens, and not again until it is opened again
 * (DASH-SET-010). A route that answers an error leaves `null`: the control becomes a text box holding the current value.
 */
// @spec DASH-SET-010
export function usePickLists(wantModels: boolean, wantVoices: boolean, openedFor: string): { models: PickList; voices: PickList } {
  const api = useApi();
  const [models, setModels] = useState<PickList>(undefined);
  const [voices, setVoices] = useState<PickList>(undefined);
  useEffect(() => {
    let live = true;
    setModels(undefined); setVoices(undefined);
    if (wantModels) void api.get<{ models: string[] }>("/options/models").then((r) => { if (live) setModels(r.ok && Array.isArray(r.data?.models) ? r.data.models : null); });
    if (wantVoices) void api.get<{ voices: string[] }>("/options/voices").then((r) => { if (live) setVoices(r.ok && Array.isArray(r.data?.voices) ? r.data.voices : null); });
    return () => { live = false; };
    // Once per opening of a page: the deps are the page and what it wants, not the api object.
  }, [openedFor, wantModels, wantVoices]);
  return { models, voices };
}
