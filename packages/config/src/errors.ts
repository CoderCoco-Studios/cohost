/** What kind of fault a problem of the operator's files is (CFG-RCV-001). */
export type ConfigProblemKind = "syntax" | "placeholder" | "schema" | "secrets";

/**
 * One fault of `config.yaml` or `secrets.yaml`: the file's path, the key's dotted path (each list index written `[i]`, empty for
 * the file as a whole), the loader's message for it and its kind. No field carries a value of the file.
 */
export interface ConfigProblem {
  file: string;
  path: string;
  message: string;
  kind: ConfigProblemKind;
}

/**
 * The loader's failure for a fault of the operator's files (CFG-LOAD-003, CFG-LOAD-007, CFG-ENV-011, CFG-SEC-006): the message is
 * the readable `Invalid <file>:` text, and `problems` is the same list as data, which callers read instead of the message.
 */
// @spec CFG-RCV-001
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(message: string, readonly problems: readonly ConfigProblem[]) {
    super(message);
  }
}

/** A dotted issue path with every all-digit segment (a list index from the schema's path) written as `[i]`. */
export const bracketIndexes = (path: string): string =>
  path === "" ? "" : path.split(".").reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc === "" ? seg : `${acc}.${seg}`), "");

/** The `Invalid <file>:` message of a list of problems of one file (the issue lines name the file as a whole `(file)`). */
export const invalidMessage = (file: string, lines: readonly { path: string; message: string }[]): string =>
  `Invalid ${file}:\n${lines.map((l) => `  ${l.path || "(file)"}: ${l.message}`).join("\n")}`;
