import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { contractForWorkspace, prepareWorkspaceContract, viteReactWorkspaceDirectories, type WorkspaceKind } from "./workspace-contract.ts";

const execFileAsync = promisify(execFile);
const marker = ".borg-website.json";

export const websiteTemplates = ["saas-landing", "portfolio", "ecommerce", "dashboard", "waitlist"] as const;
export type WebsiteTemplate = typeof websiteTemplates[number];
export type WebsiteProjectStatus = "new" | "generating" | "ready" | "needs_attention" | "archived";
export type WebsiteProjectOptions = {
  template?: WebsiteTemplate;
  originalBrief?: string;
};

export const websiteWorkspaceDirectories = viteReactWorkspaceDirectories;

export function prepareWebsiteWorkspace(projectPath: string, forcedKind?: WorkspaceKind): string[] {
  const root = resolve(projectPath);
  mkdirSync(root, { recursive: true });
  const contract = contractForWorkspace(root, forcedKind ?? (!existsSync(join(root, "package.json")) ? "vite-react" : undefined));
  return prepareWorkspaceContract(root, contract);
}

const templateCopy: Record<WebsiteTemplate, { kicker: string; description: string }> = {
  "saas-landing": { kicker: "SAAS / PRODUCT", description: "A polished product canvas with room for a decisive hero, product proof, pricing, and conversion-focused calls to action." },
  portfolio: { kicker: "PORTFOLIO / STORY", description: "A portfolio canvas built to foreground personality, selected work, credibility, and a clear path to contact." },
  ecommerce: { kicker: "COMMERCE / CATALOG", description: "A commerce canvas prepared for product storytelling, collection discovery, merchandising, and confident purchase paths." },
  dashboard: { kicker: "PRODUCT / WORKSPACE", description: "An application canvas prepared for navigation, dense information, useful empty states, and responsive operational workflows." },
  waitlist: { kicker: "LAUNCH / WAITLIST", description: "A focused launch canvas designed around a crisp value proposition, trust signals, and one excellent signup journey." },
};

export function websiteRoot() {
  return resolve(process.env.BORG_WEBSITES_DIR ?? join(homedir(), "Documents", "BORG Websites"));
}

export function websiteSlug(name: string) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug || slug.length > 60) throw new Error("Choose a website name using letters or numbers (up to 60 characters).");
  return slug;
}

function packageRunner() {
  return process.platform === "win32" ? { command: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", "npm"] } : { command: "npm", prefix: [] };
}

async function run(command: string, args: string[], cwd: string, timeout = 120_000) {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd, timeout, windowsHide: true, maxBuffer: 2_000_000 });
  return `${stdout}\n${stderr}`.trim();
}

