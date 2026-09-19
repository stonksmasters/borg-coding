import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const workspaceKinds = ["vite-react", "next-app-router", "next-pages-router", "react-custom", "existing-custom"] as const;
export type WorkspaceKind = typeof workspaceKinds[number];

export type WorkspaceContract = {
  kind: WorkspaceKind;
  directories: string[];
  requiredFiles: string[];
  sourceRoots: string[];
  expectedPackages: string[];
  expectedScripts: string[];
};

export const viteReactWorkspaceDirectories = [
  "src",
  "src/assets",
  "src/components",
  "src/components/layout",
  "src/components/ui",
  "src/data",
  "src/design",
  "src/features",
  "src/hooks",
  "src/lib",
  "src/pages",
  "src/sections",
  "src/styles",
  "src/types",
  "public",
  "server",
  "server/lib",
  "server/routes",
  "server/services",
  ".localcode",
  ".localcode/build",
] as const;

function packageJson(root: string): Record<string, unknown> | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function packageNames(pkg: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  if (!pkg) return names;
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const values = pkg[key];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const name of Object.keys(values as Record<string, unknown>)) names.add(name);
  }
  return names;
}

function under(base: string, name: string) {
  return base ? `${base}/${name}` : name;
}

function sourceBase(root: string) {
  return existsSync(join(root, "src")) ? "src" : "";
}

function nextContract(root: string, kind: "next-app-router" | "next-pages-router"): WorkspaceContract {
  const base = sourceBase(root);
  const routeRoot = under(base, kind === "next-app-router" ? "app" : "pages");
  return {
    kind,
    directories: [
      routeRoot,
      under(base, "components"),
      under(base, "components/ui"),
      under(base, "features"),
      under(base, "hooks"),
      under(base, "lib"),
      under(base, "styles"),
      under(base, "types"),
      "public",
      ".localcode",
      ".localcode/build",
    ],
    requiredFiles: ["package.json"],
    sourceRoots: [routeRoot],
    expectedPackages: ["next", "react"],
    expectedScripts: ["dev", "build"],
  };
}

export function contractForWorkspace(rootPath: string, forcedKind?: WorkspaceKind): WorkspaceContract {
  const root = resolve(rootPath);
  const pkg = packageJson(root);
  const packages = packageNames(pkg);
  const base = sourceBase(root);
  const hasApp = existsSync(join(root, "app")) || existsSync(join(root, "src", "app"));
  const hasPages = existsSync(join(root, "pages")) || existsSync(join(root, "src", "pages"));

  const kind: WorkspaceKind = forcedKind
    ?? (packages.has("next")
      ? hasPages && !hasApp ? "next-pages-router" : "next-app-router"
      : packages.has("vite") && packages.has("react")
        ? "vite-react"
        : packages.has("react")
          ? "react-custom"
          : "existing-custom");

  if (kind === "vite-react") {
    return {
      kind,
      directories: [...viteReactWorkspaceDirectories],
      requiredFiles: ["package.json"],
      sourceRoots: ["src"],
      expectedPackages: ["vite", "react"],
      expectedScripts: ["dev", "build"],
    };
  }
  if (kind === "next-app-router" || kind === "next-pages-router") return nextContract(root, kind);
  if (kind === "react-custom") {
    const directories = base
      ? [
          "src",
          "src/components",
          "src/components/ui",
          "src/features",
          "src/hooks",
          "src/lib",
          "src/styles",
          "src/types",
          "public",
          ".localcode",
          ".localcode/build",
        ]
      : ["public", ".localcode", ".localcode/build"];
    return {
      kind,
      directories,
      requiredFiles: ["package.json"],
      sourceRoots: base ? ["src"] : [],
      expectedPackages: ["react"],
      expectedScripts: [],
    };
  }
  return {
    kind,
    directories: [".localcode", ".localcode/build"],
    requiredFiles: [],
    sourceRoots: [],
    expectedPackages: [],
    expectedScripts: [],
  };
}

export function prepareWorkspaceContract(rootPath: string, contract: WorkspaceContract): string[] {
  const root = resolve(rootPath);
  if (!existsSync(root)) throw new Error("Workspace root does not exist.");
  if (!lstatSync(root).isDirectory()) throw new Error("Workspace root is not a directory.");
  const created: string[] = [];
  for (const directory of contract.directories) {
    const target = join(root, directory);
    if (existsSync(target)) {
      if (!lstatSync(target).isDirectory()) throw new Error(`Workspace contract path is not a directory: ${directory}`);
      continue;
    }
    mkdirSync(target, { recursive: true });
    created.push(directory);
  }
  return created;
}

