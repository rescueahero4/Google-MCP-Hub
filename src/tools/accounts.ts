import { config } from "../config.ts";
import type { ToolContext } from "../mcp.ts";
import type { Account } from "../store.ts";

export function registerAccountTools(ctx: ToolContext, accounts: Account[]): void {
  ctx.tool(
    "list_accounts",
    {
      title: "List connected Google accounts",
      description: "Lists the Google accounts connected to this hub: the name and email (either can be passed as `account`), tags, and access level of each.",
      input: {},
      readOnly: true,
    },
    async () => ({
      accounts: accounts.map((a) => ({ name: a.name, email: a.email, tags: a.tags, access: a.preset, connected_at: a.connectedAt })),
      manage_url: `${config.baseUrl}/`,
    }),
  );
}
