import { configLogger, type Logger } from "./logging.js";

let diagnostics: Pick<Logger, "warn"> | undefined;

/** Replace (or, with `undefined`, restore) the logger the loaders report their notices and warnings through. */
// @spec CFG-LOG-001
export function setConfigLogger(l: Pick<Logger, "warn"> | undefined): void { diagnostics = l; }

/** The logger the loaders warn through: the replacement when one is set, else the `config` logger. */
export const diag = (): Pick<Logger, "warn"> => diagnostics ?? configLogger();
