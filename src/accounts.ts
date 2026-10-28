// Turns (hub user, account name or email) into authenticated Google API calls.
// Access tokens are cached in memory only and never logged.

import { config } from "./config.ts";
import { GoogleAuthError, refreshAccessToken } from "./google.ts";
import { type Account, store } from "./store.ts";
import { sha256 } from "./tokens.ts";

// Thrown for problems the person can fix; the message is shown to Claude as-is.
export class ToolError extends Error {}

const accessTokens = new Map<string, { token: string; expiresAt: number }>();

const cacheKey = (account: Account) => sha256(account.refreshToken);

export function forgetAccessToken(account: Account): void {
  accessTokens.delete(cacheKey(account));
}

function reconnectUrl(account: Account, preset: string = account.preset): string {
  return `${config.baseUrl}/connect?${new URLSearchParams({ preset, login_hint: account.email })}`;
}

async function accessToken(account: Account): Promise<string> {
  const cached = accessTokens.get(cacheKey(account));
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  try {
    const { accessToken, expiresIn } = await refreshAccessToken(account.refreshToken);
    accessTokens.set(cacheKey(account), { token: accessToken, expiresAt: Date.now() + (expiresIn - 300) * 1000 });
    return accessToken;
  } catch (error) {
    if (error instanceof GoogleAuthError && error.code === "invalid_grant") {
      throw new ToolError(`Google access for "${account.name}" (${account.email}) has expired or was revoked. Reconnect it at ${reconnectUrl(account)}`);
    }
    throw error;
  }
}

async function describeFailure(res: Response, account: Account): Promise<ToolError> {
  const text = await res.text();
  let detail = text.slice(0, 300);
  try {
    detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
  } catch {}
  if (res.status === 403 && /insufficient|scope/i.test(text)) {
    return new ToolError(
      `Account "${account.name}" is connected with "${account.preset}" access, which does not allow this. ` +
        `Reconnect it with read-write access at ${reconnectUrl(account, "read-write")}`,
    );
  }
  return new ToolError(`Google returned ${res.status} for "${account.name}": ${detail}`);
}

export type Google = (url: string, init?: RequestInit) => Promise<Response>;

// Returns a fetch bound to one connected account, found by name or email.
// Non-2xx responses become ToolErrors.
export async function googleFor(user: string, ref: string): Promise<Google> {
  const account = await store.find(user, ref);
  if (!account) {
    const known = (await store.list(user)).map((a) => `${a.name} (${a.email})`);
    throw new ToolError(`No account "${ref}". Connected: ${known.join(", ") || "none"}. Connect one at ${config.baseUrl}/`);
  }
  return async (url, init = {}) => {
    const call = async () =>
      fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await accessToken(account)}` } });
    let res = await call();
    if (res.status === 401) {
      forgetAccessToken(account);
      res = await call();
    }
    if (!res.ok) throw await describeFailure(res, account);
    return res;
  };
}
