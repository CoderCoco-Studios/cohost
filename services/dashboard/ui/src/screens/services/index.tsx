import { EmptyState } from "../../components/StateBlocks";
import { PageHeading } from "../../components/PageHeading";
import type { ScreenProps } from "../../app/screens";

/**
 * The Services screen. A placeholder until its package is built: replace the body, keep the exports. Render exactly one
 * `<PageHeading>` (the shell moves focus to it on navigation) and put the screen's own files in this folder.
 */
export function Screen({ route }: ScreenProps) {
  return (
    <>
      <PageHeading>Services</PageHeading>
      <EmptyState title="Not built yet">{route.section ? `Section: ${route.section}` : "This screen is built in its own package."}</EmptyState>
    </>
  );
}
