// Stateless HMAC-signed tokens. Every piece of OAuth state (client registrations, auth codes,
// access and refresh tokens, sessions) is a signed blob, so the hub needs no database.
// Rotating HUB_SIGNING_KEY invalidates all of them at once.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

export type TokenType = "client" | "state" | "consent" | "code" | "access" | "refresh" | "session" | "csrf";

type Claims = { typ: TokenType; iat: number; exp?: number };

const key = Buffer.from(config.signingKey, "utf8");

export const now = () => Math.floor(Date.now() / 1000);

function mac(data: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

export function sign(typ: TokenType, payload: object, ttlSeconds?: number): string {
  const claims = { ...payload, typ, iat: now(), ...(ttlSeconds ? { exp: now() + ttlSeconds } : {}) };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${mac(encoded)}`;
}

export function verify<T extends object>(typ: TokenType, token: string | null | undefined): (T & Claims) | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  const expected = Buffer.from(mac(encoded));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let claims: T & Claims;
  try {
    claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims.typ !== typ) return null;
  if (typeof claims.exp === "number" && claims.exp < now()) return null;
  return claims;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
