// Registers happy-dom as the global DOM. Import this FIRST in every UI test file (before React or Testing Library),
// so `window`, `document` and the element classes exist when those modules load. Each test file runs in its own
// process under `node --test`, so the registration is per file.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!("document" in globalThis)) GlobalRegistrator.register({ url: "http://localhost:3000/", width: 1024, height: 768 });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Whether this happy-dom version implements the `<dialog>` API the components rely on. A test that needs it can
 * assert this first, so a regression in the emulation reads as that, not as a component bug.
 */
export function dialogSupported(): boolean {
  const d = document.createElement("dialog");
  document.body.append(d);
  try {
    d.showModal();
    const opened = d.open;
    d.close();
    return typeof d.showModal === "function" && opened && !d.open;
  } finally { d.remove(); }
}
