"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bot, Check, ChevronRight, Circle, CircleStop, Clock3, Download, FileText, FolderGit2, GitCommit, Globe2, History, KeyRound, Play, Settings2, ShieldCheck, User, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

type StageStatus = "pending" | "active" | "complete" | "failed";
type Stage = { name: string; status: StageStatus };
type Message = { id: string; role: "user" | "assistant" | "system" | "tool"; text: string };
type AccessConfig = { repositoryPath: string | null; documents: string[]; repositoryName: string | null; documentNames: string[]; updatedAt: string };
type ToolConfig = { internetEnabled: boolean; webFetchAvailable: boolean; webSearchAvailable: boolean; apiKeyInMemory: boolean; updatedAt: string };
type VisionConfig = { enabled: boolean; provider: "ollama"; model: string; maxScreenshots: number; timeoutMs: number; blockingSeverity: "medium" | "high" | "critical"; configured: boolean; updatedAt: string };
type Approval = { id: string; taskId: string; status: "REQUESTED" | "APPROVED" | "REJECTED"; worktreePath: string | null; baseCommit: string | null };
type Finding = { severity: string; title: string; description: string; file?: string; line?: number };
type EngineeringRole = "architect" | "implementer" | "verifier" | "reviewer";
type EngineeringDiscipline = "general" | "frontend" | "backend" | "database" | "security" | "qa" | "devops" | "infrastructure";
type SpecialistPackRef = { id: string; version: number; discipline: EngineeringDiscipline };
type RoleAssignment = { id: string; taskId: string; role: EngineeringRole; discipline: EngineeringDiscipline; model: string | null; attempt: number; status: "pending" | "active" | "completed" | "failed"; capabilities: string[]; specialistPacks: SpecialistPackRef[]; createdAt: string; startedAt: string | null; completedAt: string | null };
type Handoff = { id: string; taskId: string; fromRole: EngineeringRole; toRole: EngineeringRole; objective: string; requiredNextAction: string; createdAt: string };
type DisciplineRoute = { primary: EngineeringDiscipline; disciplines: EngineeringDiscipline[]; reasons: string[] };
type BaselineCandidate = { profileId: string; screenshotName: string; candidatePath: string; candidateSha256: string; width: number; height: number };
type VisualRegressionReport = {
  status: "disabled" | "pass" | "regression" | "missing-baseline" | "dimension-mismatch" | "failed";
  passed: boolean;
  summary: string;
  comparisons: {
    profileId: string;
    screenshotName: string;
    status: "pass" | "regression" | "missing-baseline" | "dimension-mismatch" | "failed";
    candidate: { path: string; sha256: string; width: number; height: number };
    changedPixels: number;
    changedPixelRatio: number;
    diff: { path: string; sha256: string } | null;
  }[];
};
type StreamEvent = {
  type: string;
  task?: { id: string; request: string; state: string };
  taskId?: string;
  text?: string;
  message?: string;
  state?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown> & { query?: string; url?: string; results?: { title: string; url: string }[]; passed?: boolean; path?: string };
  approval?: Approval;
  worktreePath?: string;
  status?: { stdout?: string };
  diff?: { stdout?: string };
  review?: { verdict: "pass" | "repair"; summary: string; findings: Finding[] };
  visionReview?: { status: "disabled" | "pass" | "repair" | "inconclusive" | "unavailable" | "failed"; summary: string; model: string; findings: Finding[]; screenshots: { path: string; sha256: string; width: number; height: number }[] };
  visualRegression?: VisualRegressionReport;
  assignment?: RoleAssignment;
  handoff?: Handoff;
  route?: DisciplineRoute;
  packs?: SpecialistPackRef[];
  attempt?: number;
  maximum?: number;
};

declare global {
  interface Document {
    modelContext?: {
      registerTool(tool: {
        name: string;
        title?: string;
        description: string;
        inputSchema: object;
        annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
        execute(input: unknown): unknown | Promise<unknown>;
      }, options?: { signal?: AbortSignal }): void | Promise<void>;
    };
  }
}

const emptyStages: Stage[] = ["Discovery", "Plan", "Implementation", "Verification", "Review", "Delivery"].map((name) => ({ name, status: "pending" }));

function stagesForState(state: string): Stage[] {
  const activeByState: Record<string, number> = { DISCOVERING: 0, PLANNING: 1, IMPLEMENTING: 2, VERIFYING: 3, REVIEWING: 4, DELIVERY_READY: 5, DELIVERING: 5 };
  const active = activeByState[state];
  if (state === "COMPLETE") return emptyStages.map((stage) => ({ ...stage, status: "complete" }));
  if (state === "AWAITING_APPROVAL") return emptyStages.map((stage, index) => ({ ...stage, status: index < 2 ? "complete" : "pending" }));
  if (active === undefined) return emptyStages.map((stage) => ({ ...stage }));
  return emptyStages.map((stage, index) => ({ ...stage, status: index < active ? "complete" : index === active ? "active" : "pending" }));
}

