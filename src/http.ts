// Tiny helpers over node:http so the hub needs no web framework.

import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.ts";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const body = await readBody(req, 64 * 1024);
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    const data = JSON.parse(body || "{}") as Record<string, unknown>;
    return new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)]));
  }
  return new URLSearchParams(body);
}

export function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}

export function html(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { location, "cache-control": "no-store", ...headers });
  res.end();
}

export function getCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  const secure = config.secureCookies ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#1d4ed8;--danger:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--accent:#93c5fd;--danger:#fca5a5}}
body{margin:0 auto;max-width:960px;padding:32px 16px;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:20px}small,.muted{color:var(--muted)}table{width:100%;border-collapse:collapse;margin:16px 0}
td,th{text-align:left;padding:8px 4px;border-bottom:1px solid var(--line)}code{font-size:13px;word-break:break-all}
input,select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{cursor:pointer}button.primary{background:var(--accent);color:var(--bg);border-color:var(--accent)}button.danger{color:var(--danger)}
form.inline{display:inline}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
.scroll{overflow-x:auto}td.actions{white-space:nowrap}td.actions>*{margin-right:4px}input{min-width:0}
</style></head><body>${body}</body></html>`;
}
