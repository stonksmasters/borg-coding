import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CredentialStore } from "./credential-store.ts";

export interface ProjectEnvironmentVariable {
  name: string;
  hasValue: boolean;
}

interface ProjectEnvironmentMetadata {
  version: 1;
  projects: Record<string, { repositoryPath: string; names: string[] }>;
}

const EMPTY_METADATA: ProjectEnvironmentMetadata = { version: 1, projects: {} };

function projectKey(repositoryPath: string): string {
  return createHash("sha256").update(repositoryPath.trim().toLowerCase()).digest("hex").slice(0, 32);
}

function validateName(name: string): string {
  const value = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("Use a valid environment variable name.");
  return value;
}

export class ProjectEnvironmentStore {
  private readonly path: string;
  private readonly credentials: CredentialStore;

  constructor(path: string, credentials: CredentialStore) {
    this.path = path;
    this.credentials = credentials;
  }

  list(repositoryPath: string): ProjectEnvironmentVariable[] {
    const metadata = this.load();
    const key = projectKey(repositoryPath);
    const names = metadata.projects[key]?.names ?? [];
    return [...names].sort().map((name) => ({
      name,
      hasValue: this.credentials.get(this.target(key, name)) !== null,
    }));
  }

  values(repositoryPath: string): Record<string, string> {
    const metadata = this.load();
    const key = projectKey(repositoryPath);
    const result: Record<string, string> = {};
    for (const name of metadata.projects[key]?.names ?? []) {
      const value = this.credentials.get(this.target(key, name));
      if (value !== null) result[name] = value;
    }
    return result;
  }

  set(repositoryPath: string, rawName: string, value: string): ProjectEnvironmentVariable[] {
    const name = validateName(rawName);
    if (!value.length) throw new Error("Enter a value to save.");
    const metadata = this.load();
    const key = projectKey(repositoryPath);
    this.credentials.set(this.target(key, name), value);
    const project = metadata.projects[key] ?? { repositoryPath, names: [] };
    metadata.projects[key] = {
      repositoryPath,
      names: [...new Set([...project.names, name])].sort(),
    };
    this.write(metadata);
    return this.list(repositoryPath);
  }

  delete(repositoryPath: string, rawName: string): ProjectEnvironmentVariable[] {
    const name = validateName(rawName);
    const metadata = this.load();
    const key = projectKey(repositoryPath);
    this.credentials.delete(this.target(key, name));
    const project = metadata.projects[key];
    if (project) {
      project.names = project.names.filter((value) => value !== name);
      if (!project.names.length) delete metadata.projects[key];
      this.write(metadata);
    }
    return this.list(repositoryPath);
  }

  private target(key: string, name: string): string {
    return `BORG Code/ProjectEnv/${key}/${name}`;
  }

  private load(): ProjectEnvironmentMetadata {
    if (!existsSync(this.path)) return { ...EMPTY_METADATA, projects: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ProjectEnvironmentMetadata>;
      if (parsed.version !== 1 || !parsed.projects || typeof parsed.projects !== "object") return { ...EMPTY_METADATA, projects: {} };
      return { version: 1, projects: parsed.projects };
    } catch {
      return { ...EMPTY_METADATA, projects: {} };
    }
  }

  private write(value: ProjectEnvironmentMetadata): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    renameSync(temporary, this.path);
  }
}
