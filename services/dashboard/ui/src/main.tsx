import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/services.css";
import "./styles/live.css";
import "./styles/access.css";
import "./styles/viewers.css";
import "./styles/settings.css";
import "./styles/tools.css";
import "./styles/recovery.css";
import "./styles/narrow.css";
import { App } from "./app/App";
import { RecoveryScreen, recoveryState } from "./app/RecoveryScreen";
import { isSinkLocation } from "./app/SinkView";
import { AppProviders } from "./app/providers";
import { createRuntime } from "./state/runtime";

// Any `sink` query parameter, whatever its value, makes this page the audio sink view (DASH-UI-011).
const sink = isSinkLocation(location.search);
const runtime = createRuntime({ sink });
const root = createRoot(document.getElementById("root")!);

// The page asks whether the dashboard is in config recovery mode before the feed socket opens (DASH-RCV-013).
void (sink ? Promise.resolve(null) : recoveryState(runtime.api)).then((recovery) => {
  root.render(
    <StrictMode>
      <AppProviders runtime={runtime} startFeed={!recovery}>
        {recovery ? <RecoveryScreen initial={recovery} /> : <App sink={sink} />}
      </AppProviders>
    </StrictMode>,
  );
});
