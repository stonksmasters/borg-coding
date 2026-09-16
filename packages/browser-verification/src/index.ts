import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import axe from "axe-core";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const MAX_EVENTS = 500;
const MAX_SERVER_LOG = 120_000;
const MAX_STARTUP_SECONDS = 60;
const serverCommands = new Set(["node", "npm", "python", "python3", "dotnet", "cargo", "go"]);

export interface BrowserTaskContext {
  taskId: string;
  worktreePath: string;
}

export interface BrowserEvidenceReport {
  taskId: string;
  url: string | null;
  viewport: { width: number; height: number } | null;
  capturedAt: string;
  dom: BrowserDomElement[];
  console: BrowserConsoleEvidence[];
  network: BrowserNetworkEvidence[];
  accessibility: AccessibilityEvidence | null;
  screenshots: ScreenshotEvidence[];
  responsive: ResponsiveEvidence[];
  server: ServerEvidence | null;
}

export interface BrowserDomElement {
  selector: string;
  tag: string;
  role: string | null;
  name: string | null;
  text: string;
  href: string | null;
  disabled: boolean;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface BrowserConsoleEvidence {
  level: string;
  text: string;
  location: string | null;
  occurredAt: string;
}

export interface BrowserNetworkEvidence {
  kind: "failed" | "http-error" | "blocked";
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  failure: string | null;
  occurredAt: string;
}

export interface AccessibilityEvidence {
  violations: {
    id: string;
    impact: string | null;
    help: string;
    helpUrl: string;
    nodes: { target: string[]; html: string; failureSummary: string | null }[];
  }[];
  incomplete: number;
  passes: number;
}

export interface ScreenshotEvidence {
  name: string;
  path: string;
  sha256: string;
  width: number;
  height: number;
  fullPage: boolean;
}

export interface ResponsiveEvidence {
  name: string;
  width: number;
  height: number;
  url: string;
  title: string;
  screenshot: ScreenshotEvidence;
  accessibility: AccessibilityEvidence | null;
}

export interface ServerEvidence {
  command: string;
  args: string[];
  url: string;
  pid: number | null;
  running: boolean;
  stdout: string;
  stderr: string;
}

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  console: BrowserConsoleEvidence[];
  network: BrowserNetworkEvidence[];
  screenshots: ScreenshotEvidence[];
  responsive: ResponsiveEvidence[];
  dom: BrowserDomElement[];
  accessibility: AccessibilityEvidence | null;
  viewport: { width: number; height: number };
}

interface ManagedServer {
  child: ChildProcess;
  command: string;
  args: string[];
  url: string;
  stdout: string;
  stderr: string;
}

export const browserToolDefinitions = {
  browser_server_start: {
    type: "function",
    function: {
      name: "browser_server_start",
      description: "Start a bounded local development server in the approved worktree and wait for its loopback URL to respond.",
      parameters: {
        type: "object",
        required: ["command", "url"],
        properties: {
          command: { type: "string", enum: [...serverCommands] },
          args: { type: "array", maxItems: 40, items: { type: "string" } },
          cwd: { type: "string" },
          url: { type: "string" },
          timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_STARTUP_SECONDS },
        },
      },
    },
  },
  browser_server_stop: {
    type: "function",
    function: { name: "browser_server_stop", description: "Stop the task's managed local development server.", parameters: { type: "object", properties: {} } },
  },
  browser_open: {
    type: "function",
    function: {
      name: "browser_open",
      description: "Open a loopback HTTP application in a controlled headless Chromium session.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          width: { type: "integer", minimum: 320, maximum: 2560 },
          height: { type: "integer", minimum: 320, maximum: 2160 },
        },
      },
    },
  },
  browser_dom: {
    type: "function",
    function: {
      name: "browser_dom",
      description: "Inspect bounded, structured DOM evidence for the current page using a CSS selector.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          max_elements: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
    },
  },
  browser_interact: {
    type: "function",
    function: {
      name: "browser_interact",
      description: "Interact with one element in the controlled page, then return updated DOM and browser evidence counts.",
      parameters: {
        type: "object",
        required: ["action", "selector"],
        properties: {
          action: { type: "string", enum: ["click", "fill", "press", "check", "uncheck", "select"] },
          selector: { type: "string" },
          value: { type: "string" },
          wait_ms: { type: "integer", minimum: 0, maximum: 5000 },
        },
      },
    },
  },
  browser_capture: {
    type: "function",
    function: {
      name: "browser_capture",
      description: "Capture a screenshot plus DOM, console, failed-network, and optional accessibility evidence for the current page.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          selector: { type: "string" },
          full_page: { type: "boolean" },
          accessibility: { type: "boolean" },
        },
      },
    },
  },
  browser_responsive: {
    type: "function",
    function: {
      name: "browser_responsive",
      description: "Verify a loopback page at bounded responsive viewports and capture screenshot and optional accessibility evidence for each.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          accessibility: { type: "boolean" },
          viewports: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              required: ["name", "width", "height"],
              properties: {
                name: { type: "string" },
                width: { type: "integer", minimum: 320, maximum: 2560 },
                height: { type: "integer", minimum: 320, maximum: 2160 },
              },
            },
          },
        },
      },
    },
  },
  browser_close: {
    type: "function",
    function: { name: "browser_close", description: "Close the task's controlled browser while preserving its latest evidence report.", parameters: { type: "object", properties: {} } },
  },
} as const;

