import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMute } from "../state/hooks";
import { cohostName } from "../state/name";
import { AccessDialog } from "./AccessDialog";
import { ConfirmBars } from "./ConfirmBars";
import { ConnectionBanner } from "./connection";
import { RecoveryKeyBanner } from "./RecoveryKeyBanner";
import { Header } from "./Header";
import { LaunchDialogHost } from "./LaunchDialog";
import { navigate, useRoute } from "./routes";
import { SCREENS } from "./screens";
import { ShortcutHelp } from "./ShortcutHelp";
import { SinkView } from "./SinkView";
import { useShortcuts } from "./shortcuts";

/**
 * The shell: skip link, header, connection banner, the current screen in `<main>`, and the dialogs host (shortcut list,
 * Access, the launch progress dialog over every operator screen). Wrap it in `AppProviders`. With `sink` set it renders only
 * the sink view (DASH-UI-011), which never shows the launch progress dialog (DASH-UI-060).
 */
// @spec DASH-NAV-001, DASH-NAV-003, DASH-A11Y-001, DASH-A11Y-005, DASH-UI-011, DASH-UI-060
export function App({ sink = false }: { sink?: boolean }) {
  const name = useMemo(() => cohostName(), []);
  if (sink) return <SinkView name={name} />;
  return <Shell name={name} />;
}

function Shell({ name }: { name: string }) {
  const [route, go] = useRoute();
  const mute = useMute();
  const [help, setHelp] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const [sayTick, setSayTick] = useState(0);
  const wantSay = useRef(false);
  const shown = useRef<string | null>(null);

  useShortcuts({
    say: () => { wantSay.current = true; go({ view: "live" }); setSayTick((t) => t + 1); },
    view: (i) => { const s = SCREENS[i]; if (s) go({ view: s.id }); },
    mute: () => void mute.toggle(),
    help: () => setHelp(true),
  });

  // After a navigation focus moves to the new screen's heading (not on first load). `/` then focuses the Say field.
  useLayoutEffect(() => {
    const main = mainRef.current!;
    if (shown.current !== null && shown.current !== route.view) (main.querySelector<HTMLElement>("h1") ?? main).focus();
    shown.current = route.view;
    if (wantSay.current && route.view === "live") {
      const say = document.querySelector<HTMLElement>("[data-shortcut=say]");
      if (say) { say.focus(); wantSay.current = false; }
    }
  }, [route.view, sayTick]);

  const Screen = SCREENS.find((s) => s.id === route.view)!.Screen;
  return (
    <LaunchDialogHost>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Skip to main content</a>
      <Header name={name} route={route} onNavigate={navigate} mute={mute} />
      <ConnectionBanner />
      <RecoveryKeyBanner />
      <ConfirmBars />
      <main id="main" className="page" ref={mainRef} tabIndex={-1}><Screen route={route} /></main>
      <ShortcutHelp open={help} onClose={() => setHelp(false)} />
      <AccessDialog />
    </LaunchDialogHost>
  );
}