export async function createWebsiteProject(name: string, root = websiteRoot(), install?: (projectPath: string) => Promise<void>, options: WebsiteProjectOptions = {}) {
  const slug = websiteSlug(name);
  const projectPath = resolve(root, slug);
  if (existsSync(projectPath)) throw new Error(`A website named “${slug}” already exists.`);
  mkdirSync(root, { recursive: true });
  prepareWebsiteWorkspace(projectPath, "vite-react");
  const title = name.trim();
  const template = websiteTemplates.includes(options.template as WebsiteTemplate) ? options.template as WebsiteTemplate : "saas-landing";
  const starter = templateCopy[template];
  const createdAt = new Date().toISOString();
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: slug,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { dev: "vite --host 127.0.0.1", build: "tsc --noEmit && vite build" },
      dependencies: { "lucide-react": "^0.468.0", motion: "^12.23.24", react: "19.2.6", "react-dom": "19.2.6" },
      devDependencies: { "@tailwindcss/vite": "^4.1.14", "@vitejs/plugin-react": "6.0.2", tailwindcss: "^4.1.14", vite: "8.0.13", typescript: "5.9.3", "@types/node": "^22.19.19", "@types/react": "19.2.14", "@types/react-dom": "19.2.3" },
    }, null, 2) + "\n",
    "index.html": `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="theme-color" content="#0b0d0f" /><title>${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")}</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`,
    "vite.config.ts": "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport tailwindcss from '@tailwindcss/vite';\nimport { borgLocalApi } from './server/local-api';\n\nexport default defineConfig({ plugins: [react(), tailwindcss(), borgLocalApi()] });\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", useDefineForClassFields: true, lib: ["ES2022", "DOM", "DOM.Iterable"], types: ["node", "vite/client"], module: "ESNext", skipLibCheck: true, moduleResolution: "Bundler", allowImportingTsExtensions: true, resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: "react-jsx", strict: true }, include: ["src", "server", "vite.config.ts"] }, null, 2) + "\n",
    ".gitignore": "node_modules\ndist\n.env\n.env.*\n.borg/evidence\n.borg/data.sqlite*\n",
    "src/main.tsx": "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './style.css';\n\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);\n",
    "server/db.ts": `import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = resolve(".borg");
mkdirSync(dataDir, { recursive: true });
const database = new DatabaseSync(resolve(dataDir, "data.sqlite"));

database.exec(\`
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
\`);

export type LocalSubmission = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export function createSubmission(kind: string, payload: Record<string, unknown>): LocalSubmission {
  const submission = { id: randomUUID(), kind, payload, createdAt: new Date().toISOString() };
  database.prepare("INSERT INTO submissions (id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(submission.id, submission.kind, JSON.stringify(submission.payload), submission.createdAt);
  return submission;
}

export function listSubmissions(limit = 50): LocalSubmission[] {
  const rows = database.prepare("SELECT id, kind, payload_json, created_at FROM submissions ORDER BY created_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(limit, 100))) as Array<{ id: string; kind: string; payload_json: string; created_at: string }>;
  return rows.map((row) => ({ id: row.id, kind: row.kind, payload: JSON.parse(row.payload_json) as Record<string, unknown>, createdAt: row.created_at }));
}
`,
    "server/local-api.ts": `import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { createSubmission, listSubmissions } from "./db";

const MAX_BODY_BYTES = 1_000_000;

function send(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("Request body is too large.");
  }
  if (!body.trim()) return {};
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object.");
  return parsed as Record<string, unknown>;
}

export function borgLocalApi(): Plugin {
  return {
    name: "borg-local-api",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (!url.pathname.startsWith("/api/")) return next();

        try {
          if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { status: "ok" });
          if (request.method === "GET" && url.pathname === "/api/submissions") {
            const limit = Number(url.searchParams.get("limit") ?? 50);
            return send(response, 200, { submissions: listSubmissions(Number.isFinite(limit) ? limit : 50) });
          }
          if (request.method === "POST" && url.pathname === "/api/submissions") {
            const input = await readJson(request);
            const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim().slice(0, 80) : "form";
            const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload as Record<string, unknown> : input;
            return send(response, 201, { submission: createSubmission(kind, payload) });
          }
          return send(response, 404, { error: "API route not found." });
        } catch (error) {
          return send(response, 400, { error: error instanceof Error ? error.message : "Invalid API request." });
        }
      });
    },
  };
}
`,
    "src/App.tsx": `import { ArrowUpRight } from "lucide-react";
import { motion } from "motion/react";

export default function App() {
  const starter = ${JSON.stringify(starter)};
  return (
    <main className="site-shell">
      <section className="starter-hero">
        <div className="starter-kicker">{starter.kicker}</div>
        <div className="starter-grid">
          <div>
            <motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55 }}>
              ${title.replaceAll("{", "").replaceAll("}", "")}
            </motion.h1>
            <p className="starter-copy">{starter.description}</p>
          </div>
          <div className="starter-meta">
            <span>React 19</span><span>Tailwind 4</span><span>Motion</span><span>Design tokens</span>
          </div>
        </div>
        <div className="starter-rule" />
        <div className="starter-foot"><span>Awaiting art direction</span><ArrowUpRight size={16} /></div>
      </section>
    </main>
  );
}
`,
    "src/design/tokens.css": `:root {
  --color-ink: #0b0d0f;
  --color-paper: #f3f0e9;
  --color-muted: #8f949b;
  --color-line: rgba(243, 240, 233, 0.14);
  --color-accent: #b8ff5a;
  --font-display: "Arial Narrow", "Helvetica Neue", Arial, sans-serif;
  --font-body: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --container: 1240px;
  --section-space: clamp(5rem, 10vw, 9rem);
}
`,
    "src/style.css": `@import "tailwindcss";
@import "./design/tokens.css";

* { box-sizing: border-box; }
html { background: var(--color-ink); color-scheme: dark; }
body { margin: 0; min-width: 320px; min-height: 100vh; background: var(--color-ink); color: var(--color-paper); font-family: var(--font-body); text-rendering: optimizeLegibility; }
button, a { font: inherit; }
img { display: block; max-width: 100%; }
.site-shell { min-height: 100vh; }
.starter-hero { min-height: 100vh; display: flex; flex-direction: column; justify-content: space-between; width: min(calc(100% - 3rem), var(--container)); margin: 0 auto; padding: clamp(2rem, 5vw, 4rem) 0 2rem; }
.starter-kicker { color: var(--color-accent); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.18em; }
.starter-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 0.28fr); align-items: end; gap: clamp(3rem, 8vw, 9rem); }
.starter-grid h1 { max-width: 10ch; margin: 0; font-family: var(--font-display); font-size: clamp(4rem, 11vw, 9.5rem); font-weight: 600; letter-spacing: -0.065em; line-height: 0.82; text-transform: uppercase; }
.starter-copy { max-width: 45rem; margin: 2rem 0 0; color: #b6bac0; font-size: clamp(1rem, 1.5vw, 1.25rem); line-height: 1.65; }
.starter-meta { display: grid; gap: 0.6rem; color: var(--color-muted); font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase; }
.starter-rule { height: 1px; margin-top: clamp(3rem, 7vw, 7rem); background: var(--color-line); }
.starter-foot { display: flex; align-items: center; justify-content: space-between; padding-top: 1rem; color: var(--color-muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.1em; }
@media (max-width: 720px) {
  .starter-hero { width: min(calc(100% - 2rem), var(--container)); }
  .starter-grid { grid-template-columns: 1fr; align-items: start; gap: 2rem; }
  .starter-grid h1 { font-size: clamp(3.6rem, 18vw, 6.2rem); line-height: 0.86; }
  .starter-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`,
    [marker]: JSON.stringify({ id: randomUUID(), name: title, slug, framework: "vite-react", template, starterVersion: 3, designPipeline: "premium-v1", status: "new", originalBrief: options.originalBrief?.trim() || null, createdAt, lastOpenedAt: createdAt }, null, 2) + "\n",
  };
  for (const [relativePath, contents] of Object.entries(files)) writeFileSync(join(projectPath, relativePath), contents, "utf8");
  await run("git", ["init", "-b", "main"], projectPath);
  try {
    if (install) await install(projectPath);
    else {
      const npm = packageRunner();
      await run(npm.command, [...npm.prefix, "install", "--no-audit", "--no-fund"], projectPath, 300_000);
    }
  } catch (error) {
    rmSync(projectPath, { recursive: true, force: true });
    throw error;
  }
  await run("git", ["add", "."], projectPath);
  await run("git", ["-c", "user.name=BORG", "-c", "user.email=borg@local.invalid", "commit", "-m", "Bootstrap website"], projectPath);
  return { path: projectPath, slug, name: title };
}

