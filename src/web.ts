// Owner-only web pages: sign in, connect, rename, tag and disconnect Google accounts.
// Also the single Google OAuth callback shared by sign-in, Claude authorisation and connect.

import type { IncomingMessage, ServerResponse } from "node:http";
import { isOwner, resourceUrl } from "./config.ts";
import { exchangeCode, GoogleAuthError, googleAuthUrl, revokeToken } from "./google.ts";
import { escapeHtml, html, page, readForm, redirect } from "./http.ts";
import { type AuthorizeState, showConsent } from "./oauth.ts";
import { IDENTITY_SCOPES, isPreset, PRESETS, type Preset } from "./scopes.ts";
import { checkCsrf, clearSessionCookie, csrfToken, sessionCookie, sessionEmail } from "./session.ts";
import { forgetAccessToken } from "./accounts.ts";
import { type Account, defaultName, NAME, store, TAG } from "./store.ts";
import { sign, verify } from "./tokens.ts";

type LoginState = { purpose: "login"; next: string };
type ConnectState = { purpose: "connect"; owner: string; preset: Preset; name?: string; tags?: string[] };
type State = LoginState | ConnectState | AuthorizeState;

function message(res: ServerResponse, status: number, title: string, text: string): void {
  html(res, status, page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p><a href="/">Back to the hub</a></p>`));
}

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function requireSession(req: IncomingMessage, res: ServerResponse, url: URL): string | null {
  const email = sessionEmail(req);
  if (!email) redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  return email;
}

// Name and tags arrive as free text; returns an error message or the cleaned values.
function parseNameAndTags(
  nameInput: string | null,
  tagsInput: string | null,
): { error: string } | { name?: string; tags?: string[] } {
  const name = (nameInput ?? "").trim().toLowerCase() || undefined;
  if (name && !NAME.test(name)) return { error: "Names use lowercase letters, digits, dots, - or _ (up to 64)." };
  if (tagsInput === null) return { name };
  const tags = [...new Set(tagsInput.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > 10) return { error: "Use at most 10 tags." };
  if (!tags.every((t) => TAG.test(t))) return { error: "Tags use lowercase letters, digits, - or _ (up to 32)." };
  return { name, tags };
}

function nameTaken(accounts: Account[], name: string, email: string): boolean {
  return accounts.some((a) => a.name === name && a.email !== email);
}

export function login(url: URL, res: ServerResponse): void {
  const state = sign("state", { purpose: "login", next: safeNext(url.searchParams.get("next")) } satisfies LoginState, 600);
  redirect(res, googleAuthUrl({ state, scopes: IDENTITY_SCOPES }));
}

export function logout(res: ServerResponse): void {
  redirect(res, "/", { "set-cookie": clearSessionCookie() });
}

export async function home(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const email = requireSession(req, res, url);
  if (!email) return;
  const accounts = await store.list(email);
  const csrf = escapeHtml(csrfToken(email));
  const presets = Object.keys(PRESETS).map((p) => `<option${p === "read-write" ? " selected" : ""}>${p}</option>`).join("");
  // Name and tag inputs sit in their own cells and join the row's Save form via the form attribute.
  const rows = accounts
    .map((a, i) => {
      const id = escapeHtml(a.email);
      return `<tr>
<td><input form="edit-${i}" name="name" value="${escapeHtml(a.name)}" aria-label="Name for ${id}" size="14"></td>
<td>${id}</td>
<td><input form="edit-${i}" name="tags" value="${escapeHtml(a.tags.join(", "))}" placeholder="e.g. work" aria-label="Tags for ${id}" size="16"></td>
<td>${a.preset}</td>
<td><small>${a.connectedAt.slice(0, 10)}</small></td>
<td class="actions">
<form id="edit-${i}" method="post" action="/accounts/update" class="inline">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="email" value="${id}">
<button>Save</button></form>
<a href="/connect?${escapeHtml(new URLSearchParams({ preset: a.preset, login_hint: a.email }).toString())}"><button>Reconnect</button></a>
<form method="post" action="/accounts/disconnect" class="inline">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="email" value="${id}">
<button class="danger">Disconnect</button></form></td></tr>`;
    })
    .join("");
  const table = `<div class="scroll"><table>
<tr><th>Name</th><th>Google account</th><th>Tags</th><th>Access</th><th>Since</th><th></th></tr>${rows}</table></div>`;
  html(
    res,
    200,
    page(
      "Google MCP Hub",
      `<h1>Google MCP Hub</h1>
<p class="muted">Signed in as ${escapeHtml(email)} · <a href="/logout">Sign out</a></p>
<p>Add this URL to Claude as a custom connector:<br><code>${escapeHtml(resourceUrl)}</code></p>
<h2>Connect an account</h2>
<form method="get" action="/connect" class="row">
<input name="name" placeholder="name (optional)" size="16">
<input name="tags" placeholder="tags (optional), e.g. work" size="22">
<select name="preset">${presets}</select><button class="primary">Connect with Google</button></form>
<p class="muted">Pick the account in Google's chooser, or "Use another account". The name defaults to the part of the email
before @. Tags can be shared by several accounts. Connecting an account again refreshes it.</p>
<h2>Connected accounts</h2>
${accounts.length ? table : "<p class='muted'>None yet.</p>"}
<p class="muted">Tool calls are recorded in Cloud Logging without their contents.</p>`,
    ),
  );
}

export async function connect(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const owner = requireSession(req, res, url);
  if (!owner) return;
  const preset = url.searchParams.get("preset") ?? "read-write";
  if (!isPreset(preset)) return message(res, 400, "Invalid access level", `Choose one of: ${Object.keys(PRESETS).join(", ")}.`);
  const parsed = parseNameAndTags(url.searchParams.get("name"), url.searchParams.get("tags") || null);
  if ("error" in parsed) return message(res, 400, "Invalid name or tags", parsed.error);
  const state = sign("state", { purpose: "connect", owner, preset, ...parsed } satisfies ConnectState, 600);
  const loginHint = url.searchParams.get("login_hint") ?? undefined;
  redirect(res, googleAuthUrl({ state, scopes: [...IDENTITY_SCOPES, ...PRESETS[preset]], offline: true, loginHint }));
}

export async function update(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const owner = requireSession(req, res, url);
  if (!owner) return;
  const form = await readForm(req);
  if (!checkCsrf(owner, form.get("csrf"))) return message(res, 403, "Expired form", "Reload the page and try again.");
  const accounts = await store.list(owner);
  const account = accounts.find((a) => a.email === form.get("email"));
  if (!account) return redirect(res, "/");
  const parsed = parseNameAndTags(form.get("name"), form.get("tags") ?? "");
  if ("error" in parsed) return message(res, 400, "Invalid name or tags", parsed.error);
  const name = parsed.name ?? defaultName(account.email, accounts.filter((a) => a !== account).map((a) => a.name));
  if (nameTaken(accounts, name, account.email)) return message(res, 409, "Name in use", `Another account is already called "${name}".`);
  await store.put(owner, { ...account, name, tags: parsed.tags ?? [] });
  redirect(res, "/");
}

export async function disconnect(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const owner = requireSession(req, res, url);
  if (!owner) return;
  const form = await readForm(req);
  if (!checkCsrf(owner, form.get("csrf"))) return message(res, 403, "Expired form", "Reload the page and try again.");
  const account = (await store.list(owner)).find((a) => a.email === form.get("email"));
  if (account) {
    await store.remove(owner, account.email);
    forgetAccessToken(account);
    // Revoke at Google too, so the token is dead even if a copy leaked.
    await revokeToken(account.refreshToken);
  }
  redirect(res, "/");
}

export async function googleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const state = verify<State>("state", url.searchParams.get("state"));
  if (!state) return message(res, 400, "Sign-in expired", "Start again; the request is only valid for 10 minutes.");

  const googleError = url.searchParams.get("error");
  if (googleError) {
    if (state.purpose === "authorize") {
      const back = new URL(state.request.redirect_uri);
      back.searchParams.set("error", "access_denied");
      if (state.request.state) back.searchParams.set("state", state.request.state);
      return redirect(res, back.toString());
    }
    return message(res, 400, "Google sign-in was cancelled", googleError);
  }

  let result;
  try {
    result = await exchangeCode(url.searchParams.get("code") ?? "");
  } catch (error) {
    const detail = error instanceof GoogleAuthError ? error.message : "Unexpected error talking to Google";
    return message(res, 502, "Google sign-in failed", detail);
  }

  switch (state.purpose) {
    case "authorize":
      return showConsent(res, state, result.email);

    case "login":
      if (!isOwner(result.email)) return message(res, 403, "Not allowed", `This hub is private. ${result.email} cannot use it.`);
      return redirect(res, state.next, { "set-cookie": sessionCookie(result.email) });

    case "connect": {
      if (sessionEmail(req) !== state.owner) return message(res, 403, "Session mismatch", "Sign in to the hub again, then reconnect.");
      if (!result.refreshToken) return message(res, 502, "No offline access", "Google did not return a refresh token. Try connecting again.");
      const accounts = await store.list(state.owner);
      const previous = accounts.find((a) => a.email === result.email);
      const others = accounts.filter((a) => a.email !== result.email).map((a) => a.name);
      const name = state.name ?? previous?.name ?? defaultName(result.email, others);
      if (others.includes(name)) return message(res, 409, "Name in use", `Another account is already called "${name}". Pick a different name.`);
      // Reconnecting the same Google account refreshes it in place and keeps its name and tags.
      // The old token belongs to the same Google grant, so it must not be revoked.
      if (previous) forgetAccessToken(previous);
      await store.put(state.owner, {
        email: result.email,
        name,
        tags: state.tags ?? previous?.tags ?? [],
        preset: state.preset,
        scopes: result.scopes,
        refreshToken: result.refreshToken,
        connectedAt: new Date().toISOString(),
      });
      return redirect(res, "/");
    }
  }
}
