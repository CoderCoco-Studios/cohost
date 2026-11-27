import { createInterface } from "node:readline";

/** What a task reads and writes: standard output and error, the terminal, and standard input. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** Whether standard output is a terminal (the recovery-key notice goes there only then). */
  stdoutIsTTY: boolean;
  /** Whether standard input is a terminal (a credential is then read without echo). */
  stdinIsTTY: boolean;
  /** Reads one line from the terminal without echo, the prompt on standard error; from standard input when it is not a terminal. */
  askHidden(prompt: string): Promise<string>;
  /** Reads one line with echo, the prompt on standard error (a typed confirmation). */
  ask(prompt: string): Promise<string>;
  /** Reads standard input to its end. */
  readStdin(): Promise<string>;
}

let lines: AsyncIterator<string> | undefined;
/** The next line of standard input when it is not a terminal; empty at its end. */
async function nextLine(): Promise<string> {
  lines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const r = await lines.next();
  return r.done ? "" : r.value;
}

/** Reads a line from the terminal in raw mode, echoing nothing; Ctrl-C exits 130. */
function readHidden(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") { done(); resolve(value); return; }
        if (ch === "\u0003") { done(); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** The real process's standard streams. */
export function processIo(): CliIo {
  return {
    out: (t) => { process.stdout.write(t); },
    err: (t) => { process.stderr.write(t); },
    stdoutIsTTY: process.stdout.isTTY,
    stdinIsTTY: process.stdin.isTTY,
    askHidden: async (prompt) => {
      process.stderr.write(prompt);
      if (process.stdin.isTTY) return readHidden();
      return nextLine();
    },
    ask: async (prompt) => {
      process.stderr.write(prompt);
      return nextLine();
    },
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
