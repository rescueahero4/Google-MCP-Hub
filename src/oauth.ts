// The hub as an OAuth 2.1 authorization server for Claude, per the MCP authorization spec.
// Sign-in is delegated to Google: only an email in OWNER_EMAILS gets through, and the owner
// must then press Approve before Claude receives a token.

import type { IncomingMessage, ServerResponse } from "node:http";
import { config, isOwner, resourceUrl } from "./config.ts";
import { googleAuthUrl } from "./google.ts";
import { escapeHtml, html, json, page, readBody, readForm, redirect } from "./http.ts";
import { sessionCookie, sessionEmail } from "./session.ts";
import { IDENTITY_SCOPES } from "./scopes.ts";
import { now, sha256, sign, verify } from "./tokens.ts";

const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
const CODE_TTL = 120;

type Client = { redirect_uris: string[]; client_name: string };
type AuthRequest = { client_id: string; client_name: string; redirect_uri: string; code_challenge: string; state?: string };
type Code = { client_id: string; redirect_uri: string; code_challenge: string; email: string };
type Grant = { client_id: string; email: string };

export type AuthorizeState = { purpose: "authorize"; request: AuthRequest };

function isAllowedRedirect(uri: string): boolean {
  if (config.allowedRedirects.includes(uri)) return true;
  if (!config.allowLoopbackRedirects) return false;
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function protectedResourceMetadata(res: ServerResponse): void {
  json(res, 200, {
    resource: resourceUrl,
    authorization_servers: [config.baseUrl],
    bearer_methods_supported: ["header"],
  });
}

export function authorizationServerMetadata(res: ServerResponse): void {
  json(res, 200, {
    issuer: config.baseUrl,
    authorization_endpoint: `${config.baseUrl}/authorize`,
    token_endpoint: `${config.baseUrl}/token`,
    registration_endpoint: `${config.baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });
}

// Dynamic client registration. The client ID is a signed copy of the registration,
// and only Claude's redirect URIs are accepted.
export async function register(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = JSON.parse(await readBody(req, 16 * 1024));
  } catch {
    return json(res, 400, { error: "invalid_client_metadata", error_description: "Body must be JSON" });
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (uris.length === 0 || !uris.every(isAllowedRedirect)) {
    return json(res, 400, { error: "invalid_redirect_uri", error_description: "This hub only accepts Claude's redirect URIs" });
  }
  const client: Client = { redirect_uris: uris, client_name: String(body.client_name ?? "MCP client").slice(0, 100) };
  json(res, 201, {
    client_id: sign("client", client),
    client_id_issued_at: now(),
    ...client,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

function errorPage(res: ServerResponse, status: number, message: string): void {
  html(res, status, page("Google MCP Hub", `<h1>Cannot continue</h1><p>${escapeHtml(message)}</p>`));
}

function redirectWith(res: ServerResponse, redirectUri: string, params: Record<string, string | undefined>): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  redirect(res, url.toString());
}

export function authorize(url: URL, res: ServerResponse): void {
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const client = verify<Client>("client", clientId);
  const redirectUri = q.get("redirect_uri") ?? "";
  // Never redirect to a URI that has not been validated against the registration.
  if (!client) return errorPage(res, 400, "Unknown client. Remove and re-add the connector in Claude.");
  if (!client.redirect_uris.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
    return errorPage(res, 400, "The redirect URI does not match the client registration.");
  }
  const state = q.get("state") ?? undefined;
  if (q.get("response_type") !== "code") {
    return redirectWith(res, redirectUri, { error: "unsupported_response_type", state });
  }
  const challenge = q.get("code_challenge");
  if (!challenge || q.get("code_challenge_method") !== "S256") {
    return redirectWith(res, redirectUri, { error: "invalid_request", error_description: "PKCE with S256 is required", state });
  }
  const resource = q.get("resource");
  if (resource && resource.replace(/\/+$/, "") !== resourceUrl && resource.replace(/\/+$/, "") !== config.baseUrl) {
    return redirectWith(res, redirectUri, { error: "invalid_target", state });
  }
  const request: AuthRequest = {
    client_id: clientId,
    client_name: client.client_name,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    state,
  };
  const signedState = sign("state", { purpose: "authorize", request } satisfies AuthorizeState, 600);
  redirect(res, googleAuthUrl({ state: signedState, scopes: IDENTITY_SCOPES }));
}

// Called from the Google callback once the person signing in is known.
export function showConsent(res: ServerResponse, state: AuthorizeState, email: string): void {
  if (!isOwner(email)) {
    return errorPage(res, 403, `This hub is private. ${email} is not allowed to connect to it.`);
  }
  const { request } = state;
  const consent = sign("consent", { request, email }, 600);
  const target = new URL(request.redirect_uri);
  html(
    res,
    200,
    page(
      "Allow access",
      `<h1>Allow ${escapeHtml(request.client_name)} to use this hub?</h1>
<p>Signed in as <b>${escapeHtml(email)}</b>. Approving lets this client call every tool on your Google MCP Hub,
using the Google accounts you have connected. Access lasts until you rotate the hub signing key.</p>
<p class="muted">Returns to <code>${escapeHtml(target.origin + target.pathname)}</code></p>
<form method="post" action="/authorize/approve" class="row">
<input type="hidden" name="consent" value="${escapeHtml(consent)}">
<button class="primary" name="decision" value="approve">Approve</button>
<button name="decision" value="deny">Deny</button></form>`,
    ),
    { "set-cookie": sessionCookie(email) },
  );
}

export async function approve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req);
  const consent = verify<{ request: AuthRequest; email: string }>("consent", form.get("consent"));
  if (!consent || sessionEmail(req) !== consent.email || !isOwner(consent.email)) {
    return errorPage(res, 403, "This approval has expired or was not started by you. Start the connection again from Claude.");
  }
  const { request } = consent;
  if (form.get("decision") !== "approve") {
    return redirectWith(res, request.redirect_uri, { error: "access_denied", state: request.state });
  }
  const code = sign(
    "code",
    { client_id: request.client_id, redirect_uri: request.redirect_uri, code_challenge: request.code_challenge, email: consent.email } satisfies Code,
    CODE_TTL,
  );
  redirectWith(res, request.redirect_uri, { code, state: request.state, iss: config.baseUrl });
}

// Codes are single-use within an instance. With max-instances=1 that covers the whole hub;
// the short TTL and PKCE cover the rest.
const usedCodes = new Map<string, number>();

function markCodeUsed(code: string): boolean {
  const t = now();
  for (const [key, exp] of usedCodes) if (exp < t) usedCodes.delete(key);
  const key = sha256(code);
  if (usedCodes.has(key)) return false;
  usedCodes.set(key, t + CODE_TTL);
  return true;
}

function issueTokens(res: ServerResponse, grant: Grant): void {
  json(res, 200, {
    access_token: sign("access", { ...grant, aud: resourceUrl }, ACCESS_TTL),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: sign("refresh", grant, REFRESH_TTL),
    scope: "mcp",
  });
}

export async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req);
  let clientId = form.get("client_id") ?? "";
  const basic = req.headers.authorization?.match(/^Basic (.+)$/i)?.[1];
  if (!clientId && basic) clientId = decodeURIComponent(Buffer.from(basic, "base64").toString("utf8").split(":")[0] ?? "");
  if (!verify<Client>("client", clientId)) return json(res, 401, { error: "invalid_client" });

  const invalidGrant = (description: string) => json(res, 400, { error: "invalid_grant", error_description: description });

  switch (form.get("grant_type")) {
    case "authorization_code": {
      const raw = form.get("code") ?? "";
      const code = verify<Code>("code", raw);
      if (!code || code.client_id !== clientId) return invalidGrant("Code is invalid or expired");
      if (code.redirect_uri !== form.get("redirect_uri")) return invalidGrant("redirect_uri mismatch");
      if (sha256(form.get("code_verifier") ?? "") !== code.code_challenge) return invalidGrant("PKCE verification failed");
      if (!isOwner(code.email)) return invalidGrant("User is no longer allowed");
      if (!markCodeUsed(raw)) return invalidGrant("Code already used");
      return issueTokens(res, { client_id: clientId, email: code.email });
    }
    case "refresh_token": {
      const grant = verify<Grant>("refresh", form.get("refresh_token"));
      if (!grant || grant.client_id !== clientId) return invalidGrant("Refresh token is invalid or expired");
      if (!isOwner(grant.email)) return invalidGrant("User is no longer allowed");
      return issueTokens(res, { client_id: clientId, email: grant.email });
    }
    default:
      return json(res, 400, { error: "unsupported_grant_type" });
  }
}

// Resolves the bearer token on an /mcp request to the owner's email, or answers 401.
export function authenticate(req: IncomingMessage, res: ServerResponse): string | null {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  const claims = verify<Grant & { aud: string }>("access", bearer);
  if (claims && claims.aud === resourceUrl && isOwner(claims.email)) return claims.email;
  const metadata = `${config.baseUrl}/.well-known/oauth-protected-resource/mcp`;
  const error = bearer ? `, error="invalid_token"` : "";
  json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${metadata}"${error}` });
  return null;
}
