"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookmarkPlus, Bot, Check, ChevronRight, CircleStop, ExternalLink, FileText, FolderGit2, Globe2, History, KeyRound, MessageSquare, Pencil, Play, Plus, RotateCcw, Settings2, ShieldAlert, ShieldCheck, Trash2, Wrench, X } from "lucide-react";
import { AssistantMessage, type RenderableMessage } from "@/components/chat/assistant-message";
import { isUnsupportedLanguageTool, stageProgress, toolProgress } from "./agent-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";

const API = "http://127.0.0.1:4312";
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

export function BorgWorkspaceV2() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [request, setRequest] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(false);
  const [runtimeConnected, setRuntimeConnected] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskState, setTaskState] = useState("READY");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [escalation, setEscalation] = useState<Escalation | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [deliveryReady, setDeliveryReady] = useState(false);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [accessConfig, setAccessConfig] = useState<AccessConfig | null>(null);
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
  const [websiteOpen, setWebsiteOpen] = useState(false);
  const [websiteName, setWebsiteName] = useState("");
  const [websiteBusy, setWebsiteBusy] = useState(false);
  const [websiteError, setWebsiteError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);
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
  const activeMode = activeSession?.activeMode ?? "plan";
  const actionLabel = useMemo(() => streaming ? "Stop" : "Send", [streaming]);
  const activityMessages = useMemo(() => messages.filter((message) => message.role === "tool" || (message.kind === "warning" && isUnsupportedLanguageTool(message.text))), [messages]);
  const visibleMessages = useMemo(() => messages.filter((message) => message.role !== "tool" && !(message.kind === "warning" && isUnsupportedLanguageTool(message.text))), [messages]);
  const activityItems = useMemo(() => [...activityMessages.map((message) => message.text), ...liveActivity].slice(-60), [activityMessages, liveActivity]);

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
      setPreviewError(result.error ?? "Unable to restore website preview.");
    }
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    const response = await fetch(`${API}/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) throw new Error("Unable to load chat session.");
    const result = await response.json() as {
      session: ChatSession;
      messages: ChatMessage[];
      latestTaskId: string | null;
      task: { id: string; state: string } | null;
      approval: Approval | null;
      escalation: Escalation | null;
      runtimeAvailable: boolean;
    };
    const pendingApproval = result.approval?.status === "REQUESTED" ? result.approval : null;
    const pendingEscalation = result.task?.state === "AWAITING_APPROVAL" ? result.escalation : null;
    setActiveSession(result.session);
    setSessions((current) => current.map((session) => session.id === result.session.id ? result.session : session));
    setMessages(result.messages);
    setProgress(null);
    setLiveActivity([]);
    setActiveTaskId(result.latestTaskId);
    setApproval(pendingApproval);
    setEscalation(pendingEscalation);
    setDeliveryReady(result.task?.state === "DELIVERY_READY");
    setTaskState(result.task?.state ?? (result.latestTaskId && !result.runtimeAvailable ? "RUNTIME UNAVAILABLE" : "READY"));
    setPreviewUrl(null);
    setPreviewError("");
    await activatePreview(sessionId);
    return result;
  }, [activatePreview]);

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
    setWebsiteBusy(true);
    setWebsiteError("");
    try {
      const response = await fetch(`${API}/api/websites`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: websiteName }) });
      const result = await response.json() as { session?: ChatSession; error?: string };
      if (!response.ok || !result.session) throw new Error(result.error ?? "Unable to create website.");
      setWebsiteOpen(false);
      setWebsiteName("");
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
    } else if (event.type === "stage.updated" && event.status === "active" && event.stage) {
      const next = stageProgress(event.stage);
      if (next) setProgress(next);
    } else if (event.type === "tool.started") {
      const tool = event.tool ?? "tool";
      setProgress({ title: toolProgress(tool, event.input), detail: "BORG will show its proposed choices in the plan after this review." });
      setLiveActivity((current) => [...current.slice(-39), `Running ${tool}${event.input?.path ? ` · ${String(event.input.path)}` : ""}`]);
    } else if (event.type === "tool.failed") {
      const detail = `${event.tool ?? "Tool"} failed: ${event.message ?? "Unknown error"}`;
      setLiveActivity((current) => [...current.slice(-39), detail]);
      if (!isUnsupportedLanguageTool(detail)) setMessages((current) => [...current, transientMessage("system", detail, "warning")]);
    } else if (event.type === "mode.escalation.requested" && event.approval && event.escalation) {
      setApproval(event.approval);
      setEscalation(event.escalation);
      setTaskState("AWAITING_APPROVAL");
    } else if (event.type === "mode.authorized") {
      setTaskState("IMPLEMENTING");
      if (activeSession) void activatePreview(activeSession.id);
    } else if (event.type === "implementation.summary") {
      setMessages((current) => [...current, transientMessage("system", event.diff?.stdout?.trim() || "No diff produced.", "diff")]);
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

  async function runTask(prompt: string) {
    const clean = prompt.trim();
    if (!activeSession || !clean || streaming) return;
    const controller = new AbortController();
    abortRef.current = controller;
    liveAssistantId.current = null;
    setStreaming(true);
    setProgress({ title: "Reading your request", detail: "BORG will review the project, then show its proposed design choices in the plan." });
    setLiveActivity([]);
    setApproval(null);
    setEscalation(null);
    setDeliveryReady(false);
    setTaskState("STARTING");
    setMessages((current) => [...current, transientMessage("user", clean)]);
    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: activeSession.id, request: clean }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Unable to start BORG task.");
      await consumeStream(response);
      await loadSession(activeSession.id);
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

  async function decideEscalation(decision: "approve" | "reject") {
    if (!activeSession || !activeTaskId || !approval || approvalBusy) return;
    setApprovalBusy(true);
    try {
      const response = await fetch(`${API}/api/tasks/${encodeURIComponent(activeTaskId)}/approval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      const result = await response.json() as { session?: ChatSession; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to record mode decision.");
      if (result.session) {
        setActiveSession(result.session);
        setSessions((current) => current.map((session) => session.id === result.session!.id ? result.session! : session));
      }
      if (decision === "approve") {
        setApproval(null);
        setEscalation(null);
        setStreaming(true);
        setProgress(stageProgress("Implementation"));
        await activatePreview(activeSession.id);
        const executeResponse = await fetch(`${API}/api/tasks/${encodeURIComponent(activeTaskId)}/execute`, { method: "POST" });
        await consumeStream(executeResponse);
        await loadSession(activeSession.id);
      } else {
        setApproval(null);
        setEscalation(null);
        setTaskState("PLAN COMPLETE");
        await loadSession(activeSession.id);
      }
    } catch (error) {
      setMessages((current) => [...current, transientMessage("system", error instanceof Error ? error.message : "Mode transition failed.", "warning")]);
    } finally {
      setStreaming(false);
      setApprovalBusy(false);
    }
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
      <DialogContent className="border-white/10 bg-[#11161e] text-slate-100 sm:max-w-md">
        <DialogHeader><DialogTitle>New website</DialogTitle><DialogDescription>BORG creates a local React website, installs its dependencies, and opens a live preview.</DialogDescription></DialogHeader>
        <label className="block py-2"><span className="mb-2 block text-sm font-medium text-slate-300">Website name</span><Input value={websiteName} onChange={(event) => setWebsiteName(event.target.value)} placeholder="My new website" className="border-white/10 bg-white/4 text-slate-100" /></label>
        {websiteError && <p className="text-sm text-red-200">{websiteError}</p>}
        <DialogFooter><Button variant="outline" onClick={() => setWebsiteOpen(false)} className="border-white/10 bg-transparent text-slate-300">Cancel</Button><Button disabled={websiteBusy || !websiteName.trim()} onClick={() => void createWebsite()} className="bg-[#a7ff4f] text-[#071007]">{websiteBusy ? "Creating…" : "Create website"}</Button></DialogFooter>
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
        <DialogHeader><DialogTitle>Task checkpoints</DialogTitle><DialogDescription>Immutable lifecycle snapshots. Resuming validates the recorded approval and worktree before changing task state.</DialogDescription></DialogHeader>
        {!activeTaskId ? <p className="rounded-md border border-white/10 bg-white/3 p-4 text-sm text-slate-400">Start a task before creating a checkpoint.</p> : <>
          <div className="flex gap-2"><Input value={checkpointName} onChange={(event) => setCheckpointName(event.target.value)} placeholder="Checkpoint name (optional)" className="border-white/10 bg-white/4 text-slate-100" /><Button onClick={() => void createCheckpoint()} disabled={checkpointBusy}><BookmarkPlus className="size-4" />Save</Button></div>
          {checkpointError && <p className="rounded-md border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{checkpointError}</p>}
          <div className="space-y-3">
            {[...checkpoints].reverse().map((checkpoint) => {
              const continuation = [...continuations].reverse().find((value) => value.checkpointId === checkpoint.id);
              return <div key={checkpoint.id} className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
                <div className="flex items-start justify-between gap-4"><div><p className="font-medium text-slate-200">{checkpoint.name}</p><p className="mt-1 text-xs text-slate-500">{checkpoint.kind.replaceAll("_", " ")} · {checkpoint.taskState} · {checkpoint.mode.toUpperCase()} · {new Date(checkpoint.createdAt).toLocaleString()}</p></div><Button size="sm" variant="outline" disabled={checkpointBusy} onClick={() => void resumeCheckpoint(checkpoint)} className="border-white/10 bg-transparent text-slate-300"><RotateCcw className="size-3.5" />Resume</Button></div>
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
        <div className="flex items-center gap-3"><div className="grid size-9 place-items-center rounded-lg bg-[#a7ff4f] text-[#071007]"><Bot className="size-5" /></div><div className="min-w-0"><p className="text-sm font-semibold tracking-wide text-white">BORG CODE</p><p className="text-xs text-slate-500">PERSISTENT WORKSTATION</p></div></div>
        <Button onClick={() => void createSession()} className="mt-4 w-full justify-start gap-2 bg-white/7 text-slate-200 hover:bg-white/10"><Plus className="size-4" />New Chat</Button>
        <Button onClick={() => setWebsiteOpen(true)} className="mt-2 w-full justify-start gap-2 bg-[#a7ff4f] text-[#071007] hover:bg-[#b9ff74]"><Globe2 className="size-4" />New Website</Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup><SidebarGroupLabel className="text-slate-500">Chats</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{sessions.map((session) => <SidebarMenuItem key={session.id}><div className="group flex items-center gap-1"><SidebarMenuButton isActive={activeSession?.id === session.id} onClick={() => void loadSession(session.id)} className="min-w-0 flex-1 text-slate-300 hover:bg-white/7 hover:text-white"><MessageSquare /><span className="truncate">{session.title}</span><span className="ml-auto text-[10px] uppercase text-slate-600">{session.activeMode}</span></SidebarMenuButton><button type="button" onClick={() => void renameSession(session)} className="hidden rounded p-1 text-slate-600 hover:bg-white/8 hover:text-white group-hover:block"><Pencil className="size-3" /></button><button type="button" onClick={() => void deleteSession(session)} className="hidden rounded p-1 text-slate-600 hover:bg-red-400/10 hover:text-red-200 group-hover:block"><Trash2 className="size-3" /></button></div></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>
        <SidebarGroup><SidebarGroupLabel className="text-slate-500">Workspace</SidebarGroupLabel><SidebarGroupContent><SidebarMenu><SidebarMenuItem><SidebarMenuButton onClick={() => setAccessOpen(true)} isActive={Boolean(accessConfig?.repositoryPath)} className="text-slate-300 hover:bg-white/7 hover:text-white"><FolderGit2 /><span>{accessConfig?.repositoryName ?? "Choose repository"}</span></SidebarMenuButton></SidebarMenuItem>{accessConfig?.documentNames.map((name) => <SidebarMenuItem key={name}><SidebarMenuButton onClick={() => setAccessOpen(true)} className="text-slate-400"><FileText /><span>{name}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu><Button variant="ghost" size="sm" onClick={() => setAccessOpen(true)} className="mt-2 w-full justify-start gap-2 text-xs text-slate-500"><Settings2 className="size-3.5" />Manage access</Button></SidebarGroupContent></SidebarGroup>
        <SidebarGroup><SidebarGroupLabel className="text-slate-500">Tools</SidebarGroupLabel><SidebarGroupContent><SidebarMenu><SidebarMenuItem><SidebarMenuButton onClick={() => setToolsOpen(true)} isActive={toolConfig?.configurationState === "available"} className="text-slate-300 hover:bg-white/7 hover:text-white"><Globe2 /><span>Internet</span><span className="ml-auto text-xs text-slate-500">{statusLabel(toolConfig)}</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu><Button variant="ghost" size="sm" onClick={() => setToolsOpen(true)} className="mt-2 w-full justify-start gap-2 text-xs text-slate-500"><Wrench className="size-3.5" />Manage tools</Button></SidebarGroupContent></SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-white/8 p-4"><div className="flex items-center gap-2 text-xs text-slate-400"><span className={`size-2 rounded-full ${serverAvailable ? "bg-[#a7ff4f] shadow-[0_0_10px_#a7ff4f]" : "bg-slate-600"}`} />{serverAvailable ? "Desktop gateway connected" : "Desktop gateway offline"}</div></SidebarFooter>
    </Sidebar>

    <SidebarInset className="min-w-0 bg-[#0d1117] text-slate-100">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/8 px-4 sm:px-6"><div className="flex min-w-0 items-center gap-3"><SidebarTrigger className="text-slate-400" /><div className="hidden min-w-0 items-center gap-2 text-sm text-slate-500 sm:flex"><span>{accessConfig?.repositoryName ?? "No repository"}</span><ChevronRight className="size-3" /><span className="truncate text-slate-200">{activeSession?.title ?? "New chat"}</span></div></div><div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={!activeTaskId} onClick={() => setReviewOpen(true)} className={`border-white/10 bg-white/4 ${blockingFindingIds.length ? "text-red-200" : "text-slate-300"}`}><ShieldAlert className="size-3.5" /><span className="hidden sm:inline">Review{blockingFindingIds.length ? ` (${blockingFindingIds.length})` : ""}</span></Button><Button size="sm" variant="outline" disabled={!activeTaskId} onClick={() => setCheckpointOpen(true)} className="border-white/10 bg-white/4 text-slate-300"><History className="size-3.5" /><span className="hidden sm:inline">Checkpoints</span></Button><Select value={activeMode} onValueChange={(value) => void changeMode(value as PermissionMode)} disabled={!activeSession || streaming}><SelectTrigger size="sm" className="border-white/10 bg-white/4 text-slate-200"><ShieldCheck className="size-3.5 text-[#a7ff4f]" /><SelectValue /></SelectTrigger><SelectContent className="border-white/10 bg-[#151a22] text-slate-100"><SelectItem value="ask">Ask</SelectItem><SelectItem value="plan">Plan</SelectItem><SelectItem value="edit">Edit</SelectItem><SelectItem value="agent">Agent</SelectItem></SelectContent></Select><div className={`hidden rounded-md border px-3 py-1.5 text-xs sm:block ${runtimeConnected ? "border-[#a7ff4f]/20 bg-[#a7ff4f]/8 text-[#a7ff4f]" : "border-white/10 bg-white/4 text-slate-400"}`}>{runtimeConnected ? `${activeSession?.model ?? "qwen3-coder:30b"} · ${activeSession?.provider ?? "ollama"}` : "Runtime not connected"}</div></div></header>

      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row"><div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-7 sm:px-10 lg:px-14"><div className="mx-auto max-w-3xl">
          <div className="mb-6 flex items-start justify-between gap-4"><div><p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#a7ff4f]">{activeTaskId ? `Task ${activeTaskId.slice(0, 8).toUpperCase()}` : "Persistent session"}</p><h1 className="mt-2 text-2xl font-semibold tracking-tight">{activeSession?.title ?? "New chat"}</h1></div><span className="rounded-full border border-white/10 bg-white/4 px-3 py-1 text-xs text-slate-400">{taskState}</span></div>
          {sessionError && <div className="mb-5 rounded-lg border border-red-400/20 bg-red-400/8 px-4 py-3 text-sm text-red-200">{sessionError}</div>}
          <div className="space-y-4">
            {visibleMessages.length ? visibleMessages.map((message) => <AssistantMessage key={message.id} message={message} />) : <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-white/10 bg-white/[0.015] p-8 text-center"><div><Bot className="mx-auto mb-3 size-7 text-slate-600" /><p className="text-sm font-medium text-slate-300">New persistent chat</p><p className="mt-1 text-sm text-slate-500">This conversation will survive restarts and stay associated with the selected mode and workspace.</p></div></div>}
            {streaming && <div role="status" aria-live="polite" className="rounded-xl border border-[#a7ff4f]/20 bg-[#a7ff4f]/5 p-4"><div className="flex items-start gap-3"><span className="mt-1.5 size-2 shrink-0 animate-pulse rounded-full bg-[#a7ff4f]" /><div><p className="text-sm font-medium text-[#d9ffb5]">{progress?.title ?? "BORG is working"}</p><p className="mt-1 text-xs leading-5 text-slate-400">{progress?.detail ?? "The proposed plan will appear here when it is ready."}</p></div></div></div>}
            {activityItems.length > 0 && <details className="rounded-lg border border-white/8 bg-white/[0.015] px-4 py-3 text-xs text-slate-500"><summary className="cursor-pointer select-none font-medium text-slate-400">Technical activity ({activityItems.length})</summary><ul className="mt-3 max-h-56 space-y-1.5 overflow-y-auto pl-4">{activityItems.map((item, index) => <li key={`${index}:${item}`} className="break-words">{item}</li>)}</ul></details>}
          </div>
        </div></div>{(previewUrl || previewError) && <div className="flex min-h-[320px] flex-1 flex-col border-t border-white/8 lg:min-h-0 lg:border-l lg:border-t-0"><div className="flex h-11 shrink-0 items-center justify-between border-b border-white/8 bg-[#0a0d12] px-3"><span className="text-xs font-medium text-slate-300">Live preview</span><div className="flex items-center gap-2"><Button size="sm" variant="ghost" onClick={() => setPreviewVersion((value) => value + 1)} disabled={!previewUrl} className="text-slate-400"><RotateCcw className="size-3.5" />Refresh</Button>{previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ExternalLink className="size-3.5" />Open</a>}</div></div>{previewUrl ? <iframe key={`${previewUrl}:${previewVersion}`} title="Website live preview" src={previewUrl} className="min-h-0 w-full flex-1 border-0 bg-white" /> : <div className="p-4 text-sm text-red-200">{previewError}</div>}</div>}</div>

        <div className="border-t border-white/8 bg-[#0a0d12]/95 p-4 sm:px-8">
          {approval && escalation && <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3"><div className="max-w-xl"><p className="text-sm font-medium text-amber-100">PLAN reached a mutation boundary</p><p className="mt-1 text-xs leading-5 text-slate-400">PLAN remains read-only. Switch this session to EDIT to create the isolated worktree and execute the proposed plan, or stay in PLAN with no mutations.</p></div><div className="flex gap-2"><Button type="button" variant="outline" disabled={approvalBusy} onClick={() => void decideEscalation("reject")} className="border-white/10 bg-transparent text-slate-300"><X className="size-4" />Stay in Plan</Button><Button type="button" disabled={approvalBusy} onClick={() => void decideEscalation("approve")} className="bg-[#a7ff4f] text-[#071007]"><Check className="size-4" />{approvalBusy ? "Switching…" : "Switch to Edit & Continue"}</Button></div></div>}
          {deliveryReady && <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-lg border border-[#a7ff4f]/20 bg-[#a7ff4f]/5 p-3"><div><p className="text-sm font-medium text-[#d9ffb5]">Verified changes ready</p><p className="mt-1 text-xs text-slate-400">Choose a delivery action for the isolated worktree.</p></div><div className="flex gap-2"><Button variant="outline" disabled={deliveryBusy} onClick={() => void deliver("export")} className="border-white/10 bg-transparent text-slate-300">Export patch</Button><Button disabled={deliveryBusy} onClick={() => void deliver("commit")} className="bg-[#a7ff4f] text-[#071007]">Commit changes</Button></div></div>}
          <form className="mx-auto flex max-w-3xl items-center gap-3" onSubmit={(event) => { event.preventDefault(); const value = request; setRequest(""); void runTask(value); }}><Input value={request} onChange={(event) => setRequest(event.target.value)} disabled={streaming || !activeSession} className="h-11 border-white/10 bg-white/4 text-base text-white placeholder:text-slate-600" placeholder={`Ask BORG in ${activeMode.toUpperCase()} mode…`} /><Button type={streaming ? "button" : "submit"} onClick={() => { if (streaming) { abortRef.current?.abort(); setStreaming(false); setTaskState("CANCELLED"); } }} className={`h-11 gap-2 px-5 ${streaming ? "bg-white/8 text-slate-200" : "bg-[#a7ff4f] text-[#071007]"}`}>{streaming ? <CircleStop className="size-4" /> : <Play className="size-4" />}{actionLabel}</Button></form>
        </div>
      </section>
    </SidebarInset>
  </SidebarProvider>;
}
