import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CredentialStore } from "./credential-store.ts";

export type InternetCapabilityState = "not_configured" | "configured" | "available" | "connection_failed";

export interface InternetConfiguration {
  provider: "ollama-web";
  internetEnabled: boolean;
  credentialConfigured: boolean;
  state: InternetCapabilityState;
  lastConnectionError: string | null;
  lastCheckedAt: string | null;
  updatedAt: string;
}

const DEFAULT_CONFIGURATION: InternetConfiguration = {
  provider: "ollama-web",
  internetEnabled: false,
  credentialConfigured: false,
  state: "not_configured",
  lastConnectionError: null,
  lastCheckedAt: null,
  updatedAt: new Date(0).toISOString(),
};

export class InternetConfigurationStore {
  private readonly path: string;
  private readonly credentials: CredentialStore;
  private readonly credentialTarget: string;

  constructor(
    path: string,
    credentials: CredentialStore,
    credentialTarget = "BORG Code/OllamaWebApiKey",
  ) {
    this.path = path;
    this.credentials = credentials;
    this.credentialTarget = credentialTarget;
  }

  load(): InternetConfiguration {
    let stored: Partial<InternetConfiguration> = {};
    if (existsSync(this.path)) {
      try { stored = JSON.parse(readFileSync(this.path, "utf8")) as Partial<InternetConfiguration>; }
      catch { stored = {}; }
    }
    const credentialConfigured = Boolean(this.credentials.get(this.credentialTarget));
    const internetEnabled = stored.internetEnabled === true;
    const state: InternetCapabilityState = !internetEnabled
      ? "not_configured"
      : stored.state === "connection_failed"
        ? "connection_failed"
        : stored.state === "available"
          ? "available"
          : "configured";
    return {
      ...DEFAULT_CONFIGURATION,
      ...stored,
      provider: "ollama-web",
      internetEnabled,
      credentialConfigured,
      state,
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : new Date().toISOString(),
    };
  }

  credential(): string | null {
    return this.credentials.get(this.credentialTarget);
  }

  save(input: { internetEnabled?: unknown; apiKey?: unknown; clearApiKey?: unknown }): InternetConfiguration {
    if (input.clearApiKey === true) this.credentials.delete(this.credentialTarget);
    const incoming = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (incoming) this.credentials.set(this.credentialTarget, incoming);

    const current = this.load();
    const next: InternetConfiguration = {
      ...current,
      internetEnabled: input.internetEnabled === undefined ? current.internetEnabled : input.internetEnabled === true,
      credentialConfigured: Boolean(this.credentials.get(this.credentialTarget)),
      state: input.internetEnabled === false ? "not_configured" : "configured",
      lastConnectionError: null,
      updatedAt: new Date().toISOString(),
    };
    this.write(next);
    return next;
  }

  markAvailable(): InternetConfiguration {
    const current = this.load();
    const next: InternetConfiguration = {
      ...current,
      state: current.internetEnabled ? "available" : "not_configured",
      lastConnectionError: null,
      lastCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.write(next);
    return next;
  }

  markConnectionFailed(error: string): InternetConfiguration {
    const current = this.load();
    const next: InternetConfiguration = {
      ...current,
      state: current.internetEnabled ? "connection_failed" : "not_configured",
      lastConnectionError: error,
      lastCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.write(next);
    return next;
  }

  private write(value: InternetConfiguration): void {
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
    renameSync(temporaryPath, this.path);
  }
}
