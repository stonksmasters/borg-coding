import { createHash, randomUUID } from "node:crypto";
import { ProcessRuntime, type ProcessSnapshot } from "../../process-runtime/src/index.ts";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import axe from "axe-core";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const MAX_EVENTS = 500;
const MAX_STARTUP_SECONDS = 60;
const serverCommands = new Set(["node", "npm", "python", "python3", "dotnet", "cargo", "go"]);

export interface BrowserTaskContext {
  taskId: string;
  worktreePath: string;
}

export interface BrowserEvidenceReport {
  taskId: string;
  passed: boolean;
  issues: string[];
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
  routeChecks?: BrowserRouteEvidence[];
}

export interface BrowserRouteEvidence {
  route: string;
  name: string;
  linked: boolean;
  reached: boolean;
  renderedDistinctContent: boolean;
  finalUrl: string | null;
  issue: string | null;
}

export function routeJourneyIssue(input: Pick<BrowserRouteEvidence, "route" | "name" | "linked" | "reached" | "renderedDistinctContent">, root = { route: "/", name: "Home" }): string | null {
  if (!input.linked) return `No rendered navigation link reaches ${input.name} (${input.route}).`;
  if (!input.reached) return `The navigation link for ${input.name} did not reach ${input.route}.`;
  if (!input.renderedDistinctContent) return `${input.name} (${input.route}) renders the same page content as ${root.name} (${root.route}).`;
  return null;
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
  actionable?: boolean | null;
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
  routeChecks: BrowserRouteEvidence[];
  viewport: { width: number; height: number };
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

export function resolveTaskBrowserUrl(rawUrl: string, serverUrl: string): string {
  const server = assertLoopbackUrl(serverUrl);
  const requested = rawUrl.trim() ? assertLoopbackUrl(rawUrl) : server;
  const target = new URL(server.toString());
  target.pathname = requested.pathname;
  target.search = requested.search;
  target.hash = requested.hash;
  return target.toString();
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function safeName(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 80);
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

export class BrowserVerification {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly reports = new Map<string, BrowserEvidenceReport>();
  private readonly processRuntime: ProcessRuntime;
  private readonly environmentForTask?: (taskId: string) => Record<string, string>;

  constructor(options: { processRuntime?: ProcessRuntime; environmentForTask?: (taskId: string) => Record<string, string> } = {}) {
    this.processRuntime = options.processRuntime ?? new ProcessRuntime();
    this.environmentForTask = options.environmentForTask;
  }

  definitions() { return Object.values(browserToolDefinitions); }
  latest(taskId: string) { return this.reports.get(taskId) ?? null; }

  async ensureEvidenceForVerification(context: BrowserTaskContext, routes: Array<{ route: string; name: string }> = []) {
    const server = this.processRuntime.findRunning(context.taskId, "dev_server");
    if (!server?.url || server.status !== "running") return this.latest(context.taskId);
    await this.responsive({ url: server.url }, context);
    if (routes.length) await this.verifyLinkedRoutes(server.url, routes, context);
    return this.latest(context.taskId);
  }

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
    const hadEvidence = this.reports.has(taskId);
    const hasServer = Boolean(this.processRuntime.findRunning(taskId, "dev_server"));
    const hadSession = this.sessions.has(taskId);
    if (hadSession) this.updateReport(taskId);
    await this.close(taskId);
    if (!hadSession && (hadEvidence || hasServer)) this.updateReport(taskId);
    return this.latest(taskId);
  }

  private async startServer(input: Record<string, unknown>, context: BrowserTaskContext) {
    const existing = this.processRuntime.findRunning(context.taskId, "dev_server");
    if (existing?.status === "running" && existing.url) {
      this.updateReport(context.taskId);
      return this.serverEvidence(existing);
    }
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
    const server = await this.processRuntime.ensureServer({
      taskId: context.taskId,
      kind: "dev_server",
      label: "Development server",
      command,
      args,
      cwd,
      url,
      env: { HOST: "127.0.0.1", BROWSER: "none", ...(this.environmentForTask?.(context.taskId) ?? {}) },
      redact: Object.values(this.environmentForTask?.(context.taskId) ?? {}),
      startupTimeoutMs: numberInRange(input.timeout_seconds, 30, 1, MAX_STARTUP_SECONDS) * 1_000,
    });
    this.updateReport(context.taskId);
    return this.serverEvidence(server);
  }

  private async stopServer(taskId: string) {
    const server = this.processRuntime.findRunning(taskId, "dev_server");
    if (!server) return { stopped: false };
    const stopped = await this.processRuntime.stop(server.id);
    const evidence = stopped ? this.serverEvidence(stopped) : this.serverEvidence(server);
    const report = this.reports.get(taskId);
    if (report) this.reports.set(taskId, { ...report, capturedAt: new Date().toISOString(), server: evidence });
    return { stopped: true, server: evidence };
  }

  private serverEvidence(server: ProcessSnapshot): ServerEvidence {
    return {
      command: server.command,
      args: server.args,
      url: server.url ?? "",
      pid: server.pid,
      running: server.status === "starting" || server.status === "running",
      stdout: server.stdout,
      stderr: server.stderr,
    };
  }

  private taskServerUrl(rawUrl: string, taskId: string): string {
    const server = this.processRuntime.findRunning(taskId, "dev_server");
    if (!server?.url || server.status !== "running") throw new Error("Start the task website server before browser verification.");
    return resolveTaskBrowserUrl(rawUrl, server.url);
  }

  private async open(input: Record<string, unknown>, context: BrowserTaskContext) {
    await this.close(context.taskId);
    const url = this.taskServerUrl(String(input.url ?? ""), context.taskId);
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
      routeChecks: [],
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
    session.dom = await this.inspectDom(session.page, "body, body *", 120);
    this.updateReport(context.taskId);
    return { url: session.page.url(), title: await session.page.title(), viewport, dom: session.dom, console: session.console, network: session.network };
  }

  private async dom(input: Record<string, unknown>, context: BrowserTaskContext) {
    const session = this.requireSession(context.taskId);
    const selector = String(input.selector ?? "body").trim() || "body";
    if (selector.length > 500) throw new Error("DOM selector is too long.");
    session.dom = await this.inspectDom(session.page, selector, numberInRange(input.max_elements, 80, 1, 200));
    this.updateReport(context.taskId);
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
    session.dom = await this.inspectDom(session.page, "body, body *", 120);
    this.updateReport(context.taskId);
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
    this.updateReport(context.taskId);
    return { screenshot, report: this.latest(context.taskId) };
  }

  private async responsive(input: Record<string, unknown>, context: BrowserTaskContext) {
    const url = this.taskServerUrl(String(input.url ?? ""), context.taskId);
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
    session.dom = await this.inspectDom(session.page, "body, body *", 160);
    session.accessibility = session.responsive.at(-1)?.accessibility ?? null;
    this.updateReport(context.taskId);
    return { url, viewports: session.responsive, console: session.console, network: session.network };
  }

  private async verifyLinkedRoutes(serverUrl: string, routes: Array<{ route: string; name: string }>, context: BrowserTaskContext) {
    const session = this.requireSession(context.taskId);
    const root = routes.find((item) => item.route === "/") ?? { route: "/", name: "Home" };
    const rootUrl = new URL(root.route, serverUrl).toString();
    await session.page.goto(rootUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await session.page.waitForTimeout(150);
    const rootContent = (await session.page.locator("body").innerText()).replace(/\s+/g, " ").trim();
    const checks: BrowserRouteEvidence[] = [];
    for (const item of routes.filter((candidate) => candidate.route !== "/" && !/[:\[]/.test(candidate.route))) {
      await session.page.goto(rootUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const links = session.page.locator("a[href]");
      const hrefs = await links.evaluateAll((elements) => elements.map((element) => (element as HTMLAnchorElement).href));
      const linkIndex = hrefs.findIndex((href) => {
        try { return new URL(href).pathname === item.route; } catch { return false; }
      });
      let linked = linkIndex >= 0;
      if (linked) {
        try {
          await links.nth(linkIndex).click();
          await session.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
          await session.page.waitForTimeout(150);
        } catch {
          linked = false;
        }
      }
      const finalUrl = linked ? session.page.url() : null;
      const reached = Boolean(finalUrl && new URL(finalUrl).pathname === item.route);
      const content = linked ? (await session.page.locator("body").innerText()).replace(/\s+/g, " ").trim() : "";
      const renderedDistinctContent = reached && content.length > 0 && content !== rootContent;
      const issue = routeJourneyIssue({ route: item.route, name: item.name, linked, reached, renderedDistinctContent }, root);
      checks.push({ route: item.route, name: item.name, linked, reached, renderedDistinctContent, finalUrl, issue });
    }
    session.routeChecks = checks;
    session.dom = await this.inspectDom(session.page, "body, body *", 160);
    this.updateReport(context.taskId);
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
          actionable: (() => {
            if (html instanceof HTMLAnchorElement) return Boolean(html.href && html.getAttribute("href") && html.getAttribute("href") !== "#");
            if (!(html instanceof HTMLButtonElement)) return null;
            if (html.disabled) return true;
            if (typeof html.onclick === "function" || html.hasAttribute("onclick")) return true;
            const reactPropsKey = Object.keys(html).find((key) => key.startsWith("__reactProps$"));
            const props = reactPropsKey ? (html as unknown as Record<string, unknown>)[reactPropsKey] as Record<string, unknown> | undefined : undefined;
            if (typeof props?.onClick === "function") return true;
            if ((html.type || "submit") === "submit" && html.form) {
              if (html.form.action) return true;
              if (typeof html.form.onsubmit === "function" || html.form.hasAttribute("onsubmit")) return true;
              const formKey = Object.keys(html.form).find((key) => key.startsWith("__reactProps$"));
              const formProps = formKey ? (html.form as unknown as Record<string, unknown>)[formKey] as Record<string, unknown> | undefined : undefined;
              if (typeof formProps?.onSubmit === "function") return true;
            }
            return false;
          })(),
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

  private updateReport(taskId: string) {
    const session = this.sessions.get(taskId);
    const server = this.processRuntime.findRunning(taskId, "dev_server");
    const previous = this.reports.get(taskId);
    const dom = session?.dom ?? previous?.dom ?? [];
    const consoleEvidence = session?.console ?? previous?.console ?? [];
    const network = session?.network ?? previous?.network ?? [];
    const accessibility = session?.accessibility ?? previous?.accessibility ?? null;
    const screenshots = session?.screenshots ?? previous?.screenshots ?? [];
    const responsive = session?.responsive ?? previous?.responsive ?? [];
    const routeChecks = session?.routeChecks ?? previous?.routeChecks ?? [];
    const accessibilityResults = [accessibility, ...responsive.map((item) => item.accessibility)].filter((item): item is AccessibilityEvidence => item !== null);
    const blockingA11y = accessibilityResults.flatMap((item) => item.violations).filter((item) => item.impact === "critical" || item.impact === "serious").length;
    const issues: string[] = [];
    if (!dom.length) issues.push("No DOM evidence was captured.");
    if (!screenshots.length) issues.push("No screenshot evidence was captured.");
    const consoleErrors = consoleEvidence.filter((item) => item.level === "error").length;
    if (consoleErrors) issues.push(`${consoleErrors} browser console error(s) were captured.`);
    if (network.length) issues.push(`${network.length} failed, blocked, or HTTP-error request(s) were captured.`);
    if (blockingA11y) issues.push(`${blockingA11y} serious or critical accessibility violation(s) were captured.`);
    issues.push(...routeChecks.flatMap((check) => check.issue ? [check.issue] : []));
    const report: BrowserEvidenceReport = {
      taskId,
      passed: issues.length === 0,
      issues,
      url: session?.page.url() ?? server?.url ?? this.reports.get(taskId)?.url ?? null,
      viewport: session?.viewport ?? previous?.viewport ?? null,
      capturedAt: new Date().toISOString(),
      dom,
      console: consoleEvidence,
      network,
      accessibility,
      screenshots,
      responsive,
      server: server ? this.serverEvidence(server) : this.reports.get(taskId)?.server ?? null,
      routeChecks,
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
