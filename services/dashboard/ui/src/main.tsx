import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/services.css";
import "./styles/live.css";
import { App } from "./app/App";
import { AppProviders } from "./app/providers";
import { createRuntime } from "./state/runtime";

// Any `sink` query parameter, whatever its value, makes this page the audio sink view (DASH-UI-011).
const sink = new URLSearchParams(location.search).has("sink");
const runtime = createRuntime({ sink });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders runtime={runtime}>
      <App sink={sink} />
    </AppProviders>
  </StrictMode>,
);
