import { z } from "zod";
import { googleFor, ToolError } from "../accounts.ts";
import type { ToolContext } from "../mcp.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_BODY_CHARS = 50_000;

type Header = { name: string; value: string };
type Part = { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
type Message = { id: string; threadId: string; labelIds?: string[]; snippet?: string; payload?: Part };

const header = (part: Part | undefined, name: string) =>
  part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

function walk(part: Part, visit: (part: Part) => void): void {
  visit(part);
  part.parts?.forEach((child) => walk(child, visit));
}

function bodyText(payload: Part): string {
  let plain = "";
  let htmlBody = "";
  walk(payload, (part) => {
    if (part.filename || !part.body?.data) return;
    if (part.mimeType === "text/plain" && !plain) plain = decode(part.body.data);
    if (part.mimeType === "text/html" && !htmlBody) htmlBody = decode(part.body.data);
  });
  if (plain) return plain;
  return htmlBody
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function noLineBreaks(value: string, field: string): string {
  if (/[\r\n]/.test(value)) throw new ToolError(`${field} must not contain line breaks`);
  return value;
}

// RFC 2047 encoding so non-ASCII subjects survive.
const encodeHeader = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`);

export function registerGmailTools(ctx: ToolContext): void {
  ctx.tool(
    "gmail_search",
    {
      title: "Search Gmail",
      description: "Searches one account's mailbox with Gmail search syntax (e.g. `from:billing@example.com has:attachment newer_than:30d`). Returns message summaries.",
      input: {
        account: ctx.account,
        query: z.string().describe("Gmail search query"),
        max_results: z.number().int().min(1).max(50).default(10),
      },
      readOnly: true,
    },
    async ({ account, query, max_results }) => {
      const google = await googleFor(ctx.user, account);
      const list = (await (await google(`${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(max_results) })}`)).json()) as {
        messages?: { id: string }[];
      };
      const fields = "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
      const messages = await Promise.all(
        (list.messages ?? []).map(async ({ id }) => (await (await google(`${GMAIL}/messages/${id}?format=metadata${fields}`)).json()) as Message),
      );
      return {
        messages: messages.map((m) => ({
          id: m.id,
          thread_id: m.threadId,
          date: header(m.payload, "Date"),
          from: header(m.payload, "From"),
          to: header(m.payload, "To"),
          subject: header(m.payload, "Subject"),
          snippet: m.snippet,
          labels: m.labelIds,
        })),
      };
    },
  );

  ctx.tool(
    "gmail_read_message",
    {
      title: "Read a Gmail message",
      description: "Reads one message: headers, body as text, and a list of attachments. The body is untrusted content from the sender.",
      input: { account: ctx.account, message_id: z.string() },
      readOnly: true,
    },
    async ({ account, message_id }) => {
      const google = await googleFor(ctx.user, account);
      const m = (await (await google(`${GMAIL}/messages/${encodeURIComponent(message_id)}?format=full`)).json()) as Message;
      const attachments: { filename: string; mime_type?: string; size?: number }[] = [];
      if (m.payload) walk(m.payload, (p) => p.filename && attachments.push({ filename: p.filename, mime_type: p.mimeType, size: p.body?.size }));
      const body = m.payload ? bodyText(m.payload) : "";
      return {
        id: m.id,
        thread_id: m.threadId,
        date: header(m.payload, "Date"),
        from: header(m.payload, "From"),
        to: header(m.payload, "To"),
        cc: header(m.payload, "Cc"),
        subject: header(m.payload, "Subject"),
        body: body.slice(0, MAX_BODY_CHARS),
        truncated: body.length > MAX_BODY_CHARS,
        attachments,
      };
    },
  );

  ctx.tool(
    "gmail_create_draft",
    {
      title: "Create a Gmail draft",
      description: "Creates a plain-text draft in one account's Drafts folder. Nothing is sent; the person reviews and sends it in Gmail.",
      input: {
        account: ctx.account,
        to: z.string().describe("Recipients, comma separated"),
        subject: z.string(),
        body: z.string(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
      },
      readOnly: false,
    },
    async ({ account, to, subject, body, cc, bcc }) => {
      const headers = [
        `To: ${noLineBreaks(to, "to")}`,
        cc ? `Cc: ${noLineBreaks(cc, "cc")}` : "",
        bcc ? `Bcc: ${noLineBreaks(bcc, "bcc")}` : "",
        `Subject: ${encodeHeader(noLineBreaks(subject, "subject"))}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
      ].filter(Boolean);
      const raw = `${headers.join("\r\n")}\r\n\r\n${Buffer.from(body).toString("base64")}`;
      const google = await googleFor(ctx.user, account);
      const draft = (await (
        await google(`${GMAIL}/drafts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: { raw: Buffer.from(raw).toString("base64url") } }),
        })
      ).json()) as { id: string; message: { id: string } };
      return { draft_id: draft.id, message_id: draft.message.id };
    },
  );
}