export function assertLoopbackUrl(rawUrl: string, allowWebSocket = false): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Browser URL must be an absolute URL."); }
  const protocols = allowWebSocket ? ["http:", "https:", "ws:", "wss:"] : ["http:", "https:"];
  if (!protocols.includes(url.protocol)) throw new Error("Browser verification only supports local HTTP or HTTPS applications.");
  if (url.username || url.password) throw new Error("Browser URLs containing credentials are not allowed.");
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "[::1]") {
    throw new Error("Browser verification is restricted to loopback applications.");
  }
  return url;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function safeName(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 80);
}

function boundedLog(current: string, chunk: Buffer | string): string {
  const next = current + String(chunk);
  return next.length > MAX_SERVER_LOG ? next.slice(next.length - MAX_SERVER_LOG) : next;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Math.floor(Number(value ?? fallback));
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function browserLaunchOptions() {
  const executablePath = String(process.env.BORG_BROWSER_EXECUTABLE_PATH ?? "").trim();
  if (executablePath) {
    if (!existsSync(executablePath)) throw new Error("BORG_BROWSER_EXECUTABLE_PATH does not exist.");
    return { headless: true as const, executablePath };
  }
  const channel = String(process.env.BORG_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome")).trim();
  return { headless: true as const, channel };
}

async function waitForLoopback(url: string, timeoutSeconds: number, child: ChildProcess) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let lastError = "No response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Development server exited before becoming ready (code ${child.exitCode}).`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status >= 100) return;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await delay(250);
  }
  throw new Error(`Development server did not become ready: ${lastError}`);
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolveStop) => execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => resolveStop()));
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(1_500),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export class BrowserVerification {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly servers = new Map<string, ManagedServer>();
  private readonly reports = new Map<string, BrowserEvidenceReport>();

  definitions() { return Object.values(browserToolDefinitions); }
  latest(taskId: string) { return this.reports.get(taskId) ?? null; }

  async execute(name: string, input: Record<string, unknown>, context: BrowserTaskContext): Promise<unknown> {
    if (name === "browser_server_start") return this.startServer(input, context);
    if (name === "browser_server_stop") return this.stopServer(context.taskId);
    if (name === "browser_open") return this.open(input, context);
    if (name === "browser_dom") return this.dom(input, context);
    if (name === "browser_interact") return this.interact(input, context);
    if (name === "browser_capture") return this.capture(input, context);
    if (name === "browser_responsive") return this.responsive(input, context);
    if (name === "browser_close") return this.close(context.taskId);
    throw new Error(`Unknown browser tool: ${name}`);
  }

  async closeForVerification(taskId: string) {
    await this.close(taskId);
    await this.stopServer(taskId);
    return this.latest(taskId);
  }

  private async startServer(input: Record<string, unknown>, context: BrowserTaskContext) {
    await this.stopServer(context.taskId);
    const command = String(input.command ?? "").toLowerCase();
    if (!serverCommands.has(command)) throw new Error(`Development server command is not allowlisted: ${command}`);
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    if (args.length > 40 || args.some((argument) => argument.length > 1_000 || argument.includes("\0"))) throw new Error("Development server arguments exceed the bounded policy.");
    const url = assertLoopbackUrl(String(input.url ?? "")).toString();
    const root = realpathSync(resolve(context.worktreePath));
    const requestedCwd = String(input.cwd ?? "").trim();
    const candidateCwd = requestedCwd ? resolve(root, requestedCwd) : root;
    if (!isInside(root, candidateCwd) || !existsSync(candidateCwd)) throw new Error("Development server cwd must remain inside the approved worktree.");
    const cwd = realpathSync(candidateCwd);
    if (!isInside(root, cwd) || !statSync(cwd).isDirectory()) throw new Error("Development server cwd cannot escape through a link.");
    const executable = command === "node" ? process.execPath : command === "npm" && process.platform === "win32" ? "npm.cmd" : command;
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, HOST: "127.0.0.1", BROWSER: "none", CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const server: ManagedServer = { child, command, args, url, stdout: "", stderr: "" };
    child.stdout?.on("data", (chunk) => { server.stdout = boundedLog(server.stdout, chunk); });
    child.stderr?.on("data", (chunk) => { server.stderr = boundedLog(server.stderr, chunk); });
    this.servers.set(context.taskId, server);
    try {
      const spawnFailure = new Promise<never>((_, reject) => child.once("error", reject));
      await Promise.race([waitForLoopback(url, numberInRange(input.timeout_seconds, 30, 1, MAX_STARTUP_SECONDS), child), spawnFailure]);
    } catch (error) {
      await this.stopServer(context.taskId);
      throw error;
    }
    this.updateReport(context.taskId, context);
    return this.serverEvidence(server);
  }

  private async stopServer(taskId: string) {
    const server = this.servers.get(taskId);
    if (!server) return { stopped: false };
    await stopProcess(server.child);
    const evidence = this.serverEvidence(server);
    this.servers.delete(taskId);
    const report = this.reports.get(taskId);
    if (report) this.reports.set(taskId, { ...report, capturedAt: new Date().toISOString(), server: evidence });
    return { stopped: true, server: evidence };
  }

  private serverEvidence(server: ManagedServer): ServerEvidence {
    return {
      command: server.command,
      args: server.args,
      url: server.url,
      pid: server.child.pid ?? null,
      running: server.child.exitCode === null,
      stdout: server.stdout,
      stderr: server.stderr,
    };
  }

  private async open(input: Record<string, unknown>, context: BrowserTaskContext) {
    await this.close(context.taskId);
    const url = assertLoopbackUrl(String(input.url ?? "")).toString();
    const viewport = {
      width: numberInRange(input.width, 1440, 320, 2560),
      height: numberInRange(input.height, 900, 320, 2160),
    };
    let browser: Browser;
    try { browser = await chromium.launch(browserLaunchOptions()); }
    catch (error) {
      throw new Error(`Unable to launch Chromium. Install Chrome/Edge or set BORG_BROWSER_EXECUTABLE_PATH. ${error instanceof Error ? error.message : String(error)}`);
    }
    const browserContext = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
    const session: BrowserSession = {
      browser,
      context: browserContext,
      page: await browserContext.newPage(),
      console: [],
      network: [],
      screenshots: [],
      responsive: [],
      dom: [],
      accessibility: null,
      viewport,
    };
    this.sessions.set(context.taskId, session);
    await browserContext.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      const protocol = new URL(requestUrl).protocol;
      if (["data:", "blob:", "about:"].includes(protocol)) return route.continue();
      try { assertLoopbackUrl(requestUrl, true); }
      catch {
        this.pushNetwork(session, {
          kind: "blocked", method: route.request().method(), url: requestUrl,
          resourceType: route.request().resourceType(), status: null,
          failure: "Non-loopback browser request blocked", occurredAt: new Date().toISOString(),
        });
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    session.page.on("console", (message) => {
      if (!["warning", "error"].includes(message.type())) return;
      session.console.push({
        level: message.type(),
        text: message.text().slice(0, 10_000),
        location: message.location().url || null,
        occurredAt: new Date().toISOString(),
      });
      if (session.console.length > MAX_EVENTS) session.console.shift();
    });
    session.page.on("requestfailed", (request) => this.pushNetwork(session, {
      kind: "failed", method: request.method(), url: request.url(),
      resourceType: request.resourceType(), status: null,
      failure: request.failure()?.errorText ?? "Request failed", occurredAt: new Date().toISOString(),
    }));
    session.page.on("response", (response) => {
      if (response.status() < 400) return;
      const request = response.request();
      this.pushNetwork(session, {
        kind: "http-error", method: request.method(), url: response.url(),
        resourceType: request.resourceType(), status: response.status(),
        failure: response.statusText() || null, occurredAt: new Date().toISOString(),
      });
    });
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await session.page.waitForTimeout(250);
    session.dom = await this.inspectDom(session.page, "body", 80);
    this.updateReport(context.taskId, context);
    return { url: session.page.url(), title: await session.page.title(), viewport, dom: session.dom, console: session.console, network: session.network };
  }

  private async dom(input: Record<string, unknown>, context: BrowserTaskContext) {
    const session = this.requireSession(context.taskId);
    const selector = String(input.selector ?? "body").trim() || "body";
    if (selector.length > 500) throw new Error("DOM selector is too long.");
    session.dom = await this.inspectDom(session.page, selector, numberInRange(input.max_elements, 80, 1, 200));
    this.updateReport(context.taskId, context);
    return { url: session.page.url(), selector, elements: session.dom };
  }

  private async interact(input: Record<string, unknown>, context: BrowserTaskContext) {
    const session = this.requireSession(context.taskId);
    const action = String(input.action ?? "");
    const selector = String(input.selector ?? "").trim();
    if (!selector || selector.length > 500) throw new Error("A bounded CSS selector is required.");
    const locator = session.page.locator(selector).first();
    const value = String(input.value ?? "");
    if (action === "click") await locator.click();
    else if (action === "fill") await locator.fill(value);
    else if (action === "press") await locator.press(value);
    else if (action === "check") await locator.check();
    else if (action === "uncheck") await locator.uncheck();
    else if (action === "select") await locator.selectOption(value);
    else throw new Error("Unknown browser interaction.");
    const waitMs = numberInRange(input.wait_ms, 250, 0, 5_000);
    if (waitMs) await session.page.waitForTimeout(waitMs);
    session.dom = await this.inspectDom(session.page, "body", 80);
    this.updateReport(context.taskId, context);
    return {
      action, selector, url: session.page.url(), dom: session.dom,
      consoleWarningsAndErrors: session.console.length, failedOrBlockedRequests: session.network.length,
    };
  }

  private async capture(input: Record<string, unknown>, context: BrowserTaskContext) {
    const session = this.requireSession(context.taskId);
    const selector = String(input.selector ?? "body").trim() || "body";
    session.dom = await this.inspectDom(session.page, selector, 120);
    session.accessibility = input.accessibility === false ? null : await this.auditAccessibility(session.page);
    const screenshot = await this.screenshot(session, context, input.name, input.full_page !== false);
    this.updateReport(context.taskId, context);
    return { screenshot, report: this.latest(context.taskId) };
  }

  private async responsive(input: Record<string, unknown>, context: BrowserTaskContext) {
    const url = assertLoopbackUrl(String(input.url ?? "")).toString();
    const requested = Array.isArray(input.viewports) ? input.viewports : [];
    const viewports = (requested.length ? requested : [
      { name: "mobile", width: 390, height: 844 },
      { name: "tablet", width: 768, height: 1024 },
      { name: "desktop", width: 1440, height: 900 },
    ]).slice(0, 8).map((item) => {
      const value = item as Record<string, unknown>;
      return {
        name: safeName(value.name, "viewport"),
        width: numberInRange(value.width, 390, 320, 2560),
        height: numberInRange(value.height, 844, 320, 2160),
      };
    });
    let session = this.sessions.get(context.taskId);
    if (!session) {
      await this.open({ url, width: viewports[0].width, height: viewports[0].height }, context);
      session = this.requireSession(context.taskId);
    }
    session.responsive = [];
    for (const viewport of viewports) {
      await session.page.setViewportSize({ width: viewport.width, height: viewport.height });
      session.viewport = { width: viewport.width, height: viewport.height };
      await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await session.page.waitForTimeout(250);
      const screenshot = await this.screenshot(session, context, `responsive-${viewport.name}`, true);
      const accessibility = input.accessibility === false ? null : await this.auditAccessibility(session.page);
      session.responsive.push({
        ...viewport,
        url: session.page.url(),
        title: await session.page.title(),
        screenshot,
        accessibility,
      });
    }
    session.dom = await this.inspectDom(session.page, "body", 120);
    session.accessibility = session.responsive.at(-1)?.accessibility ?? null;
    this.updateReport(context.taskId, context);
    return { url, viewports: session.responsive, console: session.console, network: session.network };
  }

  private async screenshot(session: BrowserSession, context: BrowserTaskContext, rawName: unknown, fullPage: boolean): Promise<ScreenshotEvidence> {
    const evidenceRoot = resolve(context.worktreePath, ".borg", "evidence", "browser");
    if (!isInside(resolve(context.worktreePath), evidenceRoot)) throw new Error("Browser evidence path escaped the worktree.");
    mkdirSync(evidenceRoot, { recursive: true });
    const name = safeName(rawName, "capture");
    const fileName = `${name}-${randomUUID().slice(0, 8)}.png`;
    const absolute = join(evidenceRoot, fileName);
    await session.page.screenshot({ path: absolute, fullPage });
    const screenshot: ScreenshotEvidence = {
      name,
      path: relative(context.worktreePath, absolute).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      width: session.viewport.width,
      height: session.viewport.height,
      fullPage,
    };
    session.screenshots.push(screenshot);
    return screenshot;
  }

  private async auditAccessibility(page: Page): Promise<AccessibilityEvidence> {
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(async () => {
      type AxeResult = {
        violations: { id: string; impact: string | null; help: string; helpUrl: string; nodes: { target: string[]; html: string; failureSummary?: string }[] }[];
        incomplete: unknown[];
        passes: unknown[];
      };
      const runtime = (globalThis as unknown as { axe: { run(root: Document): Promise<AxeResult> } }).axe;
      return runtime.run(document);
    });
    return {
      violations: result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        helpUrl: violation.helpUrl,
        nodes: violation.nodes.slice(0, 20).map((node) => ({
          target: node.target,
          html: node.html.slice(0, 2_000),
          failureSummary: node.failureSummary?.slice(0, 2_000) ?? null,
        })),
      })),
      incomplete: result.incomplete.length,
      passes: result.passes.length,
    };
  }

  private async inspectDom(page: Page, selector: string, maxElements: number): Promise<BrowserDomElement[]> {
    return page.evaluate(({ selector: css, maxElements: limit }) => {
      const elements = Array.from(document.querySelectorAll(css)).slice(0, limit);
      return elements.map((element, index) => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        const explicitName = html.getAttribute("aria-label") || html.getAttribute("name") || html.getAttribute("title");
        const id = html.id ? `#${CSS.escape(html.id)}` : "";
        const classes = Array.from(html.classList).slice(0, 3).map((value) => `.${CSS.escape(value)}`).join("");
        return {
          selector: id || `${html.tagName.toLowerCase()}${classes}:nth-match(${index + 1})`,
          tag: html.tagName.toLowerCase(),
          role: html.getAttribute("role"),
          name: explicitName,
          text: (html.innerText || html.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
          href: html instanceof HTMLAnchorElement ? html.href : null,
          disabled: "disabled" in html && Boolean((html as HTMLButtonElement).disabled),
          visible: Boolean(rect.width || rect.height) && getComputedStyle(html).visibility !== "hidden",
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      });
    }, { selector, maxElements });
  }

  private pushNetwork(session: BrowserSession, evidence: BrowserNetworkEvidence) {
    session.network.push(evidence);
    if (session.network.length > MAX_EVENTS) session.network.shift();
  }

  private requireSession(taskId: string) {
    const session = this.sessions.get(taskId);
    if (!session) throw new Error("Open a loopback application with browser_open first.");
    return session;
  }

  private updateReport(taskId: string, context: BrowserTaskContext) {
    const session = this.sessions.get(taskId);
    const server = this.servers.get(taskId);
    const report: BrowserEvidenceReport = {
      taskId,
      url: session?.page.url() ?? server?.url ?? null,
      viewport: session?.viewport ?? null,
      capturedAt: new Date().toISOString(),
      dom: session?.dom ?? [],
      console: session?.console ?? [],
      network: session?.network ?? [],
      accessibility: session?.accessibility ?? null,
      screenshots: session?.screenshots ?? [],
      responsive: session?.responsive ?? [],
      server: server ? this.serverEvidence(server) : this.reports.get(taskId)?.server ?? null,
    };
    this.reports.set(taskId, report);
  }

  private async close(taskId: string) {
    const session = this.sessions.get(taskId);
    if (!session) return { closed: false, report: this.latest(taskId) };
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    this.sessions.delete(taskId);
    return { closed: true, report: this.latest(taskId) };
  }
}
