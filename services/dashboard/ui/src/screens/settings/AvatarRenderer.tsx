// The `avatar-model` widget (DASH-AVS-002 to DASH-AVS-011): the whole top of the renderer group, which is the model list and
// upload, the status above the preview, the preview, and Reset framing. The framing sliders are the group's own rows below it.
import { Button } from "../../components/Button";
import { AvatarModels } from "./AvatarModels";
import { AvatarPreview } from "./AvatarPreview";
import type { KeyModel, SectionModel } from "./schemaModel";
import { RendererStatus } from "./RendererStatus";
import { useSettings, type SectionState } from "./store";

// @spec DASH-AVS-001, DASH-AVS-002, DASH-AVS-007
export function AvatarRenderer({ section, km, st }: { section: SectionModel; km: KeyModel; st: SectionState }) {
  const settings = useSettings();
  /** Reset framing: the three framing keys to their defaults as edits, saved or discarded with the rest. */
  const reset = (): void => {
    settings.edit(section.path, "zoom", 1);
    settings.edit(section.path, "offset_y", 0);
    settings.edit(section.path, "turn", 0);
  };
  return (
    <div className="stack-y avatar-renderer">
      {km.help ? <p className="help">{km.help}</p> : null}
      <AvatarModels section={section} km={km} st={st} />
      <RendererStatus st={st} />
      <AvatarPreview st={st} />
      <div><Button onClick={reset}>Reset framing</Button></div>
    </div>
  );
}
