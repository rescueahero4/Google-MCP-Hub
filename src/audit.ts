// One structured log line per tool call. Cloud Run forwards stdout JSON to Cloud Logging.
// Arguments are hashed, never logged, so no message bodies or queries end up in logs.

import { sha256 } from "./tokens.ts";

export function audit(entry: { user: string; account?: string; tool: string; args: unknown; ms: number; outcome: string }): void {
  const { args, ...rest } = entry;
  console.log(JSON.stringify({ severity: "INFO", message: "tool_call", ...rest, argsHash: sha256(JSON.stringify(args)).slice(0, 16) }));
}
