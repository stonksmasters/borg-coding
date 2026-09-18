"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookmarkPlus, Bot, CircleStop, ExternalLink, FolderGit2, Globe2, History, KeyRound, MessageSquare, Monitor, Pencil, Play, Plus, RotateCcw, ShieldAlert, ShieldCheck, Smartphone, Sparkles, Tablet, Trash2, X } from "lucide-react";
import { AssistantMessage, type RenderableMessage } from "@/components/chat/assistant-message";
import { ActivityFeed, type AgentActivity } from "@/components/agent/activity-feed";
import { ChangesPanel, type ChangeSet } from "@/components/changes/changes-panel";
import { PlanPanel } from "@/components/workspace/plan-panel";
import { DocsPanel, type BuildDoc } from "@/components/workspace/docs-panel";
import { TerminalPanel, type TaskProcess, type TaskProcessEvent } from "@/components/workspace/terminal-panel";
import { DesignPanel, type DesignBriefView, type DesignReviewView } from "@/components/workspace/design-panel";
import { isUnsupportedLanguageTool, stageProgress, toolProgress } from "./agent-progress";
import { executionIsRunning, taskIsRunning, taskNeedsAttention, taskProgress } from "./task-activity";
import { previewChangeFingerprint, shouldRefreshPreview } from "./preview-refresh";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";

const API = (process.env.NEXT_PUBLIC_BORG_API_URL ?? "http://127.0.0.1:4312").replace(/\/$/, "");
const WEBSITE_TEMPLATES = [
  { id: "saas-landing", label: "SaaS landing", detail: "Product story, proof, pricing, and conversion." },
  { id: "portfolio", label: "Portfolio", detail: "Personal brand, selected work, and contact." },
  { id: "ecommerce", label: "Ecommerce", detail: "Products, collections, merchandising, and purchase paths." },
  { id: "dashboard", label: "Dashboard", detail: "Application navigation, data, and useful workflows." },
  { id: "waitlist", label: "Waitlist", detail: "Focused launch page with one excellent signup journey." },
] as const;
type WebsiteTemplate = typeof WEBSITE_TEMPLATES[number]["id"];
const WEBSITE_EXAMPLES = [
  "Build a dark SaaS landing page for an AI note-taking app with a premium hero, pricing, testimonials, and a waitlist form.",
  "Build a bold ecommerce homepage for a modern outdoor brand with featured products, collections, social proof, and a newsletter.",
  "Build a polished personal portfolio for a senior software engineer with selected projects, experience, an about section, and contact CTA.",
  "Build an internal operations dashboard with a sidebar, KPI cards, activity table, useful empty states, and responsive navigation.",
  "Build a booking website for a premium local service business with services, trust signals, availability CTA, FAQ, and lead form.",
] as const;
const BUILDER_STEPS = ["Understand", "Design", "Build", "Test", "Ready"] as const;
type PermissionMode = "ask" | "plan" | "edit" | "agent";
type ChatSession = { id: string; title: string; createdAt: string; updatedAt: string; activeMode: PermissionMode; repositoryPath: string | null; workspaceId: string; provider: string; model: string };
type ChatMessage = RenderableMessage & { sessionId: string; taskId: string | null; createdAt: string; metadata?: Record<string, unknown> };
type AccessConfig = { repositoryPath: string | null; documents: string[]; repositoryName: string | null; documentNames: string[]; updatedAt: string };
type ToolConfig = {
  provider: string;
  internetEnabled: boolean;
  configurationState: "not_configured" | "configured" | "available" | "connection_failed";
  credentialConfigured: boolean;
  webFetchAvailable: boolean;
  webSearchAvailable: boolean;
  lastConnectionError: string | null;
  updatedAt: string;
};
type Approval = { id: string; taskId: string; status: "REQUESTED" | "APPROVED" | "REJECTED"; worktreePath: string | null; baseCommit: string | null };
type Escalation = { id: string; sessionId: string; taskId: string; fromMode: "plan"; requestedMode: "edit"; reason: string; planText: string; createdAt: string };
type TaskCheckpoint = { id: string; taskId: string; sessionId: string | null; name: string; kind: string; taskState: string; mode: PermissionMode; repositoryPath: string | null; worktreePath: string | null; baseCommit: string | null; contextSummary: string; completedSteps: string[]; remainingSteps: string[]; createdAt: string };
type TaskContinuation = { id: string; checkpointId: string; status: "ready" | "recovery_required" | "completed" | "failed"; restoredMode: PermissionMode; previousState: string; resultingState: string; repositoryState: string; resumeAction: string; detail: string; startedAt: string };
type SliceState = { current: number; total: number; currentTitle: string; status: "plan_pending" | "ready" | "working" | "awaiting_feedback" | "frontend_complete"; backendRequired: boolean };
type ReviewFinding = { id: string; fingerprint: string; state: "open" | "accepted" | "fixed" | "waived" | "false_positive" | "reopened" | "superseded"; firstSeenRunId: string; lastSeenRunId: string; firstSeenAt: string; lastSeenAt: string; finding: { severity: "info" | "low" | "medium" | "high" | "critical"; discipline: string; category: string; title: string; description: string; file?: string; line?: number; evidence?: string; remediation?: string } };
type ReviewDecision = { id: string; findingId: string; action: string; resultingState: ReviewFinding["state"]; reason: string; evidence: string[]; actorType: string; actorId: string; createdAt: string };
type StreamEvent = {
  type: string;
  task?: { id: string; request: string; state: string };
  taskId?: string;
  text?: string;
  message?: string;
  state?: string;
  mode?: PermissionMode;
  tool?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  approval?: Approval;
  escalation?: Escalation;
  diff?: { stdout?: string };
  review?: { summary?: string };
  stage?: string;
  status?: string | { stdout?: string };
  activity?: AgentActivity;
  brief?: DesignBriefView;
  designReview?: DesignReviewView;
  refinement?: number;
  maximum?: number;
};

function statusLabel(config: ToolConfig | null) {
  if (!config) return "Loading";
  if (config.configurationState === "not_configured") return "Not configured";
  if (config.configurationState === "configured") return "Configured";
  if (config.configurationState === "available") return "Available";
  return "Connection failed";
}

function transientMessage(role: RenderableMessage["role"], text: string, kind?: string): ChatMessage {
  return { id: crypto.randomUUID(), sessionId: "transient", taskId: null, role, kind, text, createdAt: new Date().toISOString() };
}

const EMPTY_CHANGE_SET: ChangeSet = { files: [], additions: 0, deletions: 0, diff: "", clean: true };

