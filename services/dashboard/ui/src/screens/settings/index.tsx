import { useEffect } from "react";
import { PageHeading } from "../../components/PageHeading";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateBlocks";
import { useStale } from "../../app/connection";
import type { ScreenProps } from "../../app/screens";
import { Personality } from "./Personality";
import { RestartBanner } from "./RestartBanner";
import { PERSONALITY, SectionNav } from "./SectionNav";
import { SectionPage } from "./SectionPage";
import { navGroups, pageOf } from "./schemaModel";
import { useSettings, useSettingsState } from "./store";

/**
 * The Settings screen (design: Settings screen). It names no section or setting: the navigation, each page's heading,
 * about line, groups, controls and help all come from `GET /config/schema`. Personality is the one page it provides itself.
 */
// @spec DASH-SET-001, DASH-SET-002, DASH-SET-004, DASH-SET-006, DASH-SET-007, DASH-NAV-004
export function Screen({ route }: ScreenProps) {
  const settings = useSettings();
  const schema = useSettingsState((s) => s.schema);
  const stale = useStale();
  useEffect(() => {
    if (settings.state.get().schema.status !== "ready") void settings.loadSchema();
    void settings.loadControl();
  }, [settings]);

  if (schema.status === "loading") return <><PageHeading>Settings</PageHeading><LoadingState label="Loading settings…" /></>;
  if (schema.status === "error" || !schema.model) {
    return <><PageHeading>Settings</PageHeading><ErrorState message={`Could not load the settings schema: ${schema.error}`} onRetry={() => void settings.loadSchema()} /></>;
  }
  const model = schema.model;
  const first = navGroups(model)[0]?.sections[0]?.path;
  const wanted = route.section ?? PERSONALITY;
  const page = wanted === PERSONALITY ? undefined : pageOf(model, wanted);
  const current = wanted === PERSONALITY ? PERSONALITY : page?.primary.path ?? "";
  void first;
  return (
    <>
      <RestartBanner />
      <div className="settings-layout">
        <SectionNav model={model} current={current} />
        <div className="settings-main" {...stale}>
          {wanted === PERSONALITY ? <><PageHeading>Personality</PageHeading><Personality /></>
            : page ? <SectionPage key={page.primary.path} primary={page.primary} members={page.members} />
            : <><PageHeading>Settings</PageHeading><EmptyState title={`No settings section named ${wanted}.`}>Pick a section from the list.</EmptyState></>}
        </div>
      </div>
    </>
  );
}
