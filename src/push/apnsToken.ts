/**
 * The token that tells Apple's push service (APNs) who is sending: an ES256 JWT signed with the team's .p8 key.
 * Pure: no I/O, no clock. `ProviderTokens` reuses one token for 50 minutes (APNs refuses one older than an hour,
 * and one renewed more often than every 20 minutes).
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

export const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

export interface ApnsCredentials {
  /** The .p8 key Apple issued. */
  key: KeyObject;
  /** The key's 10-character id. */
  keyId: string;
  /** The Apple Developer team the key belongs to. */
  teamId: string;
}

/** Reads a .p8 key (PKCS#8 PEM). Accepts literal `\n` sequences, as pasted into a config var. Throws on anything else. */
export function readApnsKey(pem: string): KeyObject {
  const text = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text.trim() + "\n", format: "pem" });
  } catch {
    throw new Error("the APNs key is not a .p8 private key (PEM)");
  }
  if (key.asymmetricKeyType !== "ec") throw new Error("the APNs key must be an EC key (the .p8 file from Apple)");
  return key;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** A provider token issued at `now` (ms since epoch). */
export function apnsToken(c: ApnsCredentials, now: number): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: c.keyId }));
  const claims = b64url(JSON.stringify({ iss: c.teamId, iat: Math.floor(now / 1000) }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: c.key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(signature)}`;
}

/** Hands out the current token and makes a new one when the old one is 50 minutes old. */
export class ProviderTokens {
  private current: { token: string; issuedAt: number } | null = null;

  constructor(private readonly credentials: ApnsCredentials) {}

  at(now: number): string {
    if (!this.current || now - this.current.issuedAt >= TOKEN_LIFETIME_MS || now < this.current.issuedAt) {
      this.current = { token: apnsToken(this.credentials, now), issuedAt: now };
    }
    return this.current.token;
  }

  /** APNs refused the token: the next push gets a fresh one. */
  reset(): void {
    this.current = null;
  }
}
