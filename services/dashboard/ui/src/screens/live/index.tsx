import { PageHeading } from "../../components/PageHeading";
import type { ScreenProps } from "../../app/screens";
import { ActivityCard } from "./ActivityCard";
import { AvatarCard } from "./AvatarCard";

/**
 * The Live screen: the Activity feed, the avatar, Say a line, test inputs and Wipe context. Two columns above 1000 px
 * (the feed, then a 380 px column), one column below with Say a line first (`styles/live.css`).
 */
// @spec DASH-UI-005
export function Screen(_props: ScreenProps) {
  return (
    <>
      <PageHeading>Live</PageHeading>
      <div className="live-grid">
        <ActivityCard />
        <AvatarCard />
      </div>
    </>
  );
}