export function websiteInfo(projectPath: string) {
  if (!isAbsolute(projectPath)) return null;
  const canonical = resolve(projectPath);
  const manifestPath = join(canonical, marker);
  if (!existsSync(manifestPath) || !existsSync(join(canonical, ".git"))) return null;
  try {
    const data = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      slug?: string;
      framework?: string;
      template?: WebsiteTemplate;
      status?: WebsiteProjectStatus;
      originalBrief?: string | null;
      createdAt?: string;
      lastOpenedAt?: string;
    };
    return data.framework === "vite-react" && typeof data.slug === "string" ? {
      path: canonical,
      name: data.name ?? data.slug,
      slug: data.slug,
      template: websiteTemplates.includes(data.template as WebsiteTemplate) ? data.template as WebsiteTemplate : "saas-landing",
      status: data.status ?? "ready",
      originalBrief: data.originalBrief ?? null,
      createdAt: data.createdAt ?? null,
      lastOpenedAt: data.lastOpenedAt ?? null,
    } : null;
  } catch { return null; }
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((ok) => server.close(() => ok()));
  return port;
}

export class WebsitePreviewManager {
  private readonly processes = new Map<string, { child: ChildProcess; url: string }>();

  async ensure(projectPath: string) {
    const website = websiteInfo(projectPath);
    if (!website) throw new Error("This session is not attached to a BORG website project.");
    const current = this.processes.get(website.path);
    if (current && current.child.exitCode === null) return { url: current.url, status: "running" as const };
    const port = await freePort();
    const npm = packageRunner();
    const child = spawn(npm.command, [...npm.prefix, "run", "dev", "--", "--port", String(port), "--strictPort"], { cwd: website.path, windowsHide: true, stdio: "ignore", env: { ...process.env, BROWSER: "none" } });
    const url = `http://127.0.0.1:${port}`;
    this.processes.set(website.path, { child, url });
    child.once("exit", () => { if (this.processes.get(website.path)?.child === child) this.processes.delete(website.path); });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) break;
      try { const result = await fetch(url, { signal: AbortSignal.timeout(500) }); if (result.ok) return { url, status: "running" as const }; } catch { /* Starting. */ }
      await new Promise((done) => setTimeout(done, 100));
    }
    child.kill();
    this.processes.delete(website.path);
    throw new Error("The website preview did not start. Check that dependencies installed correctly.");
  }

  stop(projectPath: string) {
    const current = this.processes.get(resolve(projectPath));
    if (!current) return;
    current.child.kill();
    this.processes.delete(resolve(projectPath));
  }

  stopAll() { for (const projectPath of this.processes.keys()) this.stop(projectPath); }
}
