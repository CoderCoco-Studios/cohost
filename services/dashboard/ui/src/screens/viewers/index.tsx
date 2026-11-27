import { useState } from "react";
import { PageHeading } from "../../components/PageHeading";
import type { ScreenProps } from "../../app/screens";
import { ViewerDetail } from "./ViewerDetail";
import { ViewerList } from "./ViewerList";
import { useViewers } from "./useViewers";

/**
 * The Viewers screen: what the co-host remembers about each viewer, as master and detail (a list with search on the left,
 * the selected viewer's notes on the right; one stacked view with a Back button on a narrow screen). Notes arrive only
 * through the `/viewers` routes, which need the control token or this browser's session cookie (never over `/ws`)
 * (DASH-VIEWERS-010 to -023).
 */
// @spec DASH-VIEWERS-010, DASH-VIEWERS-011, DASH-VIEWERS-016, DASH-VIEWERS-023
export function Screen(_props: ScreenProps) {
  const v = useViewers();
  const [focusKey, setFocusKey] = useState<string | null>(null);
  return (
    <>
      <PageHeading>Viewers</PageHeading>
      <div className="viewers-panes" data-selected={v.selected !== null ? "true" : "false"}>
        <ViewerList load={v.list} query={v.query} applied={v.applied} onQuery={v.setQuery} selected={v.selected} onSelect={v.select}
          onRetry={v.reload} onMarked={() => void v.refreshList()} focusKey={focusKey} onFocused={() => setFocusKey(null)} />
        <ViewerDetail selected={v.selected} load={v.detail} figures={v.figures} onChanged={v.changed} onLinked={v.linked} onRetry={v.retryDetail}
          onBack={() => { const k = v.selected; v.back(); setFocusKey(k); }} />
      </div>
    </>
  );
}
