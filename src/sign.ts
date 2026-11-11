// mk2-exchange/src/sign.ts
//
// Signed requests (docs/exchange.md §7). The island signs, with the maker's
// Ed25519 key, these lines joined by newlines:
//
//   jet64-exchange-1
//   <METHOD>
//   <path and query, exactly as sent>
//   <unix seconds>
//   <SHA-256 of the body, hex; for publishing, of the disk file>
//
// and sends them as headers: x-jet-key (the public key, base64url),
// x-jet-time, x-jet-sha256 and x-jet-signature (base64url). A disk's body is
// too large to hash inside the free plan's CPU time, so for a publish the
// Worker trusts the signed hash only as a claim and the validator checks it;
// any smaller body is hashed here.

import { CLOCK_SLACK_SECONDS, SIGNED_FORM } from "./rules";

export type Signed = { ok: true; key: string; sha256: string } | { ok: false; why: string };

export function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Who signed a request. `body` is the body's text when the Worker reads it
// (its hash must match), "" when there is none, and null for a disk, whose
// hash stays a claim.
export async function signedBy(request: Request, url: URL, body: string | null): Promise<Signed> {
  const key = request.headers.get("x-jet-key") ?? "";
  const time = request.headers.get("x-jet-time") ?? "";
  const sha256 = (request.headers.get("x-jet-sha256") ?? "").toLowerCase();
  const signature = fromBase64url(request.headers.get("x-jet-signature") ?? "");
  const keyBytes = fromBase64url(key);
  if (!keyBytes || keyBytes.length !== 32 || !signature || signature.length !== 64) {
    return { ok: false, why: "the request is not signed" };
  }
  const seconds = Number(time);
  if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > CLOCK_SLACK_SECONDS) {
    return { ok: false, why: "the computer's clock is too far from the exchange's" };
  }
  if (body !== null && sha256 !== (await sha256Hex(new TextEncoder().encode(body)))) {
    return { ok: false, why: "the request's body is not the one signed" };
  }
  const message = [SIGNED_FORM, request.method, url.pathname + url.search, time, sha256].join("\n");
  const publicKey = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
  const good = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature,
                                          new TextEncoder().encode(message));
  return good ? { ok: true, key, sha256 } : { ok: false, why: "the signature does not match" };
}

// An address as a salted hash, so the exchange never keeps one.
export async function hashAddress(request: Request, salt: string): Promise<string> {
  const address = request.headers.get("cf-connecting-ip") ?? "local";
  return (await sha256Hex(new TextEncoder().encode(`${salt}\n${address}`))).slice(0, 32);
}

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
