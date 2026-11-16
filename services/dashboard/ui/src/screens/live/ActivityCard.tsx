import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStale } from "../../app/connection";
import { useRuntime } from "../../app/providers";
import { Button } from "../../components/Button";
import { SegmentedGroup } from "../../components/SegmentedGroup";
import { EmptyState, LoadingState } from "../../components/StateBlocks";
import { useFeed } from "../../state/hooks";
import type { FeedEvent } from "../../state/types";
import { FILTERS, inFilter, kindLabel, rowBadges, rowClass, rowExtras, rowText, rowTime, zoneAbbreviation, type FeedFilter } from "./feedRows";

/** The log counts as at its end while it is within this many px of it (DASH-UI-026). */
export const FOLLOW_SLACK_PX = 24;

/** Memoised: a new event re-renders only the new row, not the 300 already shown. `today` is the start of the page's day. */
const Row = memo(function Row({ ev, today }: { ev: FeedEvent; today: number }) {
  const label = kindLabel(ev.type);
  const t = rowTime(ev.ts, today);
  const badges = rowBadges(ev);
  const extra = rowExtras(ev);
  return (
    <article className={`ev ${rowClass(ev.type)}`} aria-label={`${label}, ${ev.type}`}>
      <time dateTime={t.iso}>{t.date ? <><span className="ev-date">{t.date}</span>{" "}</> : null}{t.clock}</time>
      <span className="k" title={ev.type}>{label}</span>
      <p>{rowText(ev)}{extra.tag ? <>{" "}<span className="tag">{extra.tag}</span></> : null}{extra.because ? <>{" "}<span className="small muted">{`because: ${extra.because}`}</span></> : null}{badges.map((b) => <span key={b} className={`badge ${b === "injected" ? "badge-inj" : "badge-mem"}`}>{b}</span>)}</p>
    </article>
  );
});

/**
 * The Activity card: a filter (All, Conversation, Vision, System), a note that times are local with the zone, the follow
 * toggle, and the rows in a `role="log"` that keeps its last 300. It follows the newest row while its end is within 24 px,
 * stops when the operator scrolls further up and says "Jump to latest" while rows keep arriving (DASH-UI-026), and is
 * `aria-busy` and dimmed while the socket is closed (DASH-UI-001).
 */
// @spec DASH-UI-001, DASH-UI-002, DASH-UI-026, DASH-UI-027, DASH-UI-030, DASH-A11Y-004
export function ActivityCard() {
  const { now } = useRuntime();
  const events = useFeed((f) => f.events);
  const loading = useFeed((f) => f.status === "connecting" && f.stoppedAt === undefined && f.events.length === 0);
  const stale = useStale();
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [following, setFollowing] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const seenId = useRef<string | undefined>(undefined);
  const visible = useMemo(() => events.filter((e) => inFilter(filter, e.type)), [events, filter]);
  const lastId = visible.at(-1)?.id;
  const clock = now();
  const today = new Date(clock).setHours(0, 0, 0, 0);

  // Rows after the last one the operator saw while following.
  const seenAt = seenId.current === undefined ? -1 : visible.findIndex((e) => e.id === seenId.current);
  const unseen = following ? 0 : visible.length - 1 - seenAt;

  useLayoutEffect(() => {
    const el = logRef.current;
    if (following) {
      seenId.current = lastId;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [following, lastId, filter, loading]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    if (atEnd !== following) setFollowing(atEnd);
  };
  const toggle = () => {
    if (following) { setFollowing(false); return; }
    setFollowing(true);
  };
  const filterLabel = FILTERS.find((f) => f.value === filter)!.label;
  const jump = !following && unseen > 0;

  return (
    <section className="card live-activity" aria-labelledby="live-activity-h">
      <div className="card-h">
        <h2 id="live-activity-h">Activity</h2>
        <SegmentedGroup legend="Show" name="live-filter" value={filter} onChange={(v) => { setFilter(v as FeedFilter); setFollowing(true); }}
          options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
        <span className="small muted grow">{`Times are local (${zoneAbbreviation(clock)}).`}</span>
        <Button size="sm" aria-pressed={jump ? undefined : following} onClick={toggle}>{jump ? "Jump to latest" : "Following latest"}</Button>
      </div>
      {loading ? <LoadingState label="Connecting to the feed…" /> : (
        <div ref={logRef} role="log" aria-label="Bus activity" aria-relevant="additions" tabIndex={0} onScroll={onScroll}
          className={`feed feed-scroll${stale.className ? ` ${stale.className}` : ""}`} aria-busy={stale["aria-busy"]}>
          {visible.length === 0 ? <EmptyState title={filter === "all" ? "No activity yet" : `No ${filterLabel.toLowerCase()} activity yet`}>Rows appear here as the co-host chats, sees, hears and speaks.</EmptyState> : null}
          {visible.map((ev) => <Row key={ev.id} ev={ev} today={today} />)}
        </div>
      )}
    </section>
  );
}
