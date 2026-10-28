// Browser session for the owner: set after Google sign-in, required for the account pages
// and for approving a Claude connection.

import type { IncomingMessage } from "node:http";
import { isOwner } from "./config.ts";
import { cookie, getCookie } from "./http.ts";
import { sign, verify } from "./tokens.ts";

const NAME = "hub_session";
const TTL = 12 * 60 * 60;

export function sessionCookie(email: string): string {
  return cookie(NAME, sign("session", { email }, TTL), TTL);
}

export function clearSessionCookie(): string {
  return cookie(NAME, "", 0);
}

export function sessionEmail(req: IncomingMessage): string | null {
  const session = verify<{ email: string }>("session", getCookie(req, NAME));
  return session && isOwner(session.email) ? session.email : null;
}

// Form tokens bind a POST to the signed-in owner, so other sites cannot submit it.
export function csrfToken(email: string): string {
  return sign("csrf", { email }, TTL);
}

export function checkCsrf(email: string, token: string | null): boolean {
  return verify<{ email: string }>("csrf", token)?.email === email;
}