export function BorgWorkspaceV2() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [request, setRequest] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(false);
  const [, setRuntimeConnected] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskState, setTaskState] = useState("READY");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [escalation, setEscalation] = useState<Escalation | null>(null);
  const [planApproval, setPlanApproval] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [deliveryReady, setDeliveryReady] = useState(false);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [, setAccessConfig] = useState<AccessConfig | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [repositoryDraft, setRepositoryDraft] = useState("");
  const [documentsDraft, setDocumentsDraft] = useState("");
  const [accessError, setAccessError] = useState("");
  const [savingAccess, setSavingAccess] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolConfig, setToolConfig] = useState<ToolConfig | null>(null);
  const [internetDraft, setInternetDraft] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [clearApiKeyDraft, setClearApiKeyDraft] = useState(false);
  const [toolsError, setToolsError] = useState("");
  const [savingTools, setSavingTools] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [progress, setProgress] = useState<{ title: string; detail: string } | null>(null);
  const [liveActivity, setLiveActivity] = useState<string[]>([]);
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [changes, setChanges] = useState<ChangeSet>(EMPTY_CHANGE_SET);
  const [rightPanel, setRightPanel] = useState<"preview" | "plan" | "changes" | "docs" | "terminal" | "design">("preview");
  const [buildDocs, setBuildDocs] = useState<BuildDoc[]>([]);
  const [sliceState, setSliceState] = useState<SliceState | null>(null);
  const [sliceFeedback, setSliceFeedback] = useState("");
  const [sliceBusy, setSliceBusy] = useState(false);
  const [designBrief, setDesignBrief] = useState<DesignBriefView | null>(null);
  const [designReview, setDesignReview] = useState<DesignReviewView | null>(null);
  const [designRefinementCount, setDesignRefinementCount] = useState(0);
  const [maxDesignRefinements, setMaxDesignRefinements] = useState(3);
  const [processes, setProcesses] = useState<TaskProcess[]>([]);
  const [processEvents, setProcessEvents] = useState<TaskProcessEvent[]>([]);
  const [websiteOpen, setWebsiteOpen] = useState(false);
  const [websiteName, setWebsiteName] = useState("");
  const [websiteBrief, setWebsiteBrief] = useState("");
  const [websiteTemplate, setWebsiteTemplate] = useState<WebsiteTemplate>("saas-landing");
  const [websiteBusy, setWebsiteBusy] = useState(false);
  const [websiteError, setWebsiteError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [previewViewport, setPreviewViewport] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [checkpointName, setCheckpointName] = useState("");
  const [checkpoints, setCheckpoints] = useState<TaskCheckpoint[]>([]);
  const [continuations, setContinuations] = useState<TaskContinuation[]>([]);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [checkpointError, setCheckpointError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewFindings, setReviewFindings] = useState<ReviewFinding[]>([]);
  const [reviewDecisions, setReviewDecisions] = useState<ReviewDecision[]>([]);
  const [blockingFindingIds, setBlockingFindingIds] = useState<string[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const liveAssistantId = useRef<string | null>(null);
  const changeFingerprintRef = useRef<string | null>(null);
  const activeMode = activeSession?.activeMode ?? "plan";
  const isWebsite = Boolean(activeSession?.repositoryPath);
  const websiteSessions = useMemo(() => sessions.filter((session) => Boolean(session.repositoryPath)), [sessions]);
  const legacySessions = useMemo(() => sessions.filter((session) => !session.repositoryPath), [sessions]);
  const taskBusy = streaming || taskIsRunning(taskState) || taskNeedsAttention(taskState);
  const canStop = streaming && !executionIsRunning(taskState);
  const actionLabel = executionIsRunning(taskState) || (taskBusy && !canStop) ? "Working" : canStop ? "Stop" : "Send";
  const currentProgress = progress ?? taskProgress(taskState);
  const activityMessages = useMemo(() => messages.filter((message) => message.role === "tool" || (message.kind === "warning" && isUnsupportedLanguageTool(message.text))), [messages]);
  const visibleMessages = useMemo(() => messages.filter((message) => message.role !== "tool" && !(message.kind === "warning" && isUnsupportedLanguageTool(message.text))), [messages]);
  const activityItems = useMemo(() => [...activityMessages.map((message) => message.text), ...liveActivity].slice(-60), [activityMessages, liveActivity]);
  const latestPlan = useMemo(() => {
    const message = [...messages].reverse().find((item) => item.role === "assistant" && item.kind === "plan");
    return message?.text?.trim() || escalation?.planText?.trim() || null;
  }, [escalation, messages]);
  const runningProcesses = useMemo(() => processes.filter((process) => process.status === "starting" || process.status === "running"), [processes]);
  const previewProcess = useMemo(() => processes.find((process) => process.kind === "dev_server" && (process.status === "starting" || process.status === "running")) ?? processes.findLast((process) => process.kind === "dev_server") ?? null, [processes]);
  const builderStep = useMemo(() => {
    if (["DELIVERY_READY", "COMPLETE"].includes(taskState)) return 4;
    if (["VERIFYING", "REVIEWING", "REPAIRING"].includes(taskState)) return 3;
    if (["IMPLEMENTING"].includes(taskState)) return 2;
    if (designBrief || ["AWAITING_APPROVAL"].includes(taskState)) return 1;
    return 0;
  }, [designBrief, taskState]);

  const activatePreview = useCallback(async (sessionId: string) => {
    const response = await fetch(`${API}/api/sessions/${encodeURIComponent(sessionId)}/preview`, { method: "POST" });
    if (response.ok) {
      const result = await response.json() as { preview: { url: string }; access: AccessConfig };
      setPreviewUrl(result.preview.url);
      setAccessConfig(result.access);
      setPreviewError("");
    } else if (response.status === 404) {
      setPreviewUrl(null);
      setPreviewError("");
    } else {
      const result = await response.json().catch(() => ({})) as { error?: string };
      setPreviewUrl(null);
      setPreviewError(result.error ?? "Unable to restore website preview.");
    }
  }, []);

  const refreshTaskActivity = useCallback(async (taskId: string) => {
    const response = await fetch(`${API}/api/tasks/${encodeURIComponent(taskId)}/activity`);
    if (!response.ok) return;
    const result = await response.json() as { activities?: AgentActivity[] };
    setActivities(result.activities ?? []);
  }, []);

  const refreshChanges = useCallback(async (taskId: string, options?: { refreshPreviewOnChange?: boolean }) => {
    const response = await fetch(`${API}/api/tasks/${encodeURIComponent(taskId)}/changes`);
    if (!response.ok) return false;
    const result = await response.json() as ChangeSet & { taskId?: string };
    const next: ChangeSet = {
      files: result.files ?? [],
      additions: result.additions ?? 0,
      deletions: result.deletions ?? 0,
      diff: result.diff ?? "",
      clean: result.clean ?? !(result.files?.length),
    };
    const nextFingerprint = previewChangeFingerprint(next);
    const refreshPreview = options?.refreshPreviewOnChange === true
      && shouldRefreshPreview(changeFingerprintRef.current, nextFingerprint);
    changeFingerprintRef.current = nextFingerprint;
    setChanges(next);
    if (refreshPreview) setPreviewVersion((value) => value + 1);
    return refreshPreview;
  }, []);

  const refreshDocs = useCallback(async (taskId: string) => {
    const response = await fetch(`${API}/api/tasks/${encodeURIComponent(taskId)}/docs`);
    if (!response.ok) return;
    const result = await response.json() as { docs?: BuildDoc[]; slice?: SliceState | null };
    setBuildDocs(result.docs ?? []);
    setSliceState(result.slice ?? null);
  }, []);

  const refreshDesign = useCallback(async (taskId: string) => {
    const response = await fetch(`${API}/api/tasks/${encodeURIComponent(taskId)}/design`);
    if (!response.ok) return;
    const result = await response.json() as {
      brief?: DesignBriefView | null;
      review?: DesignReviewView | null;
      refinementCount?: number;
      maxRefinements?: number;
    };
    setDesignBrief(result.brief ?? null);
    setDesignReview(result.review ?? null);
    setDesignRefinementCount(result.refinementCount ?? 0);
    setMaxDesignRefinements(result.maxRefinements ?? 3);
  }, []);

  const refreshProcesses = useCallback(async (taskId: string) => {
    const response = await fetch(`${API}/api/tasks/${encodeURIComponent(taskId)}/processes`);
    if (!response.ok) return;
    const result = await response.json() as { processes?: TaskProcess[]; events?: TaskProcessEvent[] };
    setProcesses(result.processes ?? []);
    setProcessEvents(result.events ?? []);
  }, []);

  const loadSession = useCallback(async (sessionId: string, options?: { restorePreview?: boolean; resetWorkspace?: boolean }) => {
    const restorePreview = options?.restorePreview ?? true;
    const resetWorkspace = options?.resetWorkspace ?? true;
    const response = await fetch(`${API}/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) throw new Error("Unable to load chat session.");
    const result = await response.json() as {
      session: ChatSession;
      messages: ChatMessage[];
      latestTaskId: string | null;
      task: { id: string; state: string } | null;
      approval: Approval | null;
      escalation: Escalation | null;
      projectPlanApproval?: boolean;
      runtimeAvailable: boolean;
    };
    const pendingApproval = result.approval?.status === "REQUESTED" ? result.approval : null;
    const pendingEscalation = result.task?.state === "AWAITING_APPROVAL" ? result.escalation : null;
    setActiveSession(result.session);
    setSessions((current) => current.map((session) => session.id === result.session.id ? result.session : session));
    setMessages(result.messages);
    if (resetWorkspace) {
      const restoredPlan = [...result.messages].reverse().find((message) => message.role === "assistant" && message.kind === "plan")?.text?.trim();
      if (restoredPlan && ["PLANNING", "AWAITING_APPROVAL", "CANCELLED"].includes(result.task?.state ?? "")) setRightPanel("plan");
      else if (result.session.repositoryPath) setRightPanel("preview");
    }
    setProgress(null);
    setLiveActivity([]);
    if (resetWorkspace) {
      setActivities([]);
      setChanges(EMPTY_CHANGE_SET);
      setProcesses([]);
      setProcessEvents([]);
      setDesignBrief(null);
      setDesignReview(null);
      setDesignRefinementCount(0);
      setBuildDocs([]);
      setSliceState(null);
      changeFingerprintRef.current = null;
    }
    setActiveTaskId(result.latestTaskId);
    setApproval(pendingApproval);
    setEscalation(pendingEscalation);
    setPlanApproval(Boolean(pendingApproval && result.projectPlanApproval));
    setDeliveryReady(result.task?.state === "DELIVERY_READY");
    setTaskState(result.task?.state ?? (result.latestTaskId && !result.runtimeAvailable ? "RUNTIME UNAVAILABLE" : "READY"));
    if (restorePreview) {
      setPreviewUrl(null);
      setPreviewError("");
    }
    if (result.latestTaskId) await Promise.allSettled([
      refreshTaskActivity(result.latestTaskId),
      refreshChanges(result.latestTaskId),
      refreshProcesses(result.latestTaskId),
      refreshDesign(result.latestTaskId),
      refreshDocs(result.latestTaskId),
    ]);
    if (restorePreview) await activatePreview(sessionId);
    return result;
  }, [activatePreview, refreshChanges, refreshDesign, refreshDocs, refreshProcesses, refreshTaskActivity]);

  const refreshSessions = useCallback(async (preferredId?: string) => {
    const response = await fetch(`${API}/api/sessions`);
    if (!response.ok) throw new Error("Unable to load chat history.");
    let result = await response.json() as { sessions: ChatSession[] };
    if (!result.sessions.length) {
      const createdResponse = await fetch(`${API}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ activeMode: "plan" }) });
      const created = await createdResponse.json() as { session: ChatSession };
      result = { sessions: [created.session] };
    }
    setSessions(result.sessions);
    const selected = preferredId && result.sessions.some((session) => session.id === preferredId) ? preferredId : result.sessions[0].id;
    await loadSession(selected);
  }, [loadSession]);

  useEffect(() => {
    void Promise.all([
      fetch(`${API}/health`).then(async (response) => {
        const health = await response.json() as { core?: { runtimeConnected?: boolean; modelAvailable?: boolean } };
        setServerAvailable(response.ok);
        setRuntimeConnected(Boolean(health.core?.runtimeConnected && health.core?.modelAvailable));
      }).catch(() => { setServerAvailable(false); setRuntimeConnected(false); }),
      fetch(`${API}/api/access`).then(async (response) => {
        if (!response.ok) return;
        const result = await response.json() as { access: AccessConfig };
        setAccessConfig(result.access);
        setRepositoryDraft(result.access.repositoryPath ?? "");
        setDocumentsDraft(result.access.documents.join("\n"));
      }),
      fetch(`${API}/api/tools`).then(async (response) => {
        if (!response.ok) return;
        const result = await response.json() as { tools: ToolConfig };
        setToolConfig(result.tools);
        setInternetDraft(result.tools.internetEnabled);
      }),
      refreshSessions(),
    ]).catch((error) => setSessionError(error instanceof Error ? error.message : "Unable to initialize workspace."));
  }, [refreshSessions]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    if (!previewProcess?.url || previewProcess.status !== "running") return;
    if (previewUrl === previewProcess.url) return;
    setPreviewUrl(previewProcess.url);
    setPreviewError("");
    setPreviewVersion((value) => value + 1);
  }, [previewProcess?.url, previewProcess?.status, previewUrl]);

  useEffect(() => {
    if (!activeTaskId) {
      setProcesses([]);
      setProcessEvents([]);
      return;
    }
    let cancelled = false;
    let polling = false;
    const poll = () => {
      if (polling || cancelled) return;
      polling = true;
      void refreshProcesses(activeTaskId)
        .catch(() => undefined)
        .finally(() => { polling = false; });
    };
    poll();
    const interval = taskIsRunning(taskState) || rightPanel === "terminal" ? 750 : 2500;
    const timer = window.setInterval(poll, interval);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeTaskId, refreshProcesses, rightPanel, taskState]);

  useEffect(() => {
    if (!activeSession || streaming || !taskIsRunning(taskState)) return;
    const sessionId = activeSession.id;
    let polling = false;
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void loadSession(sessionId, { restorePreview: false, resetWorkspace: false }).catch((error) => setSessionError(error instanceof Error ? error.message : "Unable to refresh task status."))
        .finally(() => { polling = false; });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeSession, streaming, taskState, loadSession]);

  const refreshCheckpoints = useCallback(async (taskId: string) => {
    const response = await fetch(`${API}/api/tasks/${encodeURIComponent(taskId)}/checkpoints`);
    const result = await response.json() as { checkpoints?: TaskCheckpoint[]; continuations?: TaskContinuation[]; error?: string };
    if (!response.ok) throw new Error(result.error ?? "Unable to load checkpoints.");
    setCheckpoints(result.checkpoints ?? []);
    setContinuations(result.continuations ?? []);
  }, []);

  const refreshReviewHistory = useCallback(async (taskId: string) => {
    const response = await fetch(`${API}/api/tasks/${encodeURIComponent(taskId)}/review-history`);
    const result = await response.json() as { findings?: ReviewFinding[]; decisions?: ReviewDecision[]; blockingFindingIds?: string[]; error?: string };
    if (!response.ok) throw new Error(result.error ?? "Unable to load review history.");
    setReviewFindings(result.findings ?? []);
    setReviewDecisions(result.decisions ?? []);
    setBlockingFindingIds(result.blockingFindingIds ?? []);
  }, []);

  useEffect(() => {
    if (!activeTaskId) {
      setCheckpoints([]);
      setContinuations([]);
      setReviewFindings([]);
      setReviewDecisions([]);
      setBlockingFindingIds([]);
      return;
    }
    void refreshCheckpoints(activeTaskId).catch((error) => setCheckpointError(error instanceof Error ? error.message : "Unable to load checkpoints."));
    void refreshReviewHistory(activeTaskId).catch((error) => setReviewError(error instanceof Error ? error.message : "Unable to load review history."));
  }, [activeTaskId, refreshCheckpoints, refreshReviewHistory]);

  async function createSession() {
    setSessionError("");
    try {
      const response = await fetch(`${API}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ activeMode: "plan" }) });
      if (!response.ok) throw new Error("Unable to create chat.");
      const result = await response.json() as { session: ChatSession };
      await refreshSessions(result.session.id);
    } catch (error) { setSessionError(error instanceof Error ? error.message : "Unable to create chat."); }
  }

  async function createWebsite() {
    const name = websiteName.trim();
    const brief = websiteBrief.trim();
    if (!name || !brief) return;
    setWebsiteBusy(true);
    setWebsiteError("");
    try {
      const response = await fetch(`${API}/api/websites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, brief, template: websiteTemplate }),
      });
      const result = await response.json() as { session?: ChatSession; error?: string };
      if (!response.ok || !result.session) throw new Error(result.error ?? "Unable to create website.");
      setWebsiteOpen(false);
      setWebsiteName("");
      setWebsiteBrief("");
      setWebsiteTemplate("saas-landing");
      setRequest(brief);
      setRightPanel("preview");
      await refreshSessions(result.session.id);
    } catch (error) { setWebsiteError(error instanceof Error ? error.message : "Unable to create website."); }
    finally { setWebsiteBusy(false); }
  }

  async function renameSession(session: ChatSession) {
    const title = window.prompt("Rename chat", session.title)?.trim();
    if (!title || title === session.title) return;
    const response = await fetch(`${API}/api/sessions/${encodeURIComponent(session.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    if (!response.ok) return;
    await refreshSessions(activeSession?.id ?? session.id);
  }

  async function deleteSession(session: ChatSession) {
    if (!window.confirm(`Delete “${session.title}”? This removes its saved chat history.`)) return;
    await fetch(`${API}/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    await refreshSessions(activeSession?.id === session.id ? undefined : activeSession?.id);
  }

  async function changeMode(mode: PermissionMode) {
    if (!activeSession || streaming) return;
    const response = await fetch(`${API}/api/sessions/${encodeURIComponent(activeSession.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ activeMode: mode }) });
    if (!response.ok) return;
    const result = await response.json() as { session: ChatSession };
    setActiveSession(result.session);
    setSessions((current) => current.map((session) => session.id === result.session.id ? result.session : session));
  }

  function applyEvent(event: StreamEvent) {
    if (event.type === "task.created" && event.task) {
      setActiveTaskId(event.task.id);
      setTaskState(event.task.state);
      setActivities([]);
      setChanges(EMPTY_CHANGE_SET);
      setProcesses([]);
      setProcessEvents([]);
      setDesignBrief(null);
      setDesignReview(null);
      setDesignRefinementCount(0);
      changeFingerprintRef.current = null;
    } else if (event.type === "task.state" && event.state) {
      setTaskState(event.state);
      setDeliveryReady(event.state === "DELIVERY_READY");
    } else if (event.type === "message.delta") {
      const text = String(event.text ?? "");
      if (!text) return;
      if (!liveAssistantId.current) {
        liveAssistantId.current = crypto.randomUUID();
        setMessages((current) => [...current, { ...transientMessage("assistant", text, activeMode === "ask" ? "prose" : "plan"), id: liveAssistantId.current! }]);
      } else {
        const id = liveAssistantId.current;
        setMessages((current) => current.map((message) => message.id === id ? { ...message, text: `${message.text}${text}` } : message));
      }
    } else if (event.type === "design.brief.created" && event.brief) {
      setDesignBrief(event.brief);
      setDesignReview(null);
      setDesignRefinementCount(0);
      setRightPanel("design");
    } else if (event.type === "design.review.completed" && event.designReview) {
      setDesignReview(event.designReview);
      setRightPanel("design");
    } else if (event.type === "design.refinement.scheduled") {
      setDesignRefinementCount(event.refinement ?? 0);
      if (event.maximum) setMaxDesignRefinements(event.maximum);
      setRightPanel("design");
    } else if (event.type === "design.review.blocked") {
      if (event.designReview) setDesignReview(event.designReview);
      setRightPanel("design");
    } else if (event.type === "activity.updated" && event.activity) {
      const activity = { ...event.activity, taskId: event.taskId ?? event.activity.taskId };
      setActivities((current) => [...current.filter((item) => item.id !== activity.id), activity].slice(-100));
      setProgress({ title: activity.title, detail: activity.detail ?? `BORG is ${activity.phase} the current task.` });
    } else if (event.type === "stage.updated" && event.status === "active" && event.stage) {
      const next = stageProgress(event.stage);
      if (next) setProgress(next);
    } else if (event.type === "tool.started") {
      const tool = event.tool ?? "tool";
      if (event.taskId && ["worktree_command", "verification_run", "browser_server_start", "browser_server_stop"].includes(tool)) void refreshProcesses(event.taskId);
      const title = toolProgress(tool, event.input);
      const path = typeof event.input?.path === "string" ? event.input.path : "";
      setProgress({ title, detail: path ? `Working in ${path}.` : "BORG is continuing this part of the task." });
      setLiveActivity((current) => [...current.slice(-39), `${title} · ${tool}`]);
    } else if (event.type === "tool.completed") {
      if (event.taskId && ["worktree_patch", "worktree_command", "git_diff", "git_status"].includes(event.tool ?? "")) {
        void refreshChanges(event.taskId, { refreshPreviewOnChange: true });
        void refreshDocs(event.taskId);
      }
      if (event.taskId && ["worktree_command", "verification_run", "browser_server_start", "browser_server_stop"].includes(event.tool ?? "")) {
        void refreshProcesses(event.taskId);
      }
    } else if (event.type === "tool.failed") {
      const detail = `${event.tool ?? "Tool"} failed: ${event.message ?? "Unknown error"}`;
      setLiveActivity((current) => [...current.slice(-39), detail]);
      if (!isUnsupportedLanguageTool(detail)) setMessages((current) => [...current, transientMessage("system", detail, "warning")]);
    } else if (event.type === "project.plan.approval.requested" && event.approval) {
      setApproval(event.approval);
      setEscalation(null);
      setPlanApproval(true);
      setTaskState("AWAITING_APPROVAL");
      setRightPanel("plan");
      if (event.taskId) void refreshDocs(event.taskId);
    } else if (event.type === "mode.escalation.requested" && event.approval && event.escalation) {
      setApproval(event.approval);
      setEscalation(event.escalation);
      setPlanApproval(false);
      setTaskState("AWAITING_APPROVAL");
      setRightPanel("plan");
    } else if (event.type === "mode.authorized") {
      setTaskState("IMPLEMENTING");
      changeFingerprintRef.current = "clean";
      setRightPanel("preview");
      if (event.taskId) { void refreshChanges(event.taskId); void refreshDocs(event.taskId); }
      if (activeSession) void activatePreview(activeSession.id);
    } else if (event.type === "implementation.summary") {
      if (event.taskId) void refreshChanges(event.taskId);
    } else if (event.type === "review.completed" && event.review?.summary) {
      const summary = event.review.summary;
      setMessages((current) => [...current, transientMessage("system", summary, "evidence")]);
    } else if (event.type === "review.history.updated" && event.taskId) {
      void refreshReviewHistory(event.taskId).catch((error) => setReviewError(error instanceof Error ? error.message : "Unable to load review history."));
    } else if (event.type === "delivery.ready") {
      setDeliveryReady(true);
      setTaskState("DELIVERY_READY");
    } else if (event.type === "runtime.failed" || event.type === "stream.failed") {
      setMessages((current) => [...current, transientMessage("system", event.message ?? "Runtime failed.", "warning")]);
      setTaskState("FAILED");
    }
  }

  async function consumeStream(response: Response) {
    if (!response.body) throw new Error("The BORG stream did not start.");
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
  }

  async function runTask(prompt: string, sliceAction?: "initial" | "advance" | "revise" | "backend", targetSession = activeSession, force = false) {
    const clean = prompt.trim();
    if (!targetSession || !clean || (taskBusy && !force)) return;
    const controller = new AbortController();
    abortRef.current = controller;
    liveAssistantId.current = null;
    setStreaming(true);
    setProgress({ title: "Reading your request", detail: "BORG will review the project, then show its proposed design choices in the plan." });
    setLiveActivity([]);
    setActivities([]);
    setChanges(EMPTY_CHANGE_SET);
    setApproval(null);
    setEscalation(null);
    setPlanApproval(false);
    setDeliveryReady(false);
    setTaskState("STARTING");
    setMessages((current) => [...current, transientMessage("user", clean)]);
    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: targetSession.id, request: clean, sliceAction }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Unable to start BORG task.");
      await consumeStream(response);
      let loaded = await loadSession(targetSession.id, { restorePreview: false, resetWorkspace: false });
      if (sliceAction && sliceAction !== "backend" && loaded.latestTaskId && loaded.task?.state === "DELIVERY_READY") {
        setProgress({ title: "Saving verified slice", detail: "This slice passed verification and review. BORG is checkpointing it before the next slice." });
        const deliveryResponse = await fetch(`${API}/api/tasks/${encodeURIComponent(loaded.latestTaskId)}/delivery`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: "commit", message: "BORG verified frontend slice checkpoint" }),
        });
        const deliveryResult = await deliveryResponse.json().catch(() => ({})) as { error?: string };
        if (!deliveryResponse.ok) throw new Error(deliveryResult.error ?? "Unable to save the verified frontend slice.");
        loaded = await loadSession(targetSession.id, { restorePreview: false, resetWorkspace: false });
      }
      const sessionResponse = await fetch(`${API}/api/sessions`);
      if (sessionResponse.ok) setSessions((await sessionResponse.json() as { sessions: ChatSession[] }).sessions);
    } catch (error) {
      if (!controller.signal.aborted) setMessages((current) => [...current, transientMessage("system", error instanceof Error ? error.message : "Task failed.", "warning")]);
    } finally {
      liveAssistantId.current = null;
      setStreaming(false);
      abortRef.current = null;
    }
  }

  async function startSliceSession(action: "initial" | "advance" | "revise" | "backend", forceRun = false) {
    const feedback = sliceFeedback.trim();
    if (!activeSession || sliceBusy || ((action === "revise" || action === "backend") && !feedback)) return;
    setSliceBusy(true);
    try {
      const label = action === "initial" ? "Slice 1" : action === "advance" ? "Next slice" : action === "backend" ? "Backend planning" : "Revision";
      const sliceMode: PermissionMode = action === "backend" ? "plan" : "edit";
      const response = await fetch(`${API}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ activeMode: sliceMode, workspaceId: activeSession.workspaceId, title: `${activeSession.title} · ${label}` }) });
      if (!response.ok) throw new Error("Unable to create the next build session.");
      const result = await response.json() as { session: ChatSession };
      await refreshSessions(result.session.id);
      setSliceFeedback("");
      const prompt = action === "initial"
        ? "Start the first approved frontend slice. Use the approved phase plan and current-slice docs as scope authority; do not re-plan the whole website."
        : action === "advance" && !feedback
          ? "Approved. Continue directly to the next frontend slice in the frozen phase plan."
          : feedback;
      await runTask(prompt, action, result.session, forceRun);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to start the next slice.");
    } finally { setSliceBusy(false); }
  }

  async function decideEscalation(decision: "approve" | "reject") {
    if (!activeSession || !activeTaskId || !approval || approvalBusy) return;
    setApprovalBusy(true);
    try {
      const response = await fetch(`${API}/api/tasks/${encodeURIComponent(activeTaskId)}/approval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      const result = await response.json() as { session?: ChatSession; task?: { state: string }; projectPlanApproved?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to record mode decision.");
      if (result.session) {
        setActiveSession(result.session);
        setSessions((current) => current.map((session) => session.id === result.session!.id ? result.session! : session));
      }
      if (decision === "approve" && result.projectPlanApproved) {
        setApproval(null);
        setEscalation(null);
        setPlanApproval(false);
        setTaskState("COMPLETE");
        setProgress({ title: "Frontend plan approved", detail: "The roadmap is frozen. Starting slice 1 now." });
        setRightPanel("preview");
        await refreshDocs(activeTaskId);
        await loadSession(activeSession.id, { restorePreview: false, resetWorkspace: false });
        await startSliceSession("initial", true);
      } else if (decision === "approve") {
        setApproval(null);
        setEscalation(null);
        setPlanApproval(false);
        setTaskState(result.task?.state ?? "IMPLEMENTING");
        setStreaming(true);
        setProgress(stageProgress("Implementation"));
        changeFingerprintRef.current = "clean";
        setRightPanel("preview");
        await activatePreview(activeSession.id);
        await refreshChanges(activeTaskId);
        const executeResponse = await fetch(`${API}/api/tasks/${encodeURIComponent(activeTaskId)}/execute`, { method: "POST" });
        await consumeStream(executeResponse);
        await loadSession(activeSession.id, { restorePreview: false, resetWorkspace: false });
      } else {
        setApproval(null);
        setEscalation(null);
        setPlanApproval(false);
        setTaskState("PLAN COMPLETE");
        setRightPanel("plan");
        await loadSession(activeSession.id, { restorePreview: false, resetWorkspace: false });
      }
    } catch (error) {
      setMessages((current) => [...current, transientMessage("system", error instanceof Error ? error.message : "Mode transition failed.", "warning")]);
    } finally {
      setStreaming(false);
      setApprovalBusy(false);
    }
  }

  async function stopTaskProcess(processId: string) {
    if (!activeTaskId) return;
    const response = await fetch(`${API}/api/tasks/${encodeURIComponent(activeTaskId)}/processes/${encodeURIComponent(processId)}/stop`, { method: "POST" });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      setMessages((current) => [...current, transientMessage("system", result.error ?? "Unable to stop process.", "warning")]);
      return;
    }
    await refreshProcesses(activeTaskId);
  }

  async function deliver(method: "export" | "commit") {
    if (!activeTaskId || !deliveryReady || deliveryBusy) return;
    setDeliveryBusy(true);
    try {
      const response = await fetch(`${API}/api/tasks/${encodeURIComponent(activeTaskId)}/delivery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method }) });
      const result = await response.json() as { delivery?: { path?: string; commit?: string }; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Delivery failed.");
      setMessages((current) => [...current, transientMessage("system", method === "commit" ? `Committed verified changes as ${result.delivery?.commit ?? "commit"}.` : `Exported patch to ${result.delivery?.path ?? "delivery folder"}.`, "status")]);
      setDeliveryReady(false);
      setTaskState("COMPLETE");
    } catch (error) { setMessages((current) => [...current, transientMessage("system", error instanceof Error ? error.message : "Delivery failed.", "warning")]); }
    finally { setDeliveryBusy(false); }
  }


  async function createCheckpoint() {
    if (!activeTaskId || !activeSession || checkpointBusy) return;
    setCheckpointBusy(true);
    setCheckpointError("");
    try {
      const contextSummary = messages.slice(-6).map((message) => `${message.role}: ${message.text.slice(0, 500)}`).join("\n");
      const response = await fetch(`${API}/api/tasks/${encodeURIComponent(activeTaskId)}/checkpoints`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: checkpointName.trim() || undefined, sessionId: activeSession.id, mode: activeMode, contextSummary }),
      });
      const result = await response.json() as { checkpoint?: TaskCheckpoint; error?: string };
      if (!response.ok || !result.checkpoint) throw new Error(result.error ?? "Unable to create checkpoint.");
      setCheckpointName("");
      await refreshCheckpoints(activeTaskId);
    } catch (error) {
      setCheckpointError(error instanceof Error ? error.message : "Unable to create checkpoint.");
    } finally {
      setCheckpointBusy(false);
    }
  }

  async function recordReviewDecision(finding: ReviewFinding, action: "accept" | "mark_fixed" | "waive" | "false_positive" | "reopen") {
    if (!activeTaskId || reviewBusy) return;
    let reason = "";
    let evidence: string[] = [];
    if (action === "waive" || action === "false_positive") {
      reason = window.prompt(action === "waive" ? "Why is this risk being waived?" : "Why is this a false positive?")?.trim() ?? "";
      if (!reason) return;
    }
    if (action === "mark_fixed") {
      const value = window.prompt("Paste verification evidence for this fix:")?.trim() ?? "";
      if (!value) return;
      evidence = [value];
      reason = "Operator verified the finding is fixed.";
    }
    setReviewBusy(true);
    setReviewError("");
    try {
      const response = await fetch(`${API}/api/tasks/${encodeURIComponent(activeTaskId)}/review-history`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ findingId: finding.id, action, reason, evidence }),
      });
      const result = await response.json() as { task?: { state: string }; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to record review decision.");
      if (result.task?.state) setTaskState(result.task.state);
      await refreshReviewHistory(activeTaskId);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "Unable to record review decision.");
    } finally {
      setReviewBusy(false);
    }
  }

  async function resumeCheckpoint(checkpoint: TaskCheckpoint) {
    if (!activeTaskId || !activeSession || checkpointBusy) return;
    setCheckpointBusy(true);
    setCheckpointError("");
    try {
      const response = await fetch(`${API}/api/tasks/${encodeURIComponent(activeTaskId)}/continuations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkpointId: checkpoint.id, reason: "Resume from desktop checkpoint timeline." }),
      });
      const result = await response.json() as { continuation?: TaskContinuation; error?: string };
      if (!result.continuation) throw new Error(result.error ?? "Unable to continue from checkpoint.");
      const continuation = result.continuation;
      const sessionResponse = await fetch(`${API}/api/sessions/${encodeURIComponent(activeSession.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ activeMode: continuation.restoredMode }),
      });
      const sessionResult = await sessionResponse.json() as { session?: ChatSession };
      if (sessionResult.session) setActiveSession(sessionResult.session);
      setTaskState(continuation.resultingState);
      setMessages((current) => [...current, transientMessage(
        "system",
        continuation.detail,
        continuation.status === "recovery_required" ? "warning" : "status",
      )]);
      await refreshCheckpoints(activeTaskId);
      if (!response.ok && continuation.status !== "recovery_required") throw new Error(result.error ?? continuation.detail);
    } catch (error) {
      setCheckpointError(error instanceof Error ? error.message : "Unable to continue from checkpoint.");
    } finally {
      setCheckpointBusy(false);
    }
  }

  async function saveAccess() {
    setSavingAccess(true);
    setAccessError("");
    try {
      const response = await fetch(`${API}/api/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryPath: repositoryDraft.trim() || null, documents: documentsDraft.split("\n").map((value) => value.trim()).filter(Boolean) }) });
      const result = await response.json() as { access?: AccessConfig; error?: string };
      if (!response.ok || !result.access) throw new Error(result.error ?? "Unable to save repository access.");
      setAccessConfig(result.access);
      setAccessOpen(false);
    } catch (error) { setAccessError(error instanceof Error ? error.message : "Unable to save repository access."); }
    finally { setSavingAccess(false); }
  }

  async function saveTools() {
    setSavingTools(true);
    setToolsError("");
    try {
      const response = await fetch(`${API}/api/tools`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ internetEnabled: internetDraft, apiKey: apiKeyDraft, clearApiKey: clearApiKeyDraft }) });
      const result = await response.json() as { tools?: ToolConfig; error?: string };
      if (!response.ok || !result.tools) throw new Error(result.error ?? "Unable to save internet configuration.");
      setToolConfig(result.tools);
      setApiKeyDraft("");
      setClearApiKeyDraft(false);
      setToolsOpen(false);
    } catch (error) { setToolsError(error instanceof Error ? error.message : "Unable to save internet configuration."); }
    finally { setSavingTools(false); }
  }

  return <SidebarProvider>
    <Dialog open={websiteOpen} onOpenChange={setWebsiteOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-white/10 bg-[#11161e] text-slate-100 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl">Create a website</DialogTitle>
          <DialogDescription>Give BORG the product direction up front. It will create the local project and keep this brief attached to the website.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 py-2">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-300">Website name</span>
            <Input value={websiteName} onChange={(event) => setWebsiteName(event.target.value)} placeholder="Acme AI" className="border-white/10 bg-white/4 text-slate-100" />
          </label>
          <div>
            <span className="mb-2 block text-sm font-medium text-slate-300">Starting point</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {WEBSITE_TEMPLATES.map((template) => <button key={template.id} type="button" onClick={() => setWebsiteTemplate(template.id)} className={`rounded-lg border p-3 text-left transition ${websiteTemplate === template.id ? "border-[#a7ff4f]/45 bg-[#a7ff4f]/8" : "border-white/10 bg-white/[0.025] hover:bg-white/5"}`}>
                <span className="block text-sm font-medium text-slate-200">{template.label}</span>
                <span className="mt-1 block text-xs leading-5 text-slate-500">{template.detail}</span>
              </button>)}
            </div>
          </div>
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-300">What do you want to build?</span>
            <textarea value={websiteBrief} onChange={(event) => setWebsiteBrief(event.target.value)} rows={6} placeholder="Describe the business, audience, pages, features, and visual direction. You can keep it simple." className="w-full resize-y rounded-lg border border-white/10 bg-white/4 px-3 py-3 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:border-[#a7ff4f]/40" />
          </label>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-600">Try an example</p>
            <div className="flex flex-wrap gap-2">{WEBSITE_EXAMPLES.slice(0, 3).map((example) => <button key={example} type="button" onClick={() => setWebsiteBrief(example)} className="rounded-full border border-white/10 bg-white/[0.025] px-3 py-1.5 text-xs text-slate-400 hover:border-white/20 hover:text-slate-200">{example.split(" ").slice(0, 5).join(" ")}…</button>)}</div>
          </div>
          {websiteError && <p className="rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{websiteError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setWebsiteOpen(false)} className="border-white/10 bg-transparent text-slate-300">Cancel</Button>
          <Button disabled={websiteBusy || !websiteName.trim() || !websiteBrief.trim()} onClick={() => void createWebsite()} className="bg-[#a7ff4f] text-[#071007]">
            <Sparkles className="size-4" />{websiteBusy ? "Creating…" : "Create website"}
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
    <Dialog open={accessOpen} onOpenChange={setAccessOpen}>
      <DialogContent className="border-white/10 bg-[#11161e] text-slate-100 sm:max-w-xl">
        <DialogHeader><DialogTitle>Repository access</DialogTitle><DialogDescription>The active repository is shared by chat sessions and remains inside the local BORG runtime.</DialogDescription></DialogHeader>
        <div className="space-y-5 py-2">
          <label className="block"><span className="mb-2 block text-sm font-medium text-slate-300">Repository folder</span><Input value={repositoryDraft} onChange={(event) => setRepositoryDraft(event.target.value)} placeholder="C:\\path\\to\\repository" className="border-white/10 bg-white/4 text-slate-100" /></label>
          <label className="block"><span className="mb-2 block text-sm font-medium text-slate-300">Additional documents</span><textarea value={documentsDraft} onChange={(event) => setDocumentsDraft(event.target.value)} rows={5} className="w-full resize-y rounded-md border border-white/10 bg-white/4 px-3 py-2 text-sm leading-6 text-slate-100 outline-none" /></label>
          {accessError && <p className="rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{accessError}</p>}
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setAccessOpen(false)} className="border-white/10 bg-transparent text-slate-300">Cancel</Button><Button onClick={() => void saveAccess()} disabled={savingAccess} className="bg-[#a7ff4f] text-[#071007]">{savingAccess ? "Saving…" : "Save access"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={toolsOpen} onOpenChange={setToolsOpen}>
      <DialogContent className="border-white/10 bg-[#11161e] text-slate-100 sm:max-w-xl">
        <DialogHeader><DialogTitle>Internet & API configuration</DialogTitle><DialogDescription>The API credential is stored in Windows Credential Manager. SQLite and JSON contain metadata only.</DialogDescription></DialogHeader>
        <div className="space-y-5 py-2">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.025] p-4"><div><p className="text-sm font-medium text-slate-200">Public internet</p><p className="mt-1 text-xs leading-5 text-slate-500">Enable safe page fetch and Ollama web search.</p></div><Switch checked={internetDraft} onCheckedChange={setInternetDraft} /></div>
          <label className="block"><span className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300"><KeyRound className="size-4" />Ollama web API key</span><Input type="password" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} placeholder={toolConfig?.credentialConfigured ? "Credential stored in Windows" : "Paste API key"} disabled={!internetDraft} className="border-white/10 bg-white/4 text-slate-100" /></label>
          {toolConfig?.credentialConfigured && <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={clearApiKeyDraft} onChange={(event) => setClearApiKeyDraft(event.target.checked)} />Remove the stored credential</label>}
          <div className="grid grid-cols-3 gap-3 text-sm"><div className="rounded-md border border-white/8 p-3"><p className="text-slate-500">Configuration</p><p className={`mt-1 ${toolConfig?.configurationState === "connection_failed" ? "text-red-300" : toolConfig?.configurationState === "available" ? "text-[#a7ff4f]" : "text-slate-300"}`}>{statusLabel(toolConfig)}</p></div><div className="rounded-md border border-white/8 p-3"><p className="text-slate-500">Page fetch</p><p className={toolConfig?.webFetchAvailable ? "mt-1 text-[#a7ff4f]" : "mt-1 text-slate-500"}>{toolConfig?.webFetchAvailable ? "Available" : "Off"}</p></div><div className="rounded-md border border-white/8 p-3"><p className="text-slate-500">Web search</p><p className={toolConfig?.webSearchAvailable ? "mt-1 text-[#a7ff4f]" : "mt-1 text-slate-500"}>{toolConfig?.webSearchAvailable ? "Available" : "Unavailable"}</p></div></div>
          {toolConfig?.lastConnectionError && <p className="rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{toolConfig.lastConnectionError}</p>}
          {toolsError && <p className="rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{toolsError}</p>}
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setToolsOpen(false)} className="border-white/10 bg-transparent text-slate-300">Cancel</Button><Button onClick={() => void saveTools()} disabled={savingTools} className="bg-[#a7ff4f] text-[#071007]">{savingTools ? "Saving…" : "Save configuration"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>


    <Dialog open={checkpointOpen} onOpenChange={setCheckpointOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-white/10 bg-[#11161e] text-slate-100 sm:max-w-2xl">
        <DialogHeader><DialogTitle>Task checkpoints</DialogTitle><DialogDescription>Continue from a saved task state. Checkpoints do not roll back website files or undo an approval; BORG checks whether a continuation is safe before changing the task state.</DialogDescription></DialogHeader>
        {!activeTaskId ? <p className="rounded-md border border-white/10 bg-white/3 p-4 text-sm text-slate-400">Start a task before creating a checkpoint.</p> : <>
          <div className="flex gap-2"><Input value={checkpointName} onChange={(event) => setCheckpointName(event.target.value)} placeholder="Checkpoint name (optional)" className="border-white/10 bg-white/4 text-slate-100" /><Button onClick={() => void createCheckpoint()} disabled={checkpointBusy}><BookmarkPlus className="size-4" />Save</Button></div>
          {checkpointError && <p className="rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{checkpointError}</p>}
          <div className="space-y-3">
            {[...checkpoints].reverse().map((checkpoint) => {
              const continuation = [...continuations].reverse().find((value) => value.checkpointId === checkpoint.id);
              return <div key={checkpoint.id} className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
                <div className="flex items-start justify-between gap-4"><div><p className="font-medium text-slate-200">{checkpoint.name}</p><p className="mt-1 text-xs text-slate-500">{checkpoint.kind.replaceAll("_", " ")} · {checkpoint.taskState} · {checkpoint.mode.toUpperCase()} · {new Date(checkpoint.createdAt).toLocaleString()}</p></div><Button size="sm" variant="outline" disabled={checkpointBusy} onClick={() => void resumeCheckpoint(checkpoint)} className="border-white/10 bg-transparent text-slate-300"><RotateCcw className="size-3.5" />Continue</Button></div>
                {checkpoint.contextSummary && <p className="mt-3 line-clamp-3 text-xs leading-5 text-slate-400">{checkpoint.contextSummary}</p>}
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs"><div><span className="text-slate-600">Completed</span><p className="mt-1 text-slate-400">{checkpoint.completedSteps.slice(-3).join(" → ") || "None"}</p></div><div><span className="text-slate-600">Remaining</span><p className="mt-1 text-slate-400">{checkpoint.remainingSteps.slice(0, 3).join(" → ") || "None"}</p></div></div>
                {continuation && <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${continuation.status === "recovery_required" ? "border-amber-300/20 bg-amber-300/5 text-amber-100" : "border-[#a7ff4f]/20 bg-[#a7ff4f]/5 text-[#d9ffb5]"}`}><span className="uppercase">{continuation.status.replaceAll("_", " ")}</span> · {continuation.repositoryState} · {continuation.resumeAction}<p className="mt-1 text-slate-400">{continuation.detail}</p></div>}
              </div>;
            })}
            {!checkpoints.length && <div className="rounded-lg border border-dashed border-white/10 p-6 text-center text-sm text-slate-500">No checkpoints recorded for this task yet.</div>}
          </div>
        </>}
        <DialogFooter><Button variant="outline" onClick={() => setCheckpointOpen(false)} className="border-white/10 bg-transparent text-slate-300">Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
      <DialogContent className="max-h-[88vh] overflow-y-auto border-white/10 bg-[#11161e] text-slate-100 sm:max-w-3xl">
        <DialogHeader><DialogTitle>Review history</DialogTitle><DialogDescription>Durable findings and append-only operator decisions across repairs, checkpoints, and continuations.</DialogDescription></DialogHeader>
        {reviewError && <p className="rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{reviewError}</p>}
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-slate-400">{reviewFindings.length} total</span>
          <span className={`rounded-full border px-2.5 py-1 ${blockingFindingIds.length ? "border-red-400/30 bg-red-400/8 text-red-200" : "border-[#a7ff4f]/20 bg-[#a7ff4f]/5 text-[#d9ffb5]"}`}>{blockingFindingIds.length} blocking</span>
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-slate-400">{reviewDecisions.length} decisions</span>
        </div>
        <div className="space-y-3">
          {[...reviewFindings].reverse().map((record) => {
            const latestDecision = [...reviewDecisions].reverse().find((value) => value.findingId === record.id);
            const active = record.state === "open" || record.state === "accepted" || record.state === "reopened";
            const blocking = blockingFindingIds.includes(record.id);
            return <div key={record.id} className={`rounded-lg border p-4 ${blocking ? "border-red-400/25 bg-red-400/[0.04]" : "border-white/10 bg-white/[0.025]"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${record.finding.severity === "critical" || record.finding.severity === "high" ? "bg-red-400/10 text-red-200" : record.finding.severity === "medium" ? "bg-amber-300/10 text-amber-100" : "bg-white/5 text-slate-400"}`}>{record.finding.severity}</span><span className="text-[10px] uppercase tracking-wide text-slate-500">{record.finding.discipline} · {record.finding.category}</span><span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">{record.state.replaceAll("_", " ")}</span></div><p className="mt-2 font-medium text-slate-200">{record.finding.title}</p>{record.finding.file && <p className="mt-1 font-mono text-xs text-[#a7ff4f]">{record.finding.file}{record.finding.line ? `:${record.finding.line}` : ""}</p>}</div><span className="text-[10px] text-slate-600">Seen {new Date(record.lastSeenAt).toLocaleString()}</span></div>
              <p className="mt-3 text-sm leading-6 text-slate-400">{record.finding.description}</p>
              {record.finding.evidence && <p className="mt-2 rounded-md border border-white/8 bg-black/15 px-3 py-2 text-xs leading-5 text-slate-400"><span className="text-slate-600">Evidence: </span>{record.finding.evidence}</p>}
              {latestDecision && <p className="mt-2 text-xs text-slate-500">Latest decision: {latestDecision.action.replaceAll("_", " ")} by {latestDecision.actorId}{latestDecision.reason ? ` — ${latestDecision.reason}` : ""}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {active ? <>
                  {record.state !== "accepted" && <Button size="sm" variant="outline" disabled={reviewBusy} onClick={() => void recordReviewDecision(record, "accept")} className="border-white/10 bg-transparent text-slate-300">Accept</Button>}
                  <Button size="sm" variant="outline" disabled={reviewBusy} onClick={() => void recordReviewDecision(record, "mark_fixed")} className="border-white/10 bg-transparent text-slate-300">Mark fixed</Button>
                  <Button size="sm" variant="outline" disabled={reviewBusy || record.finding.severity === "critical"} onClick={() => void recordReviewDecision(record, "waive")} className="border-white/10 bg-transparent text-slate-300">Waive</Button>
                  <Button size="sm" variant="outline" disabled={reviewBusy} onClick={() => void recordReviewDecision(record, "false_positive")} className="border-white/10 bg-transparent text-slate-300">False positive</Button>
                </> : <Button size="sm" variant="outline" disabled={reviewBusy} onClick={() => void recordReviewDecision(record, "reopen")} className="border-white/10 bg-transparent text-slate-300">Reopen</Button>}
              </div>
            </div>;
          })}
          {!reviewFindings.length && <div className="rounded-lg border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">No review findings have been recorded for this task.</div>}
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setReviewOpen(false)} className="border-white/10 bg-transparent text-slate-300">Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Sidebar className="border-r border-white/8 bg-[#0a0d12]" collapsible="offcanvas">
      <SidebarHeader className="border-b border-white/8 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-[#a7ff4f] text-[#071007]"><Bot className="size-5" /></div>
          <div className="min-w-0"><p className="text-sm font-semibold tracking-wide text-white">BORG</p><p className="text-xs text-slate-500">LOCAL WEBSITE BUILDER</p></div>
        </div>
        <Button onClick={() => setWebsiteOpen(true)} className="mt-4 w-full justify-start gap-2 bg-[#a7ff4f] text-[#071007] hover:bg-[#b9ff74]"><Plus className="size-4" />New Website</Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-slate-500">My Websites</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {websiteSessions.map((session) => <SidebarMenuItem key={session.id}><div className="group flex items-center gap-1"><SidebarMenuButton isActive={activeSession?.id === session.id} onClick={() => void loadSession(session.id)} className="min-w-0 flex-1 text-slate-300 hover:bg-white/7 hover:text-white"><Globe2 /><span className="truncate">{session.title}</span></SidebarMenuButton><button type="button" aria-label={`Rename ${session.title}`} onClick={() => void renameSession(session)} className="hidden rounded p-1 text-slate-600 hover:bg-white/8 hover:text-white group-hover:block"><Pencil className="size-3" /></button><button type="button" aria-label={`Delete ${session.title}`} onClick={() => void deleteSession(session)} className="hidden rounded p-1 text-slate-600 hover:bg-red-400/10 hover:text-red-200 group-hover:block"><Trash2 className="size-3" /></button></div></SidebarMenuItem>)}
            </SidebarMenu>
            {!websiteSessions.length && <button type="button" onClick={() => setWebsiteOpen(true)} className="w-full rounded-lg border border-dashed border-white/10 px-3 py-4 text-left text-xs leading-5 text-slate-500 hover:border-white/20 hover:text-slate-300">Create your first website to start building with BORG.</button>}
            {activeTaskId && <Button variant="ghost" size="sm" onClick={() => setRightPanel("changes")} className="mt-2 w-full justify-start gap-2 text-xs text-slate-500"><History className="size-3.5" />Recent changes{changes.files.length ? ` (${changes.files.length})` : ""}</Button>}
          </SidebarGroupContent>
        </SidebarGroup>
        {legacySessions.length > 0 && <SidebarGroup>
          <details className="px-2">
            <summary className="cursor-pointer select-none px-2 py-2 text-xs font-medium text-slate-600">Developer sessions</summary>
            <SidebarMenu>{legacySessions.map((session) => <SidebarMenuItem key={session.id}><SidebarMenuButton isActive={activeSession?.id === session.id} onClick={() => void loadSession(session.id)} className="text-slate-400 hover:bg-white/7 hover:text-white"><MessageSquare /><span className="truncate">{session.title}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
            <Button variant="ghost" size="sm" onClick={() => void createSession()} className="mt-1 w-full justify-start gap-2 text-xs text-slate-600"><Plus className="size-3.5" />New developer chat</Button>
          </details>
        </SidebarGroup>}
        <SidebarGroup>
          <SidebarGroupLabel className="text-slate-500">Settings</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem><SidebarMenuButton onClick={() => setToolsOpen(true)} isActive={toolConfig?.configurationState === "available"} className="text-slate-300 hover:bg-white/7 hover:text-white"><Globe2 /><span>Internet & model tools</span><span className="ml-auto text-[10px] text-slate-600">{statusLabel(toolConfig)}</span></SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton onClick={() => setAccessOpen(true)} className="text-slate-400 hover:bg-white/7 hover:text-white"><FolderGit2 /><span>Advanced repository access</span></SidebarMenuButton></SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-white/8 p-4"><div className="flex items-center gap-2 text-xs text-slate-400"><span className={`size-2 rounded-full ${serverAvailable ? "bg-[#a7ff4f] shadow-[0_0_10px_#a7ff4f]" : "bg-slate-600"}`} />{serverAvailable ? "BORG ready" : "BORG offline"}</div></SidebarFooter>
    </Sidebar>

    <SidebarInset className="h-svh min-h-0 min-w-0 overflow-hidden bg-[#0d1117] text-slate-100">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/8 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarTrigger className="text-slate-400" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-200">{activeSession?.title ?? "Choose a website"}</p>
            <p className="hidden truncate text-[11px] text-slate-600 sm:block">{previewUrl ?? (isWebsite ? "Local website project" : "Developer workspace")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isWebsite && <Button size="sm" variant="outline" onClick={() => setRightPanel("preview")} className="hidden border-white/10 bg-white/4 text-slate-300 sm:inline-flex"><Monitor className="size-3.5" />Preview</Button>}
          <Button size="sm" variant="outline" disabled={!activeTaskId} onClick={() => setRightPanel("changes")} className="border-white/10 bg-white/4 text-slate-300"><History className="size-3.5" /><span className="hidden sm:inline">Changes</span></Button>
          <Select value={activeMode} onValueChange={(value) => void changeMode(value as PermissionMode)} disabled={!activeSession || streaming}>
            <SelectTrigger size="sm" className="border-white/10 bg-white/4 text-slate-200"><ShieldCheck className="size-3.5 text-[#a7ff4f]" /><SelectValue /></SelectTrigger>
            <SelectContent className="border-white/10 bg-[#151a22] text-slate-100">
              <SelectItem value="plan">Safe mode</SelectItem>
              <SelectItem value="edit">Build mode</SelectItem>
              <SelectItem value="agent">Autopilot</SelectItem>
              <SelectItem value="ask">Ask only</SelectItem>
            </SelectContent>
          </Select>
          <details className="relative">
            <summary className="list-none cursor-pointer rounded-md border border-white/10 bg-white/4 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200">Advanced</summary>
            <div className="absolute right-0 z-50 mt-2 w-48 rounded-lg border border-white/10 bg-[#11161e] p-2 shadow-2xl">
              <button type="button" disabled={!activeTaskId} onClick={() => setReviewOpen(true)} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"><ShieldAlert className="size-3.5" />Review history{blockingFindingIds.length ? ` (${blockingFindingIds.length})` : ""}</button>
              <button type="button" disabled={!activeTaskId} onClick={() => setCheckpointOpen(true)} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"><History className="size-3.5" />Checkpoints</button>
              <button type="button" onClick={() => setAccessOpen(true)} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200"><FolderGit2 className="size-3.5" />Repository access</button>
            </div>
          </details>
        </div>
      </header>

      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row"><div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-7 sm:px-8 lg:basis-[35%] lg:flex-none lg:px-8"><div className="mx-auto max-w-3xl">
          <div className="mb-6 flex items-start justify-between gap-4"><div><p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#a7ff4f]">{isWebsite ? "Website workspace" : "Developer workspace"}</p><h1 className="mt-2 text-2xl font-semibold tracking-tight">{activeSession?.title ?? "Choose a website"}</h1></div>{activeTaskId && <span className="rounded-full border border-white/10 bg-white/4 px-3 py-1 text-xs capitalize text-slate-400">{taskState.replaceAll("_", " ").toLowerCase()}</span>}</div>
          {sessionError && <div className="mb-5 rounded-lg border border-red-400/20 bg-red-400/8 px-4 py-3 text-sm text-red-200">{sessionError}</div>}
          <div className="space-y-4">
            {visibleMessages.length ? visibleMessages.map((message) => <AssistantMessage key={message.id} message={message} />) : isWebsite ? <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
              <div className="flex size-10 items-center justify-center rounded-xl bg-[#a7ff4f]/10 text-[#a7ff4f]"><Sparkles className="size-5" /></div>
              <h2 className="mt-5 text-xl font-semibold tracking-tight text-white">What do you want to build?</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">Describe the result in normal language. BORG will turn it into a design direction, show you what it plans to build, and wait for your Build approval before changing files.</p>
              <div className="mt-5 grid gap-2">
                {WEBSITE_EXAMPLES.map((example) => <button key={example} type="button" onClick={() => setRequest(example)} className="rounded-lg border border-white/8 bg-black/10 px-3 py-2.5 text-left text-xs leading-5 text-slate-400 transition hover:border-white/15 hover:bg-white/[0.03] hover:text-slate-200">{example}</button>)}
              </div>
            </div> : <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-white/10 bg-white/[0.015] p-8 text-center"><div><Bot className="mx-auto mb-3 size-7 text-slate-600" /><p className="text-sm font-medium text-slate-300">Developer session</p><p className="mt-1 text-sm text-slate-500">Use this advanced workspace for repository tasks that are not tied to a BORG website.</p></div></div>}
            {activeTaskId && isWebsite && <div role="status" aria-live="polite" className="rounded-xl border border-[#a7ff4f]/20 bg-[#a7ff4f]/5 p-4">
              <div className="flex items-start gap-3"><span className={`mt-1.5 size-2 shrink-0 rounded-full bg-[#a7ff4f] ${streaming || taskIsRunning(taskState) ? "animate-pulse" : ""}`} /><div><p className="text-sm font-medium text-[#d9ffb5]">{currentProgress?.title ?? (builderStep === 4 ? "Website ready for review" : "BORG is working")}</p><p className="mt-1 text-xs leading-5 text-slate-400">{currentProgress?.detail ?? "BORG is continuing the current website build."}</p></div></div>
              <div className="mt-4 grid grid-cols-5 gap-1">{BUILDER_STEPS.map((step, index) => <div key={step} className="min-w-0"><div className={`h-1 rounded-full ${index <= builderStep ? "bg-[#a7ff4f]" : "bg-white/8"}`} /><p className={`mt-1 truncate text-[9px] uppercase tracking-wide ${index <= builderStep ? "text-[#cfff9e]" : "text-slate-700"}`}>{step}</p></div>)}</div>
            </div>}
            <ActivityFeed activities={activities} />
            {activityItems.length > 0 && <details className="rounded-lg border border-white/8 bg-white/[0.015] px-4 py-3 text-xs text-slate-500"><summary className="cursor-pointer select-none font-medium text-slate-400">Technical activity ({activityItems.length})</summary><ul className="mt-3 max-h-56 space-y-1.5 overflow-y-auto pl-4">{activityItems.map((item, index) => <li key={`${index}:${item}`} className="break-words">{item}</li>)}</ul></details>}
          </div>
        </div></div>{(activeTaskId || previewUrl || previewError || latestPlan || changes.files.length > 0) && <div className="flex min-h-[320px] flex-1 flex-col overflow-hidden overscroll-contain border-t border-white/8 lg:min-h-0 lg:basis-[65%] lg:flex-none lg:border-l lg:border-t-0">
          <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-white/8 bg-[#0a0d12] px-3 py-1.5">
            <div className="flex items-center gap-1">
              <button type="button" disabled={!isWebsite} onClick={() => { setRightPanel("preview"); if (activeSession && !previewUrl) void activatePreview(activeSession.id); }} className={`rounded px-2.5 py-1 text-xs font-medium ${rightPanel === "preview" ? "bg-white/8 text-slate-200" : "text-slate-500 hover:text-slate-300 disabled:opacity-40"}`}>Preview</button>
              <button type="button" onClick={() => setRightPanel("changes")} className={`rounded px-2.5 py-1 text-xs font-medium ${rightPanel === "changes" ? "bg-white/8 text-slate-200" : "text-slate-500 hover:text-slate-300"}`}>Changes{changes.files.length ? ` (${changes.files.length})` : ""}</button>
              <button type="button" onClick={() => { setRightPanel("docs"); if (activeTaskId) void refreshDocs(activeTaskId); }} className={`rounded px-2.5 py-1 text-xs font-medium ${rightPanel === "docs" ? "bg-white/8 text-slate-200" : "text-slate-500 hover:text-slate-300"}`}>Docs</button>
              <details className="relative">
                <summary className="list-none cursor-pointer rounded px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-white/5 hover:text-slate-300">Advanced</summary>
                <div className="absolute left-0 z-40 mt-2 w-40 rounded-lg border border-white/10 bg-[#11161e] p-1.5 shadow-2xl">
                  <button type="button" disabled={!latestPlan} onClick={() => setRightPanel("plan")} className="w-full rounded px-2.5 py-2 text-left text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 disabled:opacity-40">Plan</button>
                  <button type="button" disabled={!designBrief} onClick={() => setRightPanel("design")} className="w-full rounded px-2.5 py-2 text-left text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 disabled:opacity-40">Design review{designReview?.status === "repair" ? " •" : ""}</button>
                  <button type="button" onClick={() => setRightPanel("terminal")} className="w-full rounded px-2.5 py-2 text-left text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200">Terminal{runningProcesses.length ? ` (${runningProcesses.length})` : ""}</button>
                </div>
              </details>
            </div>
            {rightPanel === "preview" && <div className="flex items-center gap-1">
              {previewUrl && <>
                <button type="button" aria-label="Desktop preview" onClick={() => setPreviewViewport("desktop")} className={`rounded p-1.5 ${previewViewport === "desktop" ? "bg-white/8 text-slate-200" : "text-slate-600 hover:text-slate-300"}`}><Monitor className="size-3.5" /></button>
                <button type="button" aria-label="Tablet preview" onClick={() => setPreviewViewport("tablet")} className={`rounded p-1.5 ${previewViewport === "tablet" ? "bg-white/8 text-slate-200" : "text-slate-600 hover:text-slate-300"}`}><Tablet className="size-3.5" /></button>
                <button type="button" aria-label="Mobile preview" onClick={() => setPreviewViewport("mobile")} className={`rounded p-1.5 ${previewViewport === "mobile" ? "bg-white/8 text-slate-200" : "text-slate-600 hover:text-slate-300"}`}><Smartphone className="size-3.5" /></button>
                <span className="mx-1 h-4 w-px bg-white/10" />
                <Button size="sm" variant="ghost" onClick={() => setPreviewVersion((value) => value + 1)} className="h-7 gap-1 px-2 text-xs text-slate-500"><RotateCcw className="size-3.5" /><span className="hidden sm:inline">Refresh</span></Button>
                <a href={previewUrl} target="_blank" rel="noreferrer" aria-label="Open preview in a new window" className="inline-flex rounded p-1.5 text-slate-500 hover:bg-white/5 hover:text-white"><ExternalLink className="size-3.5" /></a>
              </>}
            </div>}
          </div>
          {rightPanel === "preview" && previewUrl && <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/8 bg-[#0c1016] px-3 text-[10px] text-slate-600">
            <span className={`size-1.5 rounded-full ${previewProcess?.status === "failed" ? "bg-red-300" : "bg-[#a7ff4f]"}`} />
            <span className="min-w-0 flex-1 truncate font-mono">{previewUrl}</span>
            <span>{previewVersion > 0 ? "Preview updated" : previewProcess?.status === "starting" ? "Starting…" : "Live"}</span>
          </div>}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {rightPanel === "plan"
              ? <PlanPanel plan={latestPlan} />
              : rightPanel === "docs"
                ? <DocsPanel docs={buildDocs} />
              : rightPanel === "changes"
                ? <ChangesPanel changes={changes} />
                : rightPanel === "design"
                  ? <DesignPanel brief={designBrief} review={designReview} refinementCount={designRefinementCount} maxRefinements={maxDesignRefinements} />
                  : rightPanel === "terminal"
                    ? <TerminalPanel processes={processes} events={processEvents} onStop={stopTaskProcess} />
                    : previewUrl
                    ? <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-[#151a22] p-2 sm:p-3"><div className={`h-full min-h-[520px] overflow-hidden rounded-md border border-white/10 bg-white shadow-2xl transition-[width] duration-200 ${previewViewport === "mobile" ? "w-[390px] max-w-full" : previewViewport === "tablet" ? "w-[820px] max-w-full" : "w-full"}`}><iframe key={`${previewUrl}:${previewVersion}`} title="Website live preview" src={previewUrl} className="h-full w-full border-0 bg-white" /></div></div>
                    : <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto overscroll-contain p-6 text-center"><div><Monitor className="mx-auto size-7 text-slate-700" /><p className="mt-3 text-sm text-slate-400">{previewError || "The live preview will appear here as soon as the website is ready."}</p>{isWebsite && activeSession && <Button size="sm" variant="outline" onClick={() => void activatePreview(activeSession.id)} className="mt-4 border-white/10 bg-white/4 text-slate-300">{previewError ? "Retry preview" : "Start preview"}</Button>}</div></div>}
          </div>
        </div>}</div>

        <div className="border-t border-white/8 bg-[#0a0d12]/95 p-4 sm:px-8">
          {approval && (escalation || planApproval) && <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-[#a7ff4f]/25 bg-[#a7ff4f]/5 p-4"><div className="max-w-xl"><p className="text-sm font-medium text-[#d9ffb5]">{planApproval ? "Approve frontend phase plan" : "Ready to build this slice"}</p><p className="mt-1 text-xs leading-5 text-slate-400">{planApproval ? "Approval freezes the tailored slice roadmap and starts the frontend build. BORG will execute each slice in a bounded mini-loop inside isolated worktrees." : "This mini-plan is limited to the current approved slice. Approved frontend slices execute automatically inside the frozen phase plan."}</p></div><div className="flex gap-2"><Button type="button" variant="outline" disabled={approvalBusy} onClick={() => void decideEscalation("reject")} className="border-white/10 bg-transparent text-slate-300"><X className="size-4" />{planApproval ? "Revise plan" : "Keep planning"}</Button><Button type="button" disabled={approvalBusy} onClick={() => void decideEscalation("approve")} className="bg-[#a7ff4f] text-[#071007]"><Sparkles className="size-4" />{approvalBusy ? "Saving…" : planApproval ? "Approve plan" : "Build slice"}</Button></div></div>}
          {deliveryReady && <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-[#a7ff4f]/20 bg-[#a7ff4f]/5 p-3"><div><p className="text-sm font-medium text-[#d9ffb5]">Website check complete</p><p className="mt-1 text-xs text-slate-400">{changes.files.length ? `${changes.files.length} files updated. ` : ""}The verified result is ready in Preview. Save the change set when you are happy with it.</p></div><div className="flex gap-2"><Button variant="outline" disabled={deliveryBusy} onClick={() => setRightPanel("changes")} className="border-white/10 bg-transparent text-slate-300">Review changes</Button><Button disabled={deliveryBusy} onClick={() => void deliver("commit")} className="bg-[#a7ff4f] text-[#071007]">Save version</Button></div></div>}
          {taskState === "COMPLETE" && sliceState && !["working", "plan_pending"].includes(sliceState.status) && <div className="mx-auto mb-3 max-w-3xl rounded-xl border border-[#a7ff4f]/20 bg-[#a7ff4f]/5 p-4">
            <p className="text-sm font-medium text-[#d9ffb5]">{sliceState.status === "ready" ? `Frontend plan approved — ${sliceState.currentTitle} is ready` : sliceState.status === "frontend_complete" ? (sliceState.backendRequired ? "Frontend complete — backend phase is available" : "Frontend complete — static site can be finalized") : `Slice ${sliceState.current + 1} of ${sliceState.total} complete — your feedback is needed`}</p>
            <p className="mt-1 text-xs text-slate-400">{sliceState.status === "ready" ? "Slice 1 starts a lightweight mini-loop in a new session. BORG will not rediscover or re-plan the whole website." : "Review Preview, Changes, and Docs. The next step starts in a new session and carries forward the approved project state."}</p>
            {sliceState.status !== "ready" && <Input value={sliceFeedback} onChange={(event) => setSliceFeedback(event.target.value)} placeholder="What worked, and what should change? “Looks good” is enough to continue." aria-label="Feedback on this slice" className="mt-3 border-white/10 bg-white/4 text-slate-100" />}
            <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setRightPanel("docs")} className="border-white/10 bg-transparent text-slate-300">Read docs</Button>{sliceState.status === "ready" ? <Button size="sm" disabled={sliceBusy} onClick={() => void startSliceSession("initial")} className="bg-[#a7ff4f] text-[#071007]">Start slice 1</Button> : sliceState.status === "frontend_complete" ? (sliceState.backendRequired ? <Button size="sm" disabled={!sliceFeedback.trim() || sliceBusy} onClick={() => void startSliceSession("backend")} className="bg-[#a7ff4f] text-[#071007]">Plan backend in new session</Button> : null) : <><Button size="sm" variant="outline" disabled={!sliceFeedback.trim() || sliceBusy} onClick={() => void startSliceSession("revise")} className="border-white/10 bg-transparent text-slate-300">Revise this slice</Button><Button size="sm" disabled={sliceBusy} onClick={() => void startSliceSession("advance")} className="bg-[#a7ff4f] text-[#071007]">Approve and start next slice</Button></>}</div>
          </div>}
          <form className="mx-auto flex max-w-3xl items-center gap-3" onSubmit={(event) => { event.preventDefault(); if (taskBusy) return; const value = request; setRequest(""); void runTask(value); }}>
            <Input value={request} onChange={(event) => setRequest(event.target.value)} disabled={taskBusy || !activeSession} className="h-11 border-white/10 bg-white/4 text-base text-white placeholder:text-slate-600" placeholder={isWebsite ? "Describe a change to this website…" : `Ask BORG in ${activeMode.toUpperCase()} mode…`} />
            <Button type={canStop ? "button" : "submit"} disabled={taskBusy && !canStop} onClick={() => { if (canStop) { abortRef.current?.abort(); setStreaming(false); setTaskState("CANCELLED"); } }} className={`h-11 gap-2 px-5 ${taskBusy ? "bg-white/8 text-slate-200" : "bg-[#a7ff4f] text-[#071007]"}`}>{canStop ? <CircleStop className="size-4" /> : <Play className="size-4" />}{actionLabel}</Button>
          </form>
        </div>
      </section>
    </SidebarInset>
  </SidebarProvider>;
}
