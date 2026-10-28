// Connected Google accounts, keyed by hub user (owner email) then Google email.
// The whole registry is one small JSON document: a local file in development,
// a single Secret Manager secret on Cloud Run. No database.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.ts";
import type { Preset } from "./scopes.ts";

// The Google email identifies an account. Name (unique) and tags (shared, free-form)
// are only there to give Claude friendlier ways to refer to accounts.
export type Account = {
  email: string;
  name: string;
  tags: string[];
  preset: Preset;
  scopes: string[];
  refreshToken: string;
  connectedAt: string;
};

type Registry = Record<string, Record<string, Account>>;

export const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const TAG = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// Default name is the part of the email before "@", made unique if another account has it.
export function defaultName(email: string, taken: string[]): string {
  const [local = "account", domain = ""] = email.split("@");
  const base = local.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "account";
  if (!taken.includes(base)) return base;
  const withDomain = `${base}-${domain.split(".")[0]}`.slice(0, 64);
  if (!taken.includes(withDomain)) return withDomain;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Registries written before names and tags existed were keyed by a unique label.
function migrate(registry: Registry): Registry {
  for (const [user, accounts] of Object.entries(registry)) {
    const migrated: Record<string, Account> = {};
    for (const raw of Object.values(accounts) as (Account & { label?: string })[]) {
      const { label, ...account } = raw;
      if (label !== undefined) {
        account.tags = [label];
        account.name = defaultName(account.email, Object.values(migrated).map((a) => a.name));
      }
      migrated[account.email] = account;
    }
    registry[user] = migrated;
  }
  return registry;
}

abstract class RegistryStore {
  private cache: { registry: Registry; loadedAt: number } | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  protected abstract load(): Promise<Registry>;
  protected abstract save(registry: Registry): Promise<void>;
  protected abstract readonly cacheMs: number;

  private async read(): Promise<Registry> {
    if (this.cache && Date.now() - this.cache.loadedAt < this.cacheMs) return this.cache.registry;
    const registry = migrate(await this.load());
    this.cache = { registry, loadedAt: Date.now() };
    return registry;
  }

  // Writes are serialised so two connects in one instance cannot overwrite each other.
  private mutate(change: (registry: Registry) => void): Promise<void> {
    const run = this.writes.then(async () => {
      this.cache = null;
      const registry = await this.read();
      change(registry);
      await this.save(registry);
      this.cache = { registry, loadedAt: Date.now() };
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  async list(user: string): Promise<Account[]> {
    const accounts = (await this.read())[user] ?? {};
    return Object.values(accounts).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Finds an account by its email or its name.
  async find(user: string, ref: string): Promise<Account | undefined> {
    const key = ref.trim().toLowerCase();
    return (await this.list(user)).find((a) => a.email === key || a.name === key);
  }

  put(user: string, account: Account): Promise<void> {
    return this.mutate((registry) => {
      registry[user] = { ...registry[user], [account.email]: account };
    });
  }

  remove(user: string, email: string): Promise<void> {
    return this.mutate((registry) => {
      delete registry[user]?.[email];
    });
  }
}

class FileStore extends RegistryStore {
  protected readonly cacheMs = 0;

  protected async load(): Promise<Registry> {
    try {
      return JSON.parse(await readFile(config.dataFile, "utf8")) as Registry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  protected async save(registry: Registry): Promise<void> {
    await mkdir(dirname(config.dataFile), { recursive: true });
    await writeFile(config.dataFile, JSON.stringify(registry, null, 2), { mode: 0o600 });
    await chmod(config.dataFile, 0o600).catch(() => undefined);
  }
}

// Talks to the Secret Manager REST API with the Cloud Run service account's token.
class SecretManagerStore extends RegistryStore {
  protected readonly cacheMs = 30_000;
  private latestVersion: string | null = null;
  private readonly secret = `https://secretmanager.googleapis.com/v1/projects/${config.gcpProject}/secrets/${config.accountsSecret}`;

  private async token(): Promise<string> {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "metadata-flavor": "Google" } },
    );
    if (!res.ok) throw new Error(`Metadata server token request failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  private async call(url: string, body?: object): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Secret Manager ${res.status}: ${await res.text()}`);
    return (await res.json()) as Record<string, unknown>;
  }

  protected async load(): Promise<Registry> {
    const data = await this.call(`${this.secret}/versions/latest:access`);
    this.latestVersion = String(data.name);
    const payload = (data.payload as { data?: string } | undefined)?.data ?? "";
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8") || "{}") as Registry;
  }

  protected async save(registry: Registry): Promise<void> {
    const previous = this.latestVersion;
    const data = await this.call(`${this.secret}:addVersion`, {
      payload: { data: Buffer.from(JSON.stringify(registry)).toString("base64") },
    });
    this.latestVersion = String(data.name);
    // Destroy the old version so removed refresh tokens do not linger in history.
    if (previous) await this.call(`https://secretmanager.googleapis.com/v1/${previous}:destroy`, {});
  }
}

export const store: RegistryStore = config.store === "gcp" ? new SecretManagerStore() : new FileStore();