export function BorgWorkspace() {
  const [mode, setMode] = useState("plan");
  const [request, setRequest] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(false);
  const [runtimeConnected, setRuntimeConnected] = useState(false);
  const [modelName, setModelName] = useState("qwen3-coder:30b");
  const [accessConfig, setAccessConfig] = useState<AccessConfig | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [repositoryDraft, setRepositoryDraft] = useState("");
  const [documentsDraft, setDocumentsDraft] = useState("");
  const [accessError, setAccessError] = useState("");
  const [savingAccess, setSavingAccess] = useState(false);
  const [toolConfig, setToolConfig] = useState<ToolConfig | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [internetDraft, setInternetDraft] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [savingTools, setSavingTools] = useState(false);
  const [toolsError, setToolsError] = useState("");
  const [visionConfig, setVisionConfig] = useState<VisionConfig | null>(null);
  const [visionEnabledDraft, setVisionEnabledDraft] = useState(false);
  const [visionModelDraft, setVisionModelDraft] = useState("qwen3-vl:8b");
  const [visionBlockingDraft, setVisionBlockingDraft] = useState<"medium" | "high" | "critical">("high");
  const [activeTitle, setActiveTitle] = useState("New task");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskState, setTaskState] = useState("READY");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState("");
  const [deliveryReady, setDeliveryReady] = useState(false);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [deliveryError, setDeliveryError] = useState("");
  const [baselineCandidates, setBaselineCandidates] = useState<BaselineCandidate[]>([]);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const [baselineError, setBaselineError] = useState("");
  const [activeRole, setActiveRole] = useState<RoleAssignment | null>(null);
  const [disciplineRoute, setDisciplineRoute] = useState<DisciplineRoute | null>(null);
  const [activePacks, setActivePacks] = useState<SpecialistPackRef[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [stages, setStages] = useState<Stage[]>(emptyStages);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const actionLabel = useMemo(() => (streaming ? "Stop" : "Send"), [streaming]);

  useEffect(() => {
    fetch("http://127.0.0.1:4311/health").then(async (response) => {
      const health = await response.json() as { runtimeConnected?: boolean; modelAvailable?: boolean; model?: string };
      setServerAvailable(response.ok);
      setRuntimeConnected(Boolean(health.runtimeConnected && health.modelAvailable));
      if (health.model) setModelName(health.model);
    }).catch(() => { setServerAvailable(false); setRuntimeConnected(false); });
  }, []);

  useEffect(() => {
    fetch("http://127.0.0.1:4311/api/tools").then(async (response) => {
      if (!response.ok) throw new Error("Unable to load tool settings");
      const result = await response.json() as { tools: ToolConfig };
      setToolConfig(result.tools);
      setInternetDraft(result.tools.internetEnabled);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch("http://127.0.0.1:4311/api/vision").then(async (response) => {
      if (!response.ok) throw new Error("Unable to load vision settings");
      const result = await response.json() as { vision: VisionConfig };
      setVisionConfig(result.vision);
      setVisionEnabledDraft(result.vision.enabled);
      setVisionModelDraft(result.vision.model);
      setVisionBlockingDraft(result.vision.blockingSeverity);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch("http://127.0.0.1:4311/api/access").then(async (response) => {
      if (!response.ok) throw new Error("Unable to load access settings");
      const result = await response.json() as { access: AccessConfig };
      setAccessConfig(result.access);
      setRepositoryDraft(result.access.repositoryPath ?? "");
      setDocumentsDraft(result.access.documents.join("\n"));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch("http://127.0.0.1:4311/api/tasks?projectId=borg-code").then(async (response) => {
      if (!response.ok) return;
      const result = await response.json() as { tasks?: { id: string; request: string; state: string }[] };
      const latest = result.tasks?.[0];
      if (!latest || !["AWAITING_APPROVAL", "DELIVERY_READY"].includes(latest.state)) return;
      const detailResponse = await fetch(`http://127.0.0.1:4311/api/tasks/${encodeURIComponent(latest.id)}/approval`);
      if (!detailResponse.ok) return;
      const detail = await detailResponse.json() as { approval?: Approval; events?: { type: string; payload: Record<string, unknown> }[]; roleAssignments?: RoleAssignment[]; handoffs?: Handoff[] };
      if (!detail.approval) return;
      const responseEvent = detail.events?.findLast((event) => event.type === "MODEL_RESPONSE_COMPLETED");
      const answer = typeof responseEvent?.payload.answer === "string" ? responseEvent.payload.answer : "The saved plan is ready for approval.";
      setActiveTaskId(latest.id);
      setActiveTitle(latest.request);
      setTaskState(latest.state);
      setStages(stagesForState(latest.state));
      setApproval(detail.approval);
      setDeliveryReady(latest.state === "DELIVERY_READY");
      const restoredRole = detail.roleAssignments?.findLast((assignment) => assignment.status === "active") ?? null;
      setActiveRole(restoredRole);
      setActivePacks(restoredRole?.specialistPacks ?? detail.roleAssignments?.at(-1)?.specialistPacks ?? []);
      const latestHandoff = detail.handoffs?.at(-1);
      setMessages([{ id: crypto.randomUUID(), role: "assistant", text: answer }, { id: crypto.randomUUID(), role: "system", text: latest.state === "DELIVERY_READY" ? "This verified task is ready for delivery." : "This approval was restored from the durable task history." }, ...(latestHandoff ? [{ id: crypto.randomUUID(), role: "system" as const, text: `Latest handoff: ${latestHandoff.fromRole} → ${latestHandoff.toRole}. ${latestHandoff.requiredNextAction}` }] : [])]);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const applyEvent = useCallback((event: StreamEvent) => {
    if (event.type === "task.created" && event.task) {
      setActiveTaskId(event.task.id);
      setActiveTitle(event.task.request);
      setTaskState(event.task.state);
      setStages(stagesForState(event.task.state));
    } else if (event.type === "task.state" && event.state) {
      setTaskState(event.state);
      setStages(stagesForState(event.state));
      setDeliveryReady(event.state === "DELIVERY_READY");
    } else if (event.type === "discipline.routed" && event.route) {
      const route = event.route;
      setDisciplineRoute(route);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `Routed to ${route.primary} with ${route.disciplines.join(", ")} coverage.` }]);
    } else if (event.type === "specialist.packs.selected" && event.packs) {
      setActivePacks(event.packs);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `Activated specialist packs: ${event.packs?.map((pack) => `${pack.id}@${pack.version}`).join(", ")}.` }]);
    } else if (event.type === "role.started" && event.assignment) {
      setActiveRole(event.assignment);
      setActivePacks(event.assignment.specialistPacks);
    } else if (event.type === "role.completed" && event.assignment) {
      setActiveRole((current) => current?.id === event.assignment?.id ? null : current);
    } else if (event.type === "role.handoff" && event.handoff) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `${event.handoff?.fromRole} → ${event.handoff?.toRole}: ${event.handoff?.requiredNextAction}` }]);
    } else if (event.type === "message.delta" && event.text) {
      setMessages((current) => {
        const last = current.at(-1);
        if (last?.role === "assistant") return [...current.slice(0, -1), { ...last, text: last.text + event.text }];
        return [...current, { id: crypto.randomUUID(), role: "assistant", text: event.text ?? "" }];
      });
    } else if (event.type === "runtime.connected") {
      setRuntimeConnected(true);
      setTaskState("RESPONDING");
    } else if (event.type === "stage.updated") {
      const stageName = "stage" in event ? String(event.stage) : "";
      const status = "status" in event ? String(event.status) as StageStatus : "pending";
      setStages((current) => current.map((stage) => stage.name === stageName ? { ...stage, status } : stage));
    } else if (event.type === "stream.completed") {
      setTaskState((current) => ["AWAITING_APPROVAL", "DELIVERY_READY", "COMPLETE"].includes(current) ? current : "RESPONSE COMPLETE");
    } else if (event.type === "approval.requested" && event.approval) {
      setApproval(event.approval);
      setTaskState("AWAITING_APPROVAL");
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: event.message ?? "Review the plan before continuing." }]);
    } else if (event.type === "runtime.waiting") {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: event.message ?? "Agent runtime is waiting." }]);
      setTaskState("WAITING FOR RUNTIME");
    } else if (event.type === "runtime.notice") {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: event.message ?? "BORG is completing the task from the evidence collected so far." }]);
    } else if (event.type === "repair.scheduled") {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `Repair attempt ${event.attempt ?? ""} of ${event.maximum ?? 2}: ${event.message ?? "BORG is correcting the evidenced failure."}` }]);
    } else if (event.type === "review.completed" && event.review) {
      const review = event.review;
      const findings = review.findings.length ? `\n\n${review.findings.map((finding) => `${finding.severity.toUpperCase()}: ${finding.title}${finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : ""}\n${finding.description}`).join("\n\n")}` : "\n\nNo findings.";
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `Fresh review: ${review.summary}${findings}` }]);
    } else if (event.type === "vision.review.started") {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "tool", text: "Reviewing captured screenshots with the configured local vision model." }]);
    } else if (event.type === "vision.review.completed" && event.visionReview) {
      const review = event.visionReview;
      const findings = review.findings.length ? `\n\n${review.findings.map((finding) => `${finding.severity.toUpperCase()}: ${finding.title}${finding.file ? ` (${finding.file})` : ""}\n${finding.description}`).join("\n\n")}` : "\n\nNo visual findings.";
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `Local vision review [${review.status.toUpperCase()}] · ${review.model}: ${review.summary}${findings}` }]);
    } else if (event.type === "visual.regression.completed" && event.visualRegression) {
      const report = event.visualRegression;
      const details = report.comparisons.length
        ? `\n\n${report.comparisons.map((comparison) => `${comparison.profileId}/${comparison.screenshotName}: ${comparison.status} · ${comparison.changedPixels} changed pixel(s) (${(comparison.changedPixelRatio * 100).toFixed(3)}%)`).join("\n")}`
        : "";
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `Visual regression [${report.status.toUpperCase()}]: ${report.summary}${details}` }]);
      setBaselineCandidates(report.comparisons.filter((comparison) => comparison.status === "missing-baseline").map((comparison) => ({
        profileId: comparison.profileId,
        screenshotName: comparison.screenshotName,
        candidatePath: comparison.candidate.path,
        candidateSha256: comparison.candidate.sha256,
        width: comparison.candidate.width,
        height: comparison.candidate.height,
      })));
    } else if (event.type === "delivery.ready") {
      setDeliveryReady(true);
      setTaskState("DELIVERY_READY");
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: event.message ?? "Verified changes are ready for delivery." }]);
    } else if (event.type === "stream.blocked") {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: event.message ?? "The task needs attention." }]);
      setTaskState("BLOCKED");
    } else if (event.type === "runtime.failed" || event.type === "stream.failed") {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: event.message ?? "The live stream stopped unexpectedly." }]);
      setTaskState("FAILED");
    } else if (event.type === "tool.started") {
      const detail = event.tool === "web_search" ? `Searching the web for “${String(event.input?.query ?? "") }”`
        : event.tool === "web_fetch" ? `Reading ${String(event.input?.url ?? "a web page")}`
        : event.tool === "repository_list" ? `Listing repository files in ${String(event.input?.path ?? ".")}`
        : event.tool === "repository_read" ? `Reading repository file ${String(event.input?.path ?? "")}`
        : event.tool === "repository_search" ? `Searching repository for “${String(event.input?.query ?? "") }”`
        : event.tool === "worktree_read" ? `Reading worktree file ${String(event.input?.path ?? "")}`
        : event.tool === "worktree_patch" ? `Patching worktree file ${String(event.input?.path ?? "")}`
        : event.tool === "worktree_command" ? `Running bounded command ${String(event.input?.command ?? "")}`
        : event.tool === "git_status" ? "Inspecting worktree Git status"
        : event.tool === "git_diff" ? "Reviewing the worktree diff"
        : event.tool === "verification_run" ? `Running ${String(event.input?.profile ?? "quick")} verification`
        : `Running ${event.tool ?? "tool"}`;
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "tool", text: detail }]);
    } else if (event.type === "tool.completed") {
      const results = event.output?.results;
      const detail = results?.length ? `Sources found:\n${results.map((result) => `${result.title}\n${result.url}`).join("\n\n")}`
        : event.tool?.startsWith("repository_") ? `Repository inspection completed: ${event.tool.replace("repository_", "")}.`
        : event.tool === "worktree_patch" ? `Patched ${String(event.output?.path ?? "the approved worktree")}.`
        : event.tool === "verification_run" ? `Verification ${event.output?.passed ? "passed" : "failed"}.`
        : event.tool?.startsWith("git_") ? `Git inspection completed: ${event.tool.replace("git_", "")}.`
        : event.tool?.startsWith("worktree_") ? `Worktree tool completed: ${event.tool.replace("worktree_", "")}.`
        : `Finished reading ${event.output?.url ?? "the requested page"}.`;
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "tool", text: detail }]);
    } else if (event.type === "implementation.summary") {
      const status = event.status?.stdout?.trim() || "Clean worktree";
      const diff = event.diff?.stdout?.trim() || "No diff produced";
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `Implementation complete in ${event.worktreePath ?? "the approved worktree"}.\n\nGit status:\n${status}\n\nDiff:\n${diff}` }]);
    } else if (event.type === "tool.failed") {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `${event.tool ?? "Tool"} failed: ${event.message ?? "Unknown error"}` }]);
    }
  }, []);

  async function saveAccess() {
    setSavingAccess(true);
    setAccessError("");
    try {
      const response = await fetch("http://127.0.0.1:4311/api/access", {
        method: "POST",
        body: JSON.stringify({ repositoryPath: repositoryDraft.trim() || null, documents: documentsDraft.split("\n").map((item) => item.trim()).filter(Boolean) }),
      });
      const result = await response.json() as { access?: AccessConfig; error?: string };
      if (!response.ok || !result.access) throw new Error(result.error ?? "Unable to save access settings");
      setAccessConfig(result.access);
      setAccessOpen(false);
    } catch (error) { setAccessError(error instanceof Error ? error.message : "Unable to save access settings"); }
    finally { setSavingAccess(false); }
  }

  async function saveTools() {
    setSavingTools(true);
    setToolsError("");
    try {
      const [toolResponse, visionResponse] = await Promise.all([
        fetch("http://127.0.0.1:4311/api/tools", { method: "POST", body: JSON.stringify({ internetEnabled: internetDraft, ollamaApiKey: apiKeyDraft }) }),
        fetch("http://127.0.0.1:4311/api/vision", { method: "POST", body: JSON.stringify({ enabled: visionEnabledDraft, model: visionModelDraft, blockingSeverity: visionBlockingDraft }) }),
      ]);
      const toolResult = await toolResponse.json() as { tools?: ToolConfig; error?: string };
      const visionResult = await visionResponse.json() as { vision?: VisionConfig; error?: string };
      if (!toolResponse.ok || !toolResult.tools) throw new Error(toolResult.error ?? "Unable to save tool settings");
      if (!visionResponse.ok || !visionResult.vision) throw new Error(visionResult.error ?? "Unable to save vision settings");
      setToolConfig(toolResult.tools);
      setVisionConfig(visionResult.vision);
      setApiKeyDraft("");
      setToolsOpen(false);
    } catch (error) { setToolsError(error instanceof Error ? error.message : "Unable to save tool settings"); }
    finally { setSavingTools(false); }
  }

  async function decideApproval(decision: "approve" | "reject") {
    if (!activeTaskId || !approval || approval.status !== "REQUESTED") return;
    setApprovalBusy(true);
    setApprovalError("");
    try {
      const response = await fetch(`http://127.0.0.1:4311/api/tasks/${encodeURIComponent(activeTaskId)}/approval`, { method: "POST", body: JSON.stringify({ decision }) });
      const result = await response.json() as { task?: { state: string }; approval?: Approval; worktree?: { path: string; baseCommit: string }; error?: string };
      if (!response.ok || !result.task || !result.approval) throw new Error(result.error ?? "Unable to record approval");
      setApproval(result.approval);
      setTaskState(result.task.state);
      if (decision === "approve") {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `Approved. BORG is implementing inside the isolated worktree at ${result.worktree?.path ?? result.approval?.worktreePath}.` }]);
        await runApprovedTask(activeTaskId);
      } else setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: "Plan rejected. No worktree was created and the task was cancelled." }]);
    } catch (error) { setApprovalError(error instanceof Error ? error.message : "Unable to record approval"); }
    finally { setApprovalBusy(false); }
  }

  async function runApprovedTask(taskId: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    try {
      const response = await fetch(`http://127.0.0.1:4311/api/tasks/${encodeURIComponent(taskId)}/execute`, { method: "POST", signal: controller.signal });
      if (!response.ok || !response.body) {
        const failure = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(failure.error ?? "The approved implementation stream did not start.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) applyEvent(JSON.parse(line) as StreamEvent);
        if (done) break;
      }
      if (buffer.trim()) applyEvent(JSON.parse(buffer) as StreamEvent);
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: error instanceof Error ? error.message : "Approved implementation failed." }]);
        setTaskState("FAILED");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  async function acceptVisualBaselines() {
    if (!activeTaskId || !baselineCandidates.length || baselineBusy) return;
    setBaselineBusy(true);
    setBaselineError("");
    try {
      const response = await fetch(`http://127.0.0.1:4311/api/tasks/${encodeURIComponent(activeTaskId)}/visual-baselines`, {
        method: "POST",
        body: JSON.stringify({ candidates: baselineCandidates }),
      });
      const result = await response.json() as { accepted?: { path: string }[]; error?: string };
      if (!response.ok || !result.accepted) throw new Error(result.error ?? "Unable to accept visual baselines");
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "system",
        text: `Accepted ${result.accepted!.length} visual baseline(s) into the isolated worktree. They will be included in delivery.`,
      }]);
      setBaselineCandidates([]);
    } catch (error) {
      setBaselineError(error instanceof Error ? error.message : "Unable to accept visual baselines");
    } finally {
      setBaselineBusy(false);
    }
  }

  async function deliverTask(method: "export" | "commit") {
    if (!activeTaskId || !deliveryReady || deliveryBusy) return;
    setDeliveryBusy(true);
    setDeliveryError("");
    try {
      const response = await fetch(`http://127.0.0.1:4311/api/tasks/${encodeURIComponent(activeTaskId)}/delivery`, { method: "POST", body: JSON.stringify({ method }) });
      const result = await response.json() as { task?: { state: string }; delivery?: { path?: string; commit?: string }; error?: string };
      if (!response.ok || !result.task || !result.delivery) throw new Error(result.error ?? "Delivery failed");
      setTaskState(result.task.state);
      setStages(stagesForState(result.task.state));
      setDeliveryReady(false);
      const detail = method === "export" ? `Patch exported to ${result.delivery.path}.` : `Committed in the isolated worktree as ${result.delivery.commit}.`;
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: `${detail} Your primary checkout was not changed.` }]);
    } catch (error) { setDeliveryError(error instanceof Error ? error.message : "Delivery failed"); }
    finally { setDeliveryBusy(false); }
  }

  const runTask = useCallback(async (prompt: string) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || streaming) return { ok: false, reason: "A task is already running or the request is empty." };
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setActiveTitle(cleanPrompt);
    setActiveTaskId(null);
    setTaskState("CREATING");
    setApproval(null);
    setDeliveryReady(false);
    setDeliveryError("");
    setBaselineCandidates([]);
    setBaselineError("");
    setApprovalError("");
    setActiveRole(null);
    setDisciplineRoute(null);
    setActivePacks([]);
    setStages(emptyStages.map((stage) => ({ ...stage })));
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: cleanPrompt }]);

    try {
      const response = await fetch("http://127.0.0.1:4311/api/chat", {
        method: "POST",
        body: JSON.stringify({ projectId: "borg-code", request: cleanPrompt, mode }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("The BORG server did not open a stream.");
      setServerAvailable(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) applyEvent(JSON.parse(line) as StreamEvent);
        if (done) break;
      }
      if (buffer.trim()) applyEvent(JSON.parse(buffer) as StreamEvent);
      return { ok: true, taskId: activeTaskId };
    } catch (error) {
      if (!controller.signal.aborted) {
        setServerAvailable(false);
        setTaskState("OFFLINE");
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: error instanceof Error ? error.message : "Unable to reach the BORG server." }]);
      }
      return { ok: false, reason: error instanceof Error ? error.message : "Unknown error" };
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [activeTaskId, applyEvent, mode, streaming]);

  useEffect(() => {
    if (!document.modelContext?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(document.modelContext.registerTool({
      name: "create_borg_task",
      title: "Create BORG task",
      description: "Submit an engineering request to BORG and show its live event stream in the workspace.",
      inputSchema: { type: "object", properties: { request: { type: "string", minLength: 1 } }, required: ["request"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        const requestValue = typeof input === "object" && input !== null && "request" in input ? String((input as { request: unknown }).request) : "";
        if (!requestValue.trim()) throw new Error("request must be a non-empty string");
        return runTask(requestValue);
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [runTask]);

  return (
    <SidebarProvider>
      <Dialog open={accessOpen} onOpenChange={setAccessOpen}>
        <DialogContent className="border-white/10 bg-[#11161e] text-slate-100 sm:max-w-xl">
          <DialogHeader><DialogTitle>Repository access</DialogTitle><DialogDescription>BORG reads only the repository and supporting text files you approve here. Clear the fields to revoke access.</DialogDescription></DialogHeader>
          <div className="space-y-5 py-2">
            <label className="block"><span className="mb-2 block text-sm font-medium text-slate-300">Repository folder</span><Input value={repositoryDraft} onChange={(event) => setRepositoryDraft(event.target.value)} placeholder="C:\path\to\your\repository" className="border-white/10 bg-white/4 text-slate-100" /><span className="mt-2 block text-xs text-slate-500">Read-only context. Dependency folders, build output, Git internals, and secret-like files are excluded.</span></label>
            <label className="block"><span className="mb-2 block text-sm font-medium text-slate-300">Additional documents</span><textarea value={documentsDraft} onChange={(event) => setDocumentsDraft(event.target.value)} placeholder={"C:\\path\\to\\requirements.md\nC:\\path\\to\\notes.txt"} rows={5} className="w-full resize-y rounded-md border border-white/10 bg-white/4 px-3 py-2 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:border-[#a7ff4f]/50 focus:ring-2 focus:ring-[#a7ff4f]/15" /><span className="mt-2 block text-xs text-slate-500">One absolute path per line. Text, source, JSON, YAML, CSV, and Markdown are supported.</span></label>
            {accessError && <p className="rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{accessError}</p>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setAccessOpen(false)} className="border-white/10 bg-transparent text-slate-300 hover:bg-white/5 hover:text-white">Cancel</Button><Button onClick={() => void saveAccess()} disabled={savingAccess} className="bg-[#a7ff4f] text-[#071007] hover:bg-[#b5ff6f]">{savingAccess ? "Saving…" : "Save access"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={toolsOpen} onOpenChange={setToolsOpen}>
        <DialogContent className="border-white/10 bg-[#11161e] text-slate-100 sm:max-w-xl">
          <DialogHeader><DialogTitle>Tool access</DialogTitle><DialogDescription>Control which external capabilities the local model may invoke. Every call appears in the live task transcript.</DialogDescription></DialogHeader>
          <div className="space-y-5 py-2">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.025] p-4"><div><p className="text-sm font-medium text-slate-200">Public internet</p><p className="mt-1 text-xs leading-5 text-slate-500">Allow safe page fetching and, with a key, current web search. Local and private network addresses remain blocked.</p></div><Switch checked={internetDraft} onCheckedChange={setInternetDraft} aria-label="Allow public internet tools" /></div>
            <label className="block"><span className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300"><KeyRound className="size-4" />Ollama API key</span><Input type="password" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} placeholder={toolConfig?.apiKeyInMemory ? "Key loaded in memory" : "Paste key to enable web search"} disabled={!internetDraft} className="border-white/10 bg-white/4 text-slate-100" /><span className="mt-2 block text-xs text-slate-500">Optional for page fetching; required for web search. The key stays in server memory and is never saved to disk or task history.</span></label>
            <div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-md border border-white/8 p-3"><p className="text-slate-500">Page fetch</p><p className={internetDraft ? "mt-1 text-[#a7ff4f]" : "mt-1 text-slate-500"}>{internetDraft ? "Available" : "Disabled"}</p></div><div className="rounded-md border border-white/8 p-3"><p className="text-slate-500">Web search</p><p className={toolConfig?.webSearchAvailable || apiKeyDraft ? "mt-1 text-[#a7ff4f]" : "mt-1 text-amber-200/80"}>{toolConfig?.webSearchAvailable || apiKeyDraft ? "Available" : "Needs API key"}</p></div></div> 
            <div className="border-t border-white/8 pt-5">
              <div className="flex items-center justify-between gap-4"><div><p className="text-sm font-medium text-slate-200">Local vision review</p><p className="mt-1 text-xs leading-5 text-slate-500">Review captured browser screenshots locally through Ollama. Screenshot contents are treated as untrusted evidence.</p></div><Switch checked={visionEnabledDraft} onCheckedChange={setVisionEnabledDraft} aria-label="Enable local vision review" /></div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block"><span className="mb-2 block text-xs font-medium text-slate-400">Vision model</span><Input value={visionModelDraft} onChange={(event) => setVisionModelDraft(event.target.value)} disabled={!visionEnabledDraft} placeholder="qwen3-vl:8b" className="border-white/10 bg-white/4 text-slate-100" /></label>
                <label className="block"><span className="mb-2 block text-xs font-medium text-slate-400">Blocking severity</span><Select value={visionBlockingDraft} onValueChange={(value) => setVisionBlockingDraft(value as "medium" | "high" | "critical")} disabled={!visionEnabledDraft}><SelectTrigger className="w-full border-white/10 bg-white/4 text-slate-200"><SelectValue /></SelectTrigger><SelectContent className="border-white/10 bg-[#151a22] text-slate-100"><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem><SelectItem value="critical">Critical</SelectItem></SelectContent></Select></label>
              </div>
              <p className="mt-3 text-xs text-slate-500">Default: qwen3-vl:8b. The model must already be installed in Ollama; unavailable vision never silently passes verification.</p>
            </div>
            {toolsError && <p className="rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{toolsError}</p>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setToolsOpen(false)} className="border-white/10 bg-transparent text-slate-300 hover:bg-white/5 hover:text-white">Cancel</Button><Button onClick={() => void saveTools()} disabled={savingTools} className="bg-[#a7ff4f] text-[#071007] hover:bg-[#b5ff6f]">{savingTools ? "Saving…" : "Save tools"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Sidebar className="border-r border-white/8 bg-[#0a0d12]" collapsible="offcanvas">
        <SidebarHeader className="border-b border-white/8 px-4 py-4">
          <div className="flex items-center gap-3"><div className="grid size-9 place-items-center rounded-lg bg-[#a7ff4f] text-[#071007]"><Bot className="size-5" /></div><div><p className="text-sm font-semibold tracking-wide text-white">BORG CODE</p><p className="text-xs text-slate-500">LOCAL ENGINEERING OS</p></div></div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup><SidebarGroupLabel className="text-slate-500">Repository access</SidebarGroupLabel><SidebarGroupContent><SidebarMenu><SidebarMenuItem><SidebarMenuButton isActive={Boolean(accessConfig?.repositoryPath)} onClick={() => setAccessOpen(true)} className="h-10 bg-white/7 text-slate-100 hover:bg-white/10 hover:text-white"><FolderGit2 /><span>{accessConfig?.repositoryName ?? "Choose repository"}</span></SidebarMenuButton></SidebarMenuItem>{accessConfig?.documentNames.map((name) => <SidebarMenuItem key={name}><SidebarMenuButton onClick={() => setAccessOpen(true)} className="text-slate-400 hover:bg-white/7 hover:text-white"><FileText /><span>{name}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu><Button variant="ghost" size="sm" onClick={() => setAccessOpen(true)} className="mt-2 w-full justify-start gap-2 text-xs text-slate-500 hover:bg-white/7 hover:text-white"><Settings2 className="size-3.5" />Manage access</Button></SidebarGroupContent></SidebarGroup>
          <SidebarGroup><SidebarGroupLabel className="text-slate-500">Tools</SidebarGroupLabel><SidebarGroupContent><SidebarMenu><SidebarMenuItem><SidebarMenuButton onClick={() => setToolsOpen(true)} isActive={Boolean(toolConfig?.internetEnabled)} className="text-slate-300 hover:bg-white/7 hover:text-white"><Globe2 /><span>Internet</span><span className="ml-auto text-xs text-slate-500">{toolConfig?.internetEnabled ? "On" : "Off"}</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu><Button variant="ghost" size="sm" onClick={() => setToolsOpen(true)} className="mt-2 w-full justify-start gap-2 text-xs text-slate-500 hover:bg-white/7 hover:text-white"><Wrench className="size-3.5" />Manage tools</Button></SidebarGroupContent></SidebarGroup>
          <SidebarGroup><SidebarGroupLabel className="text-slate-500">Current task</SidebarGroupLabel><SidebarGroupContent><SidebarMenu><SidebarMenuItem><SidebarMenuButton className="h-auto items-start py-2 text-slate-300 hover:bg-white/7 hover:text-white"><History className="mt-0.5" /><span className="whitespace-normal leading-5">{activeTitle}</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarGroupContent></SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-t border-white/8 p-4"><div className="flex items-center gap-2 text-xs text-slate-400"><span className={`size-2 rounded-full ${serverAvailable ? "bg-[#a7ff4f] shadow-[0_0_10px_#a7ff4f]" : "bg-slate-600"}`} />{serverAvailable ? "BORG server connected" : "BORG server offline"}</div></SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-w-0 bg-[#0d1117] text-slate-100">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/8 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3"><SidebarTrigger className="text-slate-400 hover:bg-white/8 hover:text-white" /><div className="hidden min-w-0 items-center gap-2 text-sm text-slate-500 sm:flex"><span>{accessConfig?.repositoryName ?? "No repository"}</span><ChevronRight className="size-3" /><span className="truncate text-slate-200">{activeTitle}</span></div></div>
          <div className="flex items-center gap-2">{activeRole && <div className="hidden rounded-md border border-sky-300/20 bg-sky-300/8 px-3 py-1.5 text-xs capitalize text-sky-200 md:block">{activeRole.role} · {activeRole.discipline}</div>}<Select value={mode} onValueChange={setMode}><SelectTrigger size="sm" className="border-white/10 bg-white/4 text-slate-200"><ShieldCheck className="size-3.5 text-[#a7ff4f]" /><SelectValue /></SelectTrigger><SelectContent className="border-white/10 bg-[#151a22] text-slate-100"><SelectItem value="ask">Ask</SelectItem><SelectItem value="plan">Plan</SelectItem><SelectItem value="edit">Edit</SelectItem><SelectItem value="agent">Agent</SelectItem></SelectContent></Select><div className={`hidden rounded-md border px-3 py-1.5 text-xs sm:block ${runtimeConnected ? "border-[#a7ff4f]/20 bg-[#a7ff4f]/8 text-[#a7ff4f]" : "border-white/10 bg-white/4 text-slate-400"}`}>{runtimeConnected ? `${modelName} · Ollama` : "Runtime not connected"}</div></div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_310px]">
          <section className="flex min-h-0 flex-col">
            <div ref={transcriptRef} className="flex-1 overflow-y-auto px-5 py-8 sm:px-10 lg:px-14">
              <div className="mx-auto max-w-3xl">
                <div className="mb-7 flex items-start justify-between gap-5"><div><p className="mb-2 font-mono text-xs uppercase tracking-[0.18em] text-[#a7ff4f]">{activeTaskId ? `Task ${activeTaskId.slice(0, 8).toUpperCase()}` : "No active task"}</p><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{activeTitle}</h1></div><span className="rounded-full border border-white/10 bg-white/4 px-3 py-1 text-xs font-medium text-slate-400">{taskState}</span></div>

                <div className="grid grid-cols-6 gap-2 border-y border-white/8 py-5">
                  {stages.map((stage, index) => <div key={stage.name} className="min-w-0"><div className="mb-2 flex items-center"><span className={`grid size-6 place-items-center rounded-full border ${stage.status === "complete" ? "border-[#a7ff4f]/40 bg-[#a7ff4f]/12 text-[#a7ff4f]" : stage.status === "active" ? "border-amber-300/40 bg-amber-300/10 text-amber-200" : stage.status === "failed" ? "border-red-400/40 bg-red-400/10 text-red-300" : "border-white/12 text-slate-600"}`}>{stage.status === "complete" ? <Check className="size-3.5" /> : stage.status === "active" ? <Clock3 className="size-3.5" /> : <Circle className="size-2.5" />}</span>{index < stages.length - 1 && <span className={`h-px flex-1 ${stage.status === "complete" ? "bg-[#a7ff4f]/25" : "bg-white/8"}`} />}</div><p className="truncate text-xs text-slate-400">{stage.name}</p></div>)}
                </div>

                <div className="mt-7 space-y-4" aria-live="polite">
                  {messages.length === 0 ? <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-white/10 bg-white/[0.015] p-8 text-center"><div><Bot className="mx-auto mb-3 size-7 text-slate-600" /><p className="text-sm font-medium text-slate-300">Ready for a request</p><p className="mt-1 text-sm text-slate-500">Stages and tool activity update only when real events arrive.</p></div></div> : messages.map((message) => <article key={message.id} className={`flex gap-3 ${message.role === "system" ? "rounded-lg border border-amber-300/15 bg-amber-300/[0.04] p-4" : message.role === "tool" ? "rounded-lg border border-sky-300/10 bg-sky-300/[0.035] p-4" : "py-2"}`}><div className={`grid size-8 shrink-0 place-items-center rounded-md ${message.role === "user" ? "bg-white/8 text-slate-300" : message.role === "assistant" ? "bg-[#a7ff4f]/12 text-[#a7ff4f]" : message.role === "tool" ? "bg-sky-300/10 text-sky-200" : "bg-amber-300/10 text-amber-200"}`}>{message.role === "user" ? <User className="size-4" /> : message.role === "assistant" ? <Bot className="size-4" /> : message.role === "tool" ? <Globe2 className="size-4" /> : <AlertCircle className="size-4" />}</div><div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{message.role === "user" ? "You" : message.role === "assistant" ? "BORG" : message.role === "tool" ? "Tool" : "Runtime"}</p><p className="whitespace-pre-wrap text-[15px] leading-6 text-slate-300">{message.text}</p></div></article>)}
                  {streaming && <div className="flex items-center gap-2 pl-11 text-sm text-slate-500"><span className="size-1.5 animate-pulse rounded-full bg-[#a7ff4f]" />Listening for live events…</div>}
                </div>
              </div>
            </div>

            <div className="border-t border-white/8 bg-[#0a0d12]/90 p-4 sm:px-8">
              {approval?.status === "REQUESTED" && <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3"><div><p className="text-sm font-medium text-amber-100">Plan approval required</p><p className="mt-1 text-xs text-slate-400">Approval creates an isolated Git worktree, enables bounded mutation tools for this task, and runs deterministic verification.</p></div><div className="flex gap-2"><Button type="button" variant="outline" disabled={approvalBusy} onClick={() => void decideApproval("reject")} className="border-white/10 bg-transparent text-slate-300 hover:bg-white/5 hover:text-white">Reject</Button><Button type="button" disabled={approvalBusy} onClick={() => void decideApproval("approve")} className="bg-[#a7ff4f] text-[#071007] hover:bg-[#b5ff6f]"><Check className="size-4" />{approvalBusy ? "Preparing…" : "Approve plan"}</Button></div></div>}
              {deliveryReady && baselineCandidates.length > 0 && <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-300/20 bg-sky-300/5 p-3"><div><p className="text-sm font-medium text-sky-100">Visual baselines need approval</p><p className="mt-1 text-xs text-slate-400">{baselineCandidates.length} screenshot candidate(s) have no baseline. Acceptance copies their verified bytes into <code>.localcode/visual-baselines</code>; BORG never updates baselines automatically.</p></div><Button type="button" disabled={baselineBusy} onClick={() => void acceptVisualBaselines()} className="bg-sky-200 text-sky-950 hover:bg-sky-100"><Check className="size-4" />{baselineBusy ? "Accepting…" : "Accept baselines"}</Button></div>}
              {deliveryReady && <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-lg border border-[#a7ff4f]/20 bg-[#a7ff4f]/5 p-3"><div><p className="text-sm font-medium text-[#d9ffb5]">Verified changes ready</p><p className="mt-1 text-xs text-slate-400">Export a portable patch or create a commit in the isolated worktree. Neither option changes your main checkout.</p></div><div className="flex gap-2"><Button type="button" variant="outline" disabled={deliveryBusy} onClick={() => void deliverTask("export")} className="border-white/10 bg-transparent text-slate-300 hover:bg-white/5 hover:text-white"><Download className="size-4" />Export patch</Button><Button type="button" disabled={deliveryBusy} onClick={() => void deliverTask("commit")} className="bg-[#a7ff4f] text-[#071007] hover:bg-[#b5ff6f]"><GitCommit className="size-4" />{deliveryBusy ? "Delivering…" : "Commit changes"}</Button></div></div>}
              {approvalError && <p className="mx-auto mb-3 max-w-3xl rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{approvalError}</p>}
              {deliveryError && <p className="mx-auto mb-3 max-w-3xl rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{deliveryError}</p>}
              {baselineError && <p className="mx-auto mb-3 max-w-3xl rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{baselineError}</p>}
              <form className="mx-auto flex max-w-3xl items-center gap-3" onSubmit={(event) => { event.preventDefault(); const value = request; setRequest(""); void runTask(value); }}><Input value={request} onChange={(event) => setRequest(event.target.value)} disabled={streaming} className="h-11 border-white/10 bg-white/4 text-base text-white placeholder:text-slate-600" placeholder="Ask BORG to inspect, plan, or change this repository…" aria-label="Task request" /><Button type={streaming ? "button" : "submit"} onClick={() => { if (streaming) { abortRef.current?.abort(); setStreaming(false); setTaskState("CANCELLED"); } }} className={`h-11 gap-2 px-5 ${streaming ? "bg-white/8 text-slate-200 hover:bg-white/12" : "bg-[#a7ff4f] text-[#071007] hover:bg-[#b5ff6f]"}`}>{streaming ? <CircleStop className="size-4" /> : <Play className="size-4" />}{actionLabel}</Button></form>
            </div>
          </section>

          <aside className="hidden border-l border-white/8 bg-[#0a0d12] xl:block">
            <div className="border-b border-white/8 p-5"><p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">Runtime</p><div className="mt-4 flex items-center gap-3"><div className={`grid size-9 place-items-center rounded-lg border ${runtimeConnected ? "border-[#a7ff4f]/20 bg-[#a7ff4f]/8" : "border-white/8 bg-white/4"}`}><Bot className={`size-4 ${runtimeConnected ? "text-[#a7ff4f]" : "text-slate-500"}`} /></div><div><p className="text-sm font-medium">Ollama direct</p><p className={`text-xs ${runtimeConnected ? "text-[#a7ff4f]/80" : "text-amber-200/80"}`}>{runtimeConnected ? modelName : "Not connected"}</p></div></div></div>
            <div className="space-y-6 p-5">
              <div><div className="mb-3 flex items-center justify-between"><p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">Access scope</p><button onClick={() => setAccessOpen(true)} className="text-xs text-[#a7ff4f] hover:underline">Change</button></div><dl className="space-y-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-slate-500">Repository</dt><dd className="truncate text-right text-slate-300">{accessConfig?.repositoryName ?? "None"}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Documents</dt><dd className="text-slate-300">{accessConfig?.documents.length ?? 0}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Permission</dt><dd className="text-slate-300">Approval gated</dd></div><div className="flex justify-between"><dt className="text-slate-500">Task state</dt><dd className="text-slate-300">{taskState}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Active role</dt><dd className="capitalize text-slate-300">{activeRole?.role ?? "None"}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Discipline</dt><dd className="capitalize text-slate-300">{activeRole?.discipline ?? disciplineRoute?.primary ?? "Unrouted"}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">Packs</dt><dd className="truncate text-right text-slate-300" title={activePacks.map((pack) => `${pack.id}@${pack.version}`).join(", ")}>{activePacks.length ? activePacks.map((pack) => pack.discipline).join(", ") : "None"}</dd></div></dl></div>
              <div><div className="mb-3 flex items-center justify-between"><p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">Tools</p><button onClick={() => setToolsOpen(true)} className="text-xs text-[#a7ff4f] hover:underline">Change</button></div><dl className="space-y-3 text-sm"><div className="flex justify-between"><dt className="text-slate-500">Internet</dt><dd className={toolConfig?.internetEnabled ? "text-[#a7ff4f]" : "text-slate-500"}>{toolConfig?.internetEnabled ? "Allowed" : "Disabled"}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Page fetch</dt><dd className="text-slate-300">{toolConfig?.webFetchAvailable ? "Available" : "Off"}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Web search</dt><dd className="text-slate-300">{toolConfig?.webSearchAvailable ? "Available" : "Needs key"}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">Vision review</dt><dd className={visionConfig?.enabled ? "truncate text-[#a7ff4f]" : "text-slate-500"}>{visionConfig?.enabled ? visionConfig.model : "Disabled"}</dd></div></dl></div>
              <div><p className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-slate-500">Protection</p><div className="rounded-lg border border-white/8 bg-white/[0.025] p-3 text-sm leading-5 text-slate-400">Only the approved repository map, key project files, and listed documents are sent to Ollama. Secret-like files are excluded.</div></div>
            </div>
          </aside>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
