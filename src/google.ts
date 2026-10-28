// Google OAuth 2.0 over plain fetch: consent URL, code exchange, refresh, revoke.

import { config, googleCallbackUrl } from "./config.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export class GoogleAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function googleAuthUrl(options: { state: string; scopes: string[]; offline?: boolean; loginHint?: string }): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: googleCallbackUrl,
    response_type: "code",
    scope: options.scopes.join(" "),
    state: options.state,
    prompt: options.offline ? "consent select_account" : "select_account",
  });
  if (options.offline) params.set("access_type", "offline");
  if (options.loginHint) params.set("login_hint", options.loginHint);
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      ...params,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new GoogleAuthError(String(data.error ?? res.status), String(data.error_description ?? data.error ?? "Google token request failed"));
  }
  return data;
}

export type CodeExchange = { email: string; refreshToken?: string; scopes: string[] };

export async function exchangeCode(code: string): Promise<CodeExchange> {
  const data = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: googleCallbackUrl });
  // The ID token comes straight from Google's token endpoint over TLS, so its signature
  // does not need checking (OpenID Connect Core 3.1.3.7). Issuer and audience still do.
  const [, payload] = String(data.id_token ?? "").split(".");
  const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8") || "{}") as Record<string, unknown>;
  const issuerOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!issuerOk || claims.aud !== config.googleClientId || claims.email_verified !== true || typeof claims.email !== "string") {
    throw new GoogleAuthError("invalid_id_token", "Google did not return a verified email address");
  }
  return {
    email: claims.email.toLowerCase(),
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    scopes: String(data.scope ?? "").split(" ").filter(Boolean),
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const data = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return { accessToken: String(data.access_token), expiresIn: Number(data.expires_in ?? 3600) };
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}
