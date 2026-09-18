import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const marker = ".borg-website.json";

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

export async function createWebsiteProject(name: string, root = websiteRoot(), install?: (projectPath: string) => Promise<void>) {
  const slug = websiteSlug(name);
  const projectPath = resolve(root, slug);
  if (existsSync(projectPath)) throw new Error(`A website named “${slug}” already exists.`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(projectPath, "src"), { recursive: true });
  const title = name.trim();
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: slug, version: "0.1.0", private: true, type: "module", scripts: { dev: "vite --host 127.0.0.1", build: "vite build" }, dependencies: { react: "19.2.6", "react-dom": "19.2.6" }, devDependencies: { "@vitejs/plugin-react": "6.0.2", vite: "8.0.13", typescript: "5.9.3", "@types/react": "19.2.14", "@types/react-dom": "19.2.3" } }, null, 2) + "\n",
    "index.html": `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")}</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`,
    "vite.config.ts": "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", useDefineForClassFields: true, lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", skipLibCheck: true, moduleResolution: "Bundler", allowImportingTsExtensions: true, resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: "react-jsx", strict: true }, include: ["src", "vite.config.ts"] }, null, 2) + "\n",
    ".gitignore": "node_modules\ndist\n.env\n.env.*\n",
    "src/main.tsx": "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport './style.css';\n\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><main><p className=\"eyebrow\">BORG WEBSITE</p><h1>Your website starts here.</h1><p>Describe what you want to build in BORG, then watch it take shape.</p></main></React.StrictMode>);\n",
    "src/style.css": "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#f9fafb;font-family:Inter,ui-sans-serif,system-ui,sans-serif}main{max-width:720px;padding:3rem}.eyebrow{color:#a7ff4f;font-size:.75rem;letter-spacing:.2em}h1{font-size:clamp(2.5rem,8vw,5rem);line-height:1.05;margin:1rem 0}main>p:last-child{color:#aeb8c8;font-size:1.2rem;line-height:1.6}\n",
    [marker]: JSON.stringify({ id: randomUUID(), name: title, slug, framework: "vite-react", createdAt: new Date().toISOString() }, null, 2) + "\n",
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
    const data = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; slug?: string; framework?: string };
    return data.framework === "vite-react" && typeof data.slug === "string" ? { path: canonical, name: data.name ?? data.slug, slug: data.slug } : null;
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
