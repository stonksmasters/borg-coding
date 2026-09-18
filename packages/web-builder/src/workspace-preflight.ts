import { accessSync, constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { contractForWorkspace, prepareWorkspaceContract, type WorkspaceContract, type WorkspaceKind } from "./workspace-contract.ts";

export type WorkspacePreflightIssue = {
  code: string;
  severity: "repair" | "warning" | "fatal";
  message: string;
};

export type WorkspacePreflightReport = {
  root: string;
  reason: string;
  contract: WorkspaceContract;
  passed: boolean;
  repairedDirectories: string[];
  issues: WorkspacePreflightIssue[];
  gitHead: string | null;
  dependencyState: "not_applicable" | "configured" | "install_missing";
};

function samePath(left: string, right: string) {
  const normalize = (value: string) => resolve(value).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function readPackage(root: string): { value: Record<string, unknown> | null; error: string | null } {
  const path = join(root, "package.json");
  if (!existsSync(path)) return { value: null, error: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { value: null, error: "package.json must contain a JSON object." };
    return { value: parsed as Record<string, unknown>, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : "package.json is invalid JSON." };
  }
}

function configuredPackages(pkg: Record<string, unknown> | null) {
  const names = new Set<string>();
  if (!pkg) return names;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const values = pkg[field];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const name of Object.keys(values as Record<string, unknown>)) names.add(name);
  }
  return names;
}

export function runWorkspacePreflight(rootPath: string, options: {
  reason?: string;
  repair?: boolean;
  expectedKind?: WorkspaceKind;
} = {}): WorkspacePreflightReport {
  const root = resolve(rootPath);
  const reason = options.reason ?? "slice_start";
  const issues: WorkspacePreflightIssue[] = [];
  const fallbackContract = contractForWorkspace(root, options.expectedKind);
  const baseReport = (overrides: Partial<WorkspacePreflightReport> = {}): WorkspacePreflightReport => ({
    root,
    reason,
    contract: fallbackContract,
    passed: false,
    repairedDirectories: [],
    issues,
    gitHead: null,
    dependencyState: "not_applicable",
    ...overrides,
  });

  if (!existsSync(root)) {
    issues.push({ code: "workspace_missing", severity: "fatal", message: "The approved workspace no longer exists." });
    return baseReport();
  }
  if (!lstatSync(root).isDirectory()) {
    issues.push({ code: "workspace_not_directory", severity: "fatal", message: "The approved workspace path is not a directory." });
    return baseReport();
  }

  try {
    accessSync(root, constants.R_OK | constants.W_OK);
  } catch {
    issues.push({ code: "workspace_not_writable", severity: "fatal", message: "The approved workspace is not readable and writable by BORG." });
  }

  let gitHead: string | null = null;
  try {
    const gitRoot = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    gitHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null;
    if (!samePath(gitRoot, root)) {
      issues.push({ code: "worktree_root_mismatch", severity: "fatal", message: `Approved workspace resolves inside a different Git root: ${gitRoot}` });
    }
  } catch {
    issues.push({ code: "git_worktree_invalid", severity: "fatal", message: "The approved workspace is not a valid Git worktree." });
  }

  const packageResult = readPackage(root);
  if (packageResult.error) issues.push({ code: "package_json_invalid", severity: "fatal", message: `package.json could not be parsed: ${packageResult.error}` });

  const detected = contractForWorkspace(root);
  const contract = options.expectedKind ? contractForWorkspace(root, options.expectedKind) : detected;
  if (options.expectedKind && detected.kind !== "existing-custom" && detected.kind !== options.expectedKind) {
    issues.push({
      code: "workspace_contract_mismatch",
      severity: "fatal",
      message: `Expected a ${options.expectedKind} workspace but detected ${detected.kind}.`,
    });
  }

  let repairedDirectories: string[] = [];
  if (options.repair !== false && !issues.some((issue) => issue.severity === "fatal")) {
    try {
      repairedDirectories = prepareWorkspaceContract(root, contract);
      for (const directory of repairedDirectories) {
        issues.push({ code: "directory_repaired", severity: "repair", message: `Recreated required workspace directory: ${directory}` });
      }
    } catch (error) {
      issues.push({ code: "workspace_repair_failed", severity: "fatal", message: error instanceof Error ? error.message : "Workspace repair failed." });
    }
  }

  for (const file of contract.requiredFiles) {
    if (!existsSync(join(root, file))) issues.push({ code: "required_file_missing", severity: "fatal", message: `Required project file is missing: ${file}` });
  }
  for (const sourceRoot of contract.sourceRoots) {
    const path = join(root, sourceRoot);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) {
      issues.push({ code: "source_root_missing", severity: "fatal", message: `Expected source root is missing: ${sourceRoot}` });
      continue;
    }
    try {
      accessSync(path, constants.R_OK | constants.W_OK);
    } catch {
      issues.push({ code: "source_root_not_writable", severity: "fatal", message: `Source root is not writable: ${sourceRoot}` });
    }
  }

  const packageNames = configuredPackages(packageResult.value);
  for (const expectedPackage of contract.expectedPackages) {
    if (!packageNames.has(expectedPackage)) issues.push({ code: "dependency_manifest_missing", severity: "warning", message: `Expected package is not declared: ${expectedPackage}` });
  }
  const scripts = packageResult.value?.scripts;
  const scriptRecord = scripts && typeof scripts === "object" && !Array.isArray(scripts) ? scripts as Record<string, unknown> : {};
  for (const expectedScript of contract.expectedScripts) {
    if (typeof scriptRecord[expectedScript] !== "string") issues.push({ code: "project_script_missing", severity: "warning", message: `Expected package script is not configured: ${expectedScript}` });
  }

  let dependencyState: WorkspacePreflightReport["dependencyState"] = "not_applicable";
  if (packageResult.value) {
    dependencyState = existsSync(join(root, "node_modules")) ? "configured" : "install_missing";
    if (dependencyState === "install_missing") {
      issues.push({ code: "dependency_install_missing", severity: "warning", message: "node_modules is not present in this worktree; verification may need dependency preparation." });
    }
  }

  return {
    root,
    reason,
    contract,
    passed: !issues.some((issue) => issue.severity === "fatal"),
    repairedDirectories,
    issues,
    gitHead,
    dependencyState,
  };
}

export function preflightFailureMessage(report: WorkspacePreflightReport) {
  const fatal = report.issues.filter((issue) => issue.severity === "fatal").map((issue) => issue.message);
  return fatal.length ? fatal.join(" ") : "Workspace preflight failed.";
}
