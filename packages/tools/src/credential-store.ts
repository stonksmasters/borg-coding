import { spawnSync } from "node:child_process";

export interface CredentialStore {
  get(target: string): string | null;
  set(target: string, secret: string): void;
  delete(target: string): void;
}

export class DesktopCredentialStore implements CredentialStore {
  constructor(private readonly executable = process.env.BORG_DESKTOP_EXE) {}

  get(target: string): string | null {
    if (!this.executable) return process.env.OLLAMA_API_KEY?.trim() || null;
    const result = spawnSync(this.executable, ["--credential-get", target], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  }

  set(target: string, secret: string): void {
    const clean = secret.trim();
    if (!clean) throw new Error("Credential cannot be empty.");
    if (!this.executable) throw new Error("The desktop credential bridge is unavailable. Launch BORG through the desktop application.");
    const result = spawnSync(this.executable, ["--credential-set", target], {
      input: clean,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to save credential to the OS credential store.");
  }

  delete(target: string): void {
    if (!this.executable) return;
    const result = spawnSync(this.executable, ["--credential-delete", target], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    if (result.status !== 0 && result.status !== 2) throw new Error(result.stderr.trim() || "Unable to delete credential from the OS credential store.");
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();

  get(target: string): string | null {
    return this.values.get(target) ?? null;
  }

  set(target: string, secret: string): void {
    this.values.set(target, secret);
  }

  delete(target: string): void {
    this.values.delete(target);
  }
}
