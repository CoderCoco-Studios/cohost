import { createHash, createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

/** The shortest control token the store accepts, after trimming (control-plane CTRL-CONFIG-001). */
export const MIN_TOKEN_LENGTH = 32;

/** The scrypt parameters of the token verifier; `maxmem` is stated because Node refuses N 2^15 under its 32 MiB default. */
export const TOKEN_SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** `meta.token_verifier` (STORE-TOK-002). */
export interface TokenVerifier { alg: "scrypt"; N: number; r: number; p: number; maxmem: number; salt: string; hash: string }

/** A new control token: 32 random bytes in base64url, 43 characters (STORE-TOK-001). */
export const generateToken = (): string => randomBytes(32).toString("base64url");

/** The verifier of `token` (already trimmed) with a new 16-byte salt (STORE-TOK-002). */
// @spec STORE-TOK-002
export function makeVerifier(token: string): TokenVerifier {
  const salt = randomBytes(16);
  const hash = scryptSync(token, salt, 32, TOKEN_SCRYPT);
  return { alg: "scrypt", ...TOKEN_SCRYPT, salt: salt.toString("base64url"), hash: hash.toString("base64url") };
}

/** The verifier `meta.token_verifier` holds, or undefined when the text is not one. */
export function parseVerifier(text: string | undefined): TokenVerifier | undefined {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text) as Partial<TokenVerifier>;
    if (v.alg !== "scrypt" || typeof v.salt !== "string" || typeof v.hash !== "string") return undefined;
    if (![v.N, v.r, v.p].every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)) return undefined;
    return v as TokenVerifier;
  } catch {
    return undefined;
  }
}

/** The label the ears listener key is an HMAC of (control-plane CTRL-RUNTIME-017). */
export const EARS_LISTENER_LABEL = "cohost/ears-listener/v1";

/** The ears listener key: HMAC-SHA256 keyed with the trimmed token of `EARS_LISTENER_LABEL`, 64 lowercase hex (CTRL-RUNTIME-017). */
// @spec STORE-TOK-002
export const earsListenerKey = (token: string): string => createHmac("sha256", token.trim()).update(EARS_LISTENER_LABEL).digest("hex");

const scryptAsync = (value: string, salt: Buffer, v: TokenVerifier): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(value, salt, 32, { N: v.N, r: v.r, p: v.p, maxmem: TOKEN_SCRYPT.maxmem }, (err, out) => (err ? reject(err) : resolve(out)));
  });

/** What a bearer check answers: verified, refused, or not run because too many checks are waiting. */
export type BearerResult = "ok" | "bad" | "busy";

/**
 * Checks presented bearer values against the verifier (STORE-TOK-003): scrypt with the stored parameters, `maxmem` 64 MiB,
 * compared in constant time; one computation at a time with at most four waiting, a fifth answered `busy` at once. It remembers
 * the SHA-256 of up to four values that verified against the current verifier, which then skip scrypt, and forgets them when the
 * verifier changes.
 */
// @spec STORE-TOK-003
export class BearerChecker {
  static readonly MAX_WAITING = 4;
  static readonly MAX_REMEMBERED = 4;
  private running = false;
  private readonly waiting: (() => void)[] = [];
  private remembered: string[] = [];
  private rememberedFor: string | undefined;

  /** `verifier` returns the stored verifier's text each time a check starts. */
  constructor(private readonly verifier: () => string | undefined) {}

  async check(value: string): Promise<BearerResult> {
    const text = this.verifier();
    const v = parseVerifier(text);
    if (!v || value === "") return "bad";
    if (text !== this.rememberedFor) { this.remembered = []; this.rememberedFor = text; }
    const digest = createHash("sha256").update(value).digest("hex");
    if (this.remembered.includes(digest)) return "ok";
    if (this.running) {
      if (this.waiting.length >= BearerChecker.MAX_WAITING) return "busy";
      // The finishing check hands the slot over directly: `running` stays true, so no newcomer slips in between.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running = true;
    try {
      const out = await scryptAsync(value, Buffer.from(v.salt, "base64url"), v);
      const want = Buffer.from(v.hash, "base64url");
      const ok = out.length === want.length && timingSafeEqual(out, want);
      if (ok && this.rememberedFor === text) {
        this.remembered = [digest, ...this.remembered.filter((d) => d !== digest)].slice(0, BearerChecker.MAX_REMEMBERED);
      }
      return ok ? "ok" : "bad";
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running = false;
    }
  }
}
