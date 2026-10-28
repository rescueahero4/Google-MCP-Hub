// All runtime configuration comes from environment variables. See .env.example.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function list(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

const signingKey = required("HUB_SIGNING_KEY");
if (signingKey.length < 32) throw new Error("HUB_SIGNING_KEY must be at least 32 characters");

const baseUrl = required("BASE_URL").replace(/\/+$/, "");

export const config = {
  port: Number(process.env.PORT ?? 8080),
  baseUrl,
  secureCookies: baseUrl.startsWith("https://"),
  ownerEmails: list(required("OWNER_EMAILS")).map((email) => email.toLowerCase()),
  googleClientId: required("GOOGLE_CLIENT_ID"),
  googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
  signingKey,
  store: process.env.STORE === "gcp" ? ("gcp" as const) : ("file" as const),
  dataFile: process.env.DATA_FILE ?? ".data/accounts.json",
  gcpProject: process.env.GCP_PROJECT ?? "",
  accountsSecret: process.env.ACCOUNTS_SECRET ?? "hub-accounts",
  // Only these OAuth redirect URIs may register as clients, so only Claude can be authorised.
  allowedRedirects: list(
    process.env.ALLOWED_REDIRECT_URIS ??
      "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback",
  ),
  // Claude Code and other local clients receive the OAuth redirect on a localhost port.
  allowLoopbackRedirects: process.env.ALLOW_LOOPBACK_REDIRECTS !== "false",
};

export const resourceUrl = `${config.baseUrl}/mcp`;
export const googleCallbackUrl = `${config.baseUrl}/oauth/google/callback`;

export function isOwner(email: string): boolean {
  return config.ownerEmails.includes(email.toLowerCase());
}
