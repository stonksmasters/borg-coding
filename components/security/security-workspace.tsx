"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, CircleDot, Database, FolderKanban, Globe2, Network, Play, Plus, Radar, RefreshCw, Server, ShieldCheck, TerminalSquare, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IdentityProfilesWorkspace } from "./identity-profiles-workspace";

type NodeCapability = { id: string; status: "available" | "missing" | "error"; version: string | null };
type ExecutionNode = { id: string; name: string; host: string | null; port: number; username: string | null; platform: string | null; architecture: string | null; status: string; securityRuntime: "ssh_cli" | "kali_mcp"; mcpServerName: string | null; mcpServerVersion: string | null; mcpTools: string[]; capabilities: NodeCapability[]; lastSeenAt: string | null; lastError: string | null };
type Assessment = { id: string; projectId: string; name: string; mode: string; status: string; executionNodeId: string | null; createdAt: string; updatedAt: string };
type Scope = { allowedDomains: string[]; allowedEmails: string[]; allowedUsernames: string[]; allowedPhones: string[]; allowedUrls: string[]; allowedHosts: string[]; allowedCidrs: string[]; allowedFiles: string[]; allowedQueries: string[]; excludedDomains: string[]; excludedEmails: string[]; excludedUsernames: string[]; excludedPhones: string[]; excludedUrls: string[]; excludedHosts: string[]; excludedCidrs: string[]; excludedFiles: string[]; excludedQueries: string[]; authorizationConfirmed: boolean };
type Asset = { id: string; kind: "domain" | "ip_address" | "network" | "host" | "file" | "software" | "email" | "username" | "phone" | "profile" | "url"; key: string; displayName: string; firstSeenAt: string; lastSeenAt: string; lastExecutionId: string; lastEvidenceId: string };
type NetworkService = { id: string; assetId: string; port: number; protocol: string; state: string; name: string; product: string | null; version: string | null; lastSeenAt: string; lastEvidenceId: string };
type Relationship = { id: string; sourceAssetId: string; targetAssetId: string; kind: string; confidence: string; rationale: string; lastSeenAt: string; lastEvidenceId: string };
type Observation = { id: string; assetId: string; serviceId: string | null; executionId: string; evidenceId: string; type: string; data: Record<string, unknown>; observedAt: string };
type Execution = { id: string; operation: string; status: string; targets: Array<{ kind: string; value: string }>; startedAt: string | null; completedAt: string | null; error: string | null };
type Evidence = { id: string; executionId: string; kind: string; contentType: string; sha256: string; byteLength: number; truncated: boolean; inlineText: string | null; createdAt: string };
type InstallPlan = { nodeId: string; toolIds: string[]; aptPackages: string[]; manualTools: Array<{ toolId: string; reason: string }>; commandPreview: string[]; requiresAdministrativeApproval: true; createdAt: string };
type AssessmentDetail = { assessment: Assessment; scope: Scope; executionNode: ExecutionNode | null };
type SecurityWorkflow = { taskId: string | null; status: string; nextAction: string; security: { assessmentId: string; executionId: string | null } | null };
type View = "overview" | "scope" | "assets" | "services" | "evidence" | "activity";

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}.`);
  return body;
}

function StatusDot({ status }: { status: string }) {
  const color = status === "online" || status === "succeeded" || status === "completed" ? "bg-[#a7ff4f]" : status === "failed" || status === "error" || status === "blocked" ? "bg-red-400" : status === "running" || status === "approved" ? "bg-sky-400" : "bg-amber-300";
  return <span className={`size-2 rounded-full ${color}`} />;
}

function Metric({ label, value, icon: Icon }: { label: string; value: string | number; icon: typeof Database }) {
  return <div className="rounded-xl border border-white/8 bg-white/[0.025] p-4"><div className="flex items-center justify-between"><p className="text-xs text-slate-500">{label}</p><Icon className="size-4 text-slate-600" /></div><p className="mt-3 text-2xl font-semibold text-white">{value}</p></div>;
}

function normalizedProfileUrls(evidence: Evidence[]): string[] {
  return [...new Set(evidence.flatMap((item) => {
    if (item.kind !== "normalized" || !item.inlineText) return [];
    try {
      const value = JSON.parse(item.inlineText) as { operation?: string; profiles?: unknown };
      if (value.operation !== "public_username_search" || !Array.isArray(value.profiles)) return [];
      return value.profiles.filter((profile): profile is string =>
        typeof profile === "string"
        && /^https?:\/\//.test(profile)
        && !/[\u0000-\u001f\\]/.test(profile)
        && !profile.includes("osintsearch.org/go/sherlock")
      );
    } catch {
      return [];
    }
  }))];
}

export function SecurityWorkspace({ api }: { api: string }) {
  const [section, setSection] = useState<"profiles" | "cases" | "nodes">("profiles");
  const [view, setView] = useState<View>("overview");
  const [nodes, setNodes] = useState<ExecutionNode[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [services, setServices] = useState<NetworkService[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [projectId, setProjectId] = useState("security-local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showAssessmentForm, setShowAssessmentForm] = useState(false);
  const [showNodeForm, setShowNodeForm] = useState(false);
  const [assessmentDraft, setAssessmentDraft] = useState({ name: "", mode: "passive_recon", nodeId: "", domains: "", emails: "", usernames: "", phones: "", urls: "", hosts: "", cidrs: "", files: "", queries: "", excluded: "", confirmed: false });
  const [nodeDraft, setNodeDraft] = useState({ name: "Kali Raspberry Pi", host: "192.168.4.70", port: "22", username: "kali" });
  const [operation, setOperation] = useState("dns_lookup");
  const [target, setTarget] = useState("");
  const [pendingApproval, setPendingApproval] = useState<{ taskId: string; operation: string } | null>(null);
  const [activeWorkflow, setActiveWorkflow] = useState<SecurityWorkflow | null>(null);

  const refreshBase = useCallback(async () => {
    const [nodeResult, assessmentResult, taskResult] = await Promise.all([
      jsonRequest<{ nodes: ExecutionNode[] }>(`${api}/api/security/nodes`),
      jsonRequest<{ cases: Assessment[] }>(`${api}/api/security/cases?projectId=${encodeURIComponent(projectId)}`),
      jsonRequest<{ workflow: SecurityWorkflow | null }>(`${api}/api/tasks?projectId=${encodeURIComponent(projectId)}`),
    ]);
    setNodes(nodeResult.nodes);
    setAssessments(assessmentResult.cases);
    const workflowIsActive = taskResult.workflow?.security
      && !["complete", "failed", "blocked"].includes(taskResult.workflow.status);
    setActiveWorkflow(workflowIsActive ? taskResult.workflow : null);
    setSelectedId((current) => current ?? assessmentResult.cases[0]?.id ?? null);
  }, [api, projectId]);

  const refreshAssessment = useCallback(async (assessmentId: string) => {
    const [detailResult, assetResult, serviceResult, relationshipResult, observationResult, executionResult] = await Promise.all([
      jsonRequest<AssessmentDetail>(`${api}/api/security/assessments/${encodeURIComponent(assessmentId)}`),
      jsonRequest<{ assets: Asset[] }>(`${api}/api/security/assessments/${encodeURIComponent(assessmentId)}/assets`),
      jsonRequest<{ services: NetworkService[] }>(`${api}/api/security/assessments/${encodeURIComponent(assessmentId)}/services`),
      jsonRequest<{ relationships: Relationship[] }>(`${api}/api/security/assessments/${encodeURIComponent(assessmentId)}/relationships`),
      jsonRequest<{ observations: Observation[] }>(`${api}/api/security/assessments/${encodeURIComponent(assessmentId)}/observations`),
      jsonRequest<{ executions: Execution[] }>(`${api}/api/security/assessments/${encodeURIComponent(assessmentId)}/executions`),
    ]);
    const evidenceResults = await Promise.all(executionResult.executions.map((execution) => jsonRequest<{ evidence: Evidence[] }>(`${api}/api/security/executions/${encodeURIComponent(execution.id)}/evidence`)));
    setDetail(detailResult); setAssets(assetResult.assets); setServices(serviceResult.services);
    setRelationships(relationshipResult.relationships); setObservations(observationResult.observations);
    setExecutions(executionResult.executions); setEvidence(evidenceResults.flatMap((result) => result.evidence));
  }, [api]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshBase().catch((value) => setError(value instanceof Error ? value.message : "Unable to load security workspace.")); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshBase]);
  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setTimeout(() => { void refreshAssessment(selectedId).catch((value) => setError(value instanceof Error ? value.message : "Unable to load assessment.")); }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedId, refreshAssessment]);

  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const profileUrls = useMemo(() => normalizedProfileUrls(evidence), [evidence]);
  const selectedOwnsWorkflow = Boolean(selectedId && activeWorkflow?.security?.assessmentId === selectedId);

  async function createNode() {
    setBusy(true); setError("");
    try {
      const result = await jsonRequest<{ node: ExecutionNode }>(`${api}/api/security/nodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: nodeDraft.name, provider: "ssh", securityRuntime: "kali_mcp", host: nodeDraft.host, port: Number(nodeDraft.port), username: nodeDraft.username }) });
      setShowNodeForm(false); await refreshBase();
      await jsonRequest(`${api}/api/security/nodes/${encodeURIComponent(result.node.id)}/refresh`, { method: "POST" });
      await refreshBase();
    } catch (value) { setError(value instanceof Error ? value.message : "Unable to add node."); } finally { setBusy(false); }
  }

  async function refreshNode(id: string) {
    setBusy(true); setError("");
    try { await jsonRequest(`${api}/api/security/nodes/${encodeURIComponent(id)}/refresh`, { method: "POST" }); await refreshBase(); }
    catch (value) { setError(value instanceof Error ? value.message : "Unable to refresh node."); } finally { setBusy(false); }
  }

  async function installBaseline(id: string) {
    setBusy(true); setError("");
    try {
      const requested = ["mcp_kali_server", "dig", "nmap", "whois", "dnsrecon", "theharvester", "sherlock", "maigret", "holehe", "phoneinfoga", "whatweb", "gobuster"];
      const { plan } = await jsonRequest<{ plan: InstallPlan }>(`${api}/api/security/nodes/${encodeURIComponent(id)}/install-plan`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ toolIds: requested }),
      });
      const summary = [...plan.commandPreview, ...plan.manualTools.map((item) => `${item.toolId}: ${item.reason}`)].join("\n");
      if (!plan.aptPackages.length) {
        window.alert(summary || "The baseline packages are already installed.");
        return;
      }
      if (!window.confirm(`Run this reviewed installation plan?\n\n${summary}`)) return;
      await jsonRequest(`${api}/api/security/nodes/${encodeURIComponent(id)}/install`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true, plan }),
      });
      await refreshBase();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Unable to install the Kali baseline.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteNode(id: string) {
    setBusy(true); setError("");
    try { await jsonRequest(`${api}/api/security/nodes/${encodeURIComponent(id)}`, { method: "DELETE" }); await refreshBase(); }
    catch (value) { setError(value instanceof Error ? value.message : "Unable to remove node."); } finally { setBusy(false); }
  }

  async function createAssessment() {
    setBusy(true); setError("");
    const lines = (value: string) => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    try {
      const body = {
        projectId, name: assessmentDraft.name, mode: assessmentDraft.mode, executionNodeId: assessmentDraft.nodeId || null,
        scope: { allowedDomains: lines(assessmentDraft.domains), allowedEmails: lines(assessmentDraft.emails), allowedUsernames: lines(assessmentDraft.usernames), allowedPhones: lines(assessmentDraft.phones), allowedUrls: lines(assessmentDraft.urls), allowedHosts: lines(assessmentDraft.hosts), allowedCidrs: lines(assessmentDraft.cidrs), allowedFiles: lines(assessmentDraft.files), allowedQueries: lines(assessmentDraft.queries), excludedDomains: [], excludedEmails: [], excludedUsernames: [], excludedPhones: [], excludedUrls: [], excludedHosts: lines(assessmentDraft.excluded), excludedCidrs: [], excludedFiles: [], excludedQueries: [], authorizationConfirmed: assessmentDraft.confirmed },
      };
      const result = await jsonRequest<{ assessment: Assessment }>(`${api}/api/security/assessments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      setShowAssessmentForm(false); setSelectedId(result.assessment.id); await refreshBase();
    } catch (value) { setError(value instanceof Error ? value.message : "Unable to create assessment."); } finally { setBusy(false); }
  }

  async function startWorkflow() {
    if (!selectedId) return;
    setBusy(true); setError("");
    try { await jsonRequest(`${api}/api/security/assessments/${encodeURIComponent(selectedId)}/workflow`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }); await Promise.all([refreshAssessment(selectedId), refreshBase()]); }
    catch (value) { setError(value instanceof Error ? value.message : "Unable to start workflow."); } finally { setBusy(false); }
  }

  async function planOperation() {
    if (!selectedId || !target.trim()) return;
    setBusy(true); setError("");
    try {
      const active = ["service_inventory", "arp_scan_discovery", "fping_reachability", "ike_service_probe", "enum4linux_host_audit", "smb_anonymous_share_list", "smbmap_anonymous", "web_content_discovery", "tls_configuration", "sslscan_configuration", "ffuf_content_discovery", "dirb_content_discovery", "nikto_web_audit", "wpscan_audit", "wfuzz_content_discovery", "dnsenum_discovery", "dnsmap_discovery", "fierce_discovery"].includes(operation);
      const kind = ["public_email_search", "email_account_search"].includes(operation) ? "email"
        : ["public_username_search", "maigret_username_search"].includes(operation) ? "username"
          : operation === "phone_enrichment" ? "phone"
            : ["web_fingerprint", "waf_detection", "tls_configuration", "sslscan_configuration", "web_content_discovery", "ffuf_content_discovery", "dirb_content_discovery", "nikto_web_audit", "wpscan_audit", "wfuzz_content_discovery"].includes(operation) ? "url"
              : ["dns_lookup", "domain_recon", "whois_lookup", "amass_passive_discovery", "dmitry_domain_intel", "dnsenum_discovery", "dnsmap_discovery", "fierce_discovery"].includes(operation) ? "domain"
                : ["exiftool_metadata", "hashdeep_file_hash", "binwalk_signature_scan", "tshark_capture_analysis"].includes(operation) ? "file"
                  : operation === "searchsploit_lookup" ? "query"
                : operation === "arp_scan_discovery" || (operation === "fping_reachability" && target.includes("/")) ? "cidr"
                : active ? "host" : "domain";
      const result = await jsonRequest<{ task: { id: string }; approval?: unknown; toolPolicy?: { approvalRequirement?: string } }>(`${api}/api/security/assessments/${encodeURIComponent(selectedId)}/operations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, classification: active ? "active_recon" : "passive", targets: [{ kind, value: target.trim() }] }) });
      setPendingApproval(result.toolPolicy?.approvalRequirement === "none" ? null : { taskId: result.task.id, operation }); await Promise.all([refreshAssessment(selectedId), refreshBase()]);
    } catch (value) { setError(value instanceof Error ? value.message : "Unable to plan operation."); } finally { setBusy(false); }
  }

  async function approveOperation() {
    if (!pendingApproval || !selectedId) return;
    setBusy(true); setError("");
    try { await jsonRequest(`${api}/api/tasks/${encodeURIComponent(pendingApproval.taskId)}/approval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) }); setPendingApproval(null); await Promise.all([refreshAssessment(selectedId), refreshBase()]); }
    catch (value) { setError(value instanceof Error ? value.message : "Unable to approve operation."); } finally { setBusy(false); }
  }

  const tabs: Array<{ id: View; label: string }> = [{ id: "overview", label: "Overview" }, { id: "scope", label: "Scope" }, { id: "assets", label: "Assets" }, { id: "services", label: "Services" }, { id: "evidence", label: "Evidence" }, { id: "activity", label: "Activity" }];

  return <div className="flex h-full min-h-0 flex-col bg-[#0d1117] text-slate-100">
    <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-3 sm:px-7">
      <div><div className="flex items-center gap-2"><ShieldCheck className="size-5 text-[#a7ff4f]" /><h1 className="font-semibold">Security</h1></div><p className="mt-1 text-xs text-slate-500">Identity profiles, authorized cases, and Kali execution</p></div>
      <div className="flex items-center gap-2"><Input value={projectId} onChange={(event) => { setProjectId(event.target.value); setSelectedId(null); setDetail(null); }} aria-label="Security project ID" className="h-8 w-40 border-white/10 bg-white/4 text-xs" /><Button size="sm" variant="outline" onClick={() => void refreshBase()} className="border-white/10 bg-white/4 text-slate-300"><RefreshCw className="size-3.5" />Refresh</Button></div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="w-full shrink-0 border-b border-white/8 bg-[#0a0d12] md:w-64 md:border-b-0 md:border-r">
        <div className="grid grid-cols-3 gap-1 p-3 md:grid-cols-1"><button onClick={() => setSection("profiles")} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${section === "profiles" ? "bg-white/8 text-white" : "text-slate-500 hover:text-slate-300"}`}><Users className="size-4" />Profiles</button><button onClick={() => setSection("cases")} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${section === "cases" ? "bg-white/8 text-white" : "text-slate-500 hover:text-slate-300"}`}><FolderKanban className="size-4" />Cases</button><button onClick={() => setSection("nodes")} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${section === "nodes" ? "bg-white/8 text-white" : "text-slate-500 hover:text-slate-300"}`}><Server className="size-4" />Nodes</button></div>
        {section === "cases" && <div className="border-t border-white/8 p-3"><Button size="sm" onClick={() => { setAssessmentDraft((current) => ({ ...current, nodeId: current.nodeId || (nodes.length === 1 ? nodes[0].id : "") })); setShowAssessmentForm(true); }} className="mb-3 w-full bg-[#a7ff4f] text-[#071007]"><Plus className="size-3.5" />New case</Button><div className="space-y-1">{assessments.map((item) => <button key={item.id} onClick={() => { setSelectedId(item.id); setView("overview"); }} className={`w-full rounded-lg p-3 text-left ${selectedId === item.id ? "bg-[#a7ff4f]/8 ring-1 ring-[#a7ff4f]/20" : "hover:bg-white/4"}`}><div className="flex items-center gap-2"><StatusDot status={item.status} /><span className="truncate text-sm text-slate-200">{item.name}</span></div><p className="mt-1 pl-4 text-[10px] uppercase tracking-wide text-slate-600">{item.mode.replaceAll("_", " ")}</p></button>)}</div></div>}
      </aside>
      <main className="min-h-0 flex-1 overflow-y-auto">
        {error && <div className="m-5 rounded-lg border border-red-400/20 bg-red-400/8 px-4 py-3 text-sm text-red-200">{error}</div>}
        {section === "profiles" ? <IdentityProfilesWorkspace api={api} projectId={projectId} nodes={nodes} /> : section === "nodes" ? <div className="mx-auto max-w-6xl p-5 sm:p-7"><div className="mb-5 flex items-center justify-between"><div><h2 className="text-xl font-semibold">Execution nodes</h2><p className="mt-1 text-sm text-slate-500">Machines BORG can use for approved, typed operations.</p></div><Button disabled={busy} onClick={() => setShowNodeForm(true)} className="bg-[#a7ff4f] text-[#071007]"><Plus className="size-4" />{busy ? "Checking…" : "Add node"}</Button></div><div className="grid gap-4 lg:grid-cols-2">{nodes.map((node) => <article key={node.id} className="rounded-xl border border-white/8 bg-white/[0.02] p-5"><div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><StatusDot status={node.status} /><h3 className="font-medium">{node.name}</h3></div><p className="mt-2 font-mono text-xs text-slate-500">{node.username}@{node.host}:{node.port}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void refreshNode(node.id)} className="border-white/10 bg-white/4 text-slate-300"><RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />{busy ? "Checking…" : "Check"}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void installBaseline(node.id)} className="border-white/10 bg-white/4 text-slate-300">Install baseline</Button><Button size="icon" variant="outline" disabled={busy} aria-label={`Remove ${node.name}`} onClick={() => void deleteNode(node.id)} className="size-8 border-white/10 bg-white/4 text-slate-500 hover:text-red-300"><Trash2 className="size-3.5" /></Button></div></div><div className="mt-4 flex gap-2 text-xs text-slate-500"><span>{node.platform ?? "Unknown platform"}</span><span>·</span><span>{node.architecture ?? "Unknown architecture"}</span></div>{node.lastError && <p className="mt-3 text-xs text-red-300">{node.lastError}</p>}<div className="mt-4 flex flex-wrap gap-2">{node.capabilities.map((capability) => <span key={capability.id} title={capability.version ?? capability.status} className={`rounded-full border px-2 py-1 text-[10px] ${capability.status === "available" ? "border-[#a7ff4f]/20 bg-[#a7ff4f]/5 text-[#d9ffb5]" : "border-white/8 text-slate-600"}`}>{capability.id}</span>)}</div></article>)}</div></div>
        : detail ? <div><div className="border-b border-white/8 px-5 pt-5 sm:px-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><StatusDot status={detail.assessment.status} /><h2 className="text-xl font-semibold">{detail.assessment.name}</h2></div><p className="mt-2 text-sm text-slate-500">{detail.assessment.mode.replaceAll("_", " ")} · {detail.executionNode?.name ?? "No execution node"}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || selectedOwnsWorkflow || Boolean(activeWorkflow) || detail.assessment.status === "completed"} onClick={() => void startWorkflow()} className="border-white/10 bg-white/4 text-slate-300"><Play className="size-3.5" />{selectedOwnsWorkflow ? "Workflow active" : activeWorkflow ? "Another assessment is active" : detail.assessment.status === "completed" ? "Completed" : "Start workflow"}</Button></div></div><nav className="mt-5 flex gap-1 overflow-x-auto">{tabs.map((tab) => <button key={tab.id} onClick={() => setView(tab.id)} className={`shrink-0 border-b-2 px-3 py-2 text-xs ${view === tab.id ? "border-[#a7ff4f] text-white" : "border-transparent text-slate-500 hover:text-slate-300"}`}>{tab.label}</button>)}</nav></div>
          <div className="mx-auto max-w-6xl p-5 sm:p-7">
            {view === "overview" && <div className="space-y-6">{selectedOwnsWorkflow && activeWorkflow?.nextAction === "plan" && <div className="rounded-lg border border-[#a7ff4f]/20 bg-[#a7ff4f]/5 p-4 text-sm text-[#d9ffb5]">Workflow started. Choose an operation below, enter the authorized target, then select Review operation.</div>}<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Assets" value={assets.length} icon={Globe2} /><Metric label="Services" value={services.length} icon={Network} /><Metric label="Observations" value={observations.length} icon={Database} /><Metric label="Executions" value={executions.length} icon={TerminalSquare} /></div>{profileUrls.length > 0 && <section className="rounded-xl border border-[#a7ff4f]/20 bg-[#a7ff4f]/5 p-5"><h3 className="font-medium text-[#d9ffb5]">Public profile candidates</h3><p className="mt-1 text-xs text-slate-500">Username matches found by Sherlock. Open each profile to verify that it belongs to the intended person.</p><div className="mt-4 grid gap-2">{profileUrls.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer" className="rounded-lg border border-white/8 bg-black/15 px-3 py-2 font-mono text-xs text-sky-300 hover:border-sky-300/30 hover:text-sky-200">{url}</a>)}</div></section>}{activeWorkflow && !selectedOwnsWorkflow && <div className="rounded-lg border border-amber-300/20 bg-amber-300/5 p-4 text-sm text-amber-100">Another assessment owns this project&apos;s active workflow. Finish it before starting this draft.</div>}<section className="rounded-xl border border-white/8 bg-white/[0.02] p-5"><h3 className="font-medium">Plan an operation</h3><p className="mt-1 text-xs text-slate-500">Select a typed operation for an authorized target. Active checks remain behind explicit approval.</p><div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr_auto]"><select value={operation} onChange={(event) => setOperation(event.target.value)} className="h-9 rounded-md border border-white/10 bg-[#11161e] px-3 text-sm"><option value="dns_lookup">DNS lookup</option><option value="domain_recon">Domain recon</option><option value="whois_lookup">Whois lookup</option><option value="amass_passive_discovery">Amass passive discovery</option><option value="dmitry_domain_intel">DMitry domain intelligence</option><option value="dnsenum_discovery">DNSenum discovery</option><option value="dnsmap_discovery">DNSmap discovery</option><option value="fierce_discovery">Fierce DNS discovery</option><option value="public_email_search">Public email references</option><option value="email_account_search">Email account clues</option><option value="public_username_search">Sherlock username search</option><option value="maigret_username_search">Maigret username search</option><option value="phone_enrichment">Phone validation</option><option value="web_fingerprint">Web fingerprint</option><option value="waf_detection">WAF detection</option><option value="tls_configuration">SSLyze TLS configuration</option><option value="sslscan_configuration">sslscan TLS analysis</option><option value="web_content_discovery">Gobuster content discovery</option><option value="ffuf_content_discovery">FFUF content discovery</option><option value="dirb_content_discovery">DIRB content discovery</option><option value="nikto_web_audit">Nikto web audit</option><option value="wpscan_audit">WordPress audit</option><option value="wfuzz_content_discovery">Wfuzz content discovery</option><option value="service_inventory">Nmap service inventory</option><option value="arp_scan_discovery">ARP network discovery</option><option value="fping_reachability">Reachability discovery</option><option value="ike_service_probe">IKE service probe</option><option value="enum4linux_host_audit">Windows and SMB host audit</option><option value="smb_anonymous_share_list">Anonymous SMB share list</option><option value="smbmap_anonymous">Anonymous SMB permission map</option><option value="exiftool_metadata">File metadata</option><option value="hashdeep_file_hash">SHA-256 file hash</option><option value="tshark_capture_analysis">Packet capture analysis</option><option value="searchsploit_lookup">Exploit-DB reference lookup</option></select><Input value={target} onChange={(event) => setTarget(event.target.value)} placeholder={["dns_lookup", "domain_recon", "whois_lookup", "amass_passive_discovery", "dmitry_domain_intel", "dnsenum_discovery", "dnsmap_discovery", "fierce_discovery"].includes(operation) ? "example.com" : operation === "arp_scan_discovery" ? "192.168.4.0/24" : ["service_inventory", "fping_reachability", "ike_service_probe", "enum4linux_host_audit", "smb_anonymous_share_list", "smbmap_anonymous"].includes(operation) ? "192.168.4.96" : ["exiftool_metadata", "hashdeep_file_hash", "binwalk_signature_scan", "tshark_capture_analysis"].includes(operation) ? "/home/kali/evidence/sample.bin" : operation === "searchsploit_lookup" ? "product version or CVE" : "https://example.com"} className="border-white/10 bg-white/4" /><Button disabled={busy || !target.trim() || !selectedOwnsWorkflow} onClick={() => void planOperation()} className="bg-[#a7ff4f] text-[#071007]">Review operation</Button></div>{pendingApproval && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-4"><div><p className="text-sm text-amber-100">Approval required</p><p className="mt-1 text-xs text-slate-500">{pendingApproval.operation.replaceAll("_", " ")} passed scope policy and is ready to run.</p></div><Button disabled={busy} onClick={() => void approveOperation()} className="bg-amber-300 text-[#171005]"><Check className="size-4" />Approve and run</Button></div>}</section><section className="rounded-xl border border-white/8 bg-white/[0.02] p-5"><h3 className="font-medium">Recent execution</h3>{executions[0] ? <div className="mt-4 flex items-center justify-between gap-4"><div className="flex items-center gap-3"><StatusDot status={executions[0].status} /><div><p className="text-sm text-slate-200">{executions[0].operation.replaceAll("_", " ")}</p><p className="text-xs text-slate-600">{executions[0].targets.map((item) => item.value).join(", ")}</p></div></div><span className="text-xs capitalize text-slate-500">{executions[0].status}</span></div> : <p className="mt-4 text-sm text-slate-600">No operations have run yet.</p>}</section></div>}
            {view === "scope" && <div className="grid gap-4 lg:grid-cols-2"><section className="rounded-xl border border-white/8 bg-white/[0.02] p-5"><h3 className="font-medium">Allowed targets</h3><div className="mt-4 space-y-4">{[["Domains", detail.scope.allowedDomains], ["Emails", detail.scope.allowedEmails], ["Usernames", detail.scope.allowedUsernames], ["Phones", detail.scope.allowedPhones], ["URLs", detail.scope.allowedUrls], ["Hosts", detail.scope.allowedHosts], ["Networks", detail.scope.allowedCidrs], ["Remote files", detail.scope.allowedFiles], ["Software queries", detail.scope.allowedQueries]].map(([label, values]) => <div key={label as string}><p className="text-xs text-slate-500">{label as string}</p><div className="mt-2 flex flex-wrap gap-2">{(values as string[]).map((value) => <span key={value} className="rounded-md border border-[#a7ff4f]/15 bg-[#a7ff4f]/5 px-2 py-1 font-mono text-xs text-[#d9ffb5]">{value}</span>)}{!(values as string[]).length && <span className="text-xs text-slate-700">None</span>}</div></div>)}</div></section><section className="rounded-xl border border-white/8 bg-white/[0.02] p-5"><h3 className="font-medium">Authorization</h3><div className="mt-4 flex items-center gap-3"><div className={`grid size-9 place-items-center rounded-full ${detail.scope.authorizationConfirmed ? "bg-[#a7ff4f]/10 text-[#a7ff4f]" : "bg-amber-300/10 text-amber-300"}`}>{detail.scope.authorizationConfirmed ? <Check className="size-5" /> : <CircleDot className="size-5" />}</div><div><p className="text-sm text-slate-200">{detail.scope.authorizationConfirmed ? "Authorization confirmed" : "Passive operations only"}</p><p className="mt-1 text-xs text-slate-500">Active reconnaissance remains blocked unless authorization is confirmed.</p></div></div></section></div>}
            {view === "assets" && <div className="space-y-3">{assets.map((asset) => <article key={asset.id} className="rounded-xl border border-white/8 bg-white/[0.02] p-4"><div className="flex items-center justify-between gap-4"><div className="flex items-center gap-3"><div className="grid size-9 place-items-center rounded-lg bg-white/5"><Globe2 className="size-4 text-[#a7ff4f]" /></div><div><p className="font-mono text-sm text-slate-200">{asset.displayName}</p><p className="mt-1 text-[10px] uppercase tracking-wide text-slate-600">{asset.kind.replaceAll("_", " ")}</p></div></div><ChevronRight className="size-4 text-slate-700" /></div><div className="mt-3 flex flex-wrap gap-3 border-t border-white/6 pt-3 text-[10px] text-slate-600"><span>Last observed {new Date(asset.lastSeenAt).toLocaleString()}</span><span>Evidence {asset.lastEvidenceId.slice(-8)}</span></div>{relationships.filter((item) => item.sourceAssetId === asset.id || item.targetAssetId === asset.id).map((item) => <p key={item.id} className="mt-2 text-xs text-slate-500">{assetById.get(item.sourceAssetId)?.displayName} <span className="text-[#a7ff4f]">{item.kind.replaceAll("_", " ")}</span> {assetById.get(item.targetAssetId)?.displayName}</p>)}</article>)}{!assets.length && <p className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-600">Run an operation to discover assets.</p>}</div>}
            {view === "services" && <div className="overflow-hidden rounded-xl border border-white/8"><table className="w-full text-left text-sm"><thead className="bg-white/[0.025] text-xs text-slate-500"><tr><th className="px-4 py-3">Asset</th><th className="px-4 py-3">Port</th><th className="px-4 py-3">Service</th><th className="px-4 py-3">Product</th><th className="px-4 py-3">State</th></tr></thead><tbody className="divide-y divide-white/6">{services.map((service) => <tr key={service.id}><td className="px-4 py-3 font-mono text-slate-300">{assetById.get(service.assetId)?.displayName ?? service.assetId}</td><td className="px-4 py-3 text-[#a7ff4f]">{service.port}/{service.protocol}</td><td className="px-4 py-3 text-slate-300">{service.name}</td><td className="px-4 py-3 text-slate-500">{[service.product, service.version].filter(Boolean).join(" ") || "—"}</td><td className="px-4 py-3"><span className="rounded-full bg-[#a7ff4f]/8 px-2 py-1 text-xs text-[#d9ffb5]">{service.state}</span></td></tr>)}</tbody></table>{!services.length && <p className="p-8 text-center text-sm text-slate-600">No services discovered.</p>}</div>}
            {view === "evidence" && <div className="space-y-3">{evidence.map((item) => <details key={item.id} className="rounded-xl border border-white/8 bg-white/[0.02] p-4"><summary className="cursor-pointer list-none"><div className="flex items-center justify-between gap-4"><div><p className="text-sm capitalize text-slate-200">{item.kind} evidence</p><p className="mt-1 font-mono text-[10px] text-slate-600">SHA-256 {item.sha256}</p></div><span className="text-xs text-slate-600">{item.byteLength} bytes</span></div></summary><pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/25 p-3 text-[11px] text-slate-400">{item.inlineText || "Empty output"}</pre></details>)}{!evidence.length && <p className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-600">No evidence recorded.</p>}</div>}
            {view === "activity" && <div className="space-y-3">{executions.map((execution) => <article key={execution.id} className="flex gap-3 rounded-xl border border-white/8 bg-white/[0.02] p-4"><div className="mt-1"><StatusDot status={execution.status} /></div><div><p className="text-sm text-slate-200">{execution.status === "succeeded" ? "Completed" : execution.status === "failed" ? "Failed" : "Processing"} {execution.operation.replaceAll("_", " ")}</p><p className="mt-1 text-xs text-slate-500">Target: {execution.targets.map((item) => item.value).join(", ")}</p><p className="mt-2 text-[10px] text-slate-700">{execution.completedAt ? new Date(execution.completedAt).toLocaleString() : execution.startedAt ? new Date(execution.startedAt).toLocaleString() : "Awaiting execution"}</p>{execution.error && <p className="mt-2 text-xs text-red-300">{execution.error}</p>}</div></article>)}</div>}
          </div></div> : <div className="grid h-full place-items-center p-8 text-center"><div><Radar className="mx-auto size-8 text-slate-700" /><p className="mt-3 text-sm text-slate-400">Create an assessment to begin.</p></div></div>}
      </main>
    </div>
    {showNodeForm && <div className="absolute inset-0 z-50 grid place-items-center bg-black/70 p-4"><div className="w-full max-w-md rounded-xl border border-white/10 bg-[#11161e] p-5"><h2 className="font-semibold">Add SSH node</h2><div className="mt-4 space-y-3"><Input value={nodeDraft.name} onChange={(e) => setNodeDraft({ ...nodeDraft, name: e.target.value })} placeholder="Node name" className="border-white/10 bg-white/4" /><Input value={nodeDraft.host} onChange={(e) => setNodeDraft({ ...nodeDraft, host: e.target.value })} placeholder="Host or IP" className="border-white/10 bg-white/4" /><div className="grid grid-cols-2 gap-3"><Input value={nodeDraft.username} onChange={(e) => setNodeDraft({ ...nodeDraft, username: e.target.value })} placeholder="Username" className="border-white/10 bg-white/4" /><Input value={nodeDraft.port} onChange={(e) => setNodeDraft({ ...nodeDraft, port: e.target.value })} placeholder="Port" className="border-white/10 bg-white/4" /></div></div><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setShowNodeForm(false)} className="border-white/10 bg-transparent text-slate-300">Cancel</Button><Button disabled={busy} onClick={() => void createNode()} className="bg-[#a7ff4f] text-[#071007]">Add and check</Button></div></div></div>}
    {showAssessmentForm && <div className="absolute inset-0 z-50 grid place-items-center overflow-y-auto bg-black/70 p-4"><div className="w-full max-w-xl rounded-xl border border-white/10 bg-[#11161e] p-5"><h2 className="font-semibold">New security assessment</h2><div className="mt-4 space-y-3"><Input value={assessmentDraft.name} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, name: e.target.value })} placeholder="Assessment name" className="border-white/10 bg-white/4" /><div className="grid grid-cols-2 gap-3"><select value={assessmentDraft.mode} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, mode: e.target.value })} className="h-9 rounded-md border border-white/10 bg-[#11161e] px-3 text-sm"><option value="passive_recon">Passive recon</option><option value="active_recon">Active recon</option><option value="authorized_assessment">Authorized assessment</option><option value="osint">OSINT</option></select><select value={assessmentDraft.nodeId} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, nodeId: e.target.value })} className="h-9 rounded-md border border-white/10 bg-[#11161e] px-3 text-sm"><option value="">Select node</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></div><Input value={assessmentDraft.domains} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, domains: e.target.value })} placeholder="Allowed domains, comma separated" className="border-white/10 bg-white/4" /><Input value={assessmentDraft.emails} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, emails: e.target.value })} placeholder="Allowed email addresses" className="border-white/10 bg-white/4" /><Input value={assessmentDraft.usernames} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, usernames: e.target.value })} placeholder="Allowed usernames" className="border-white/10 bg-white/4" /><Input value={assessmentDraft.phones} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, phones: e.target.value })} placeholder="Allowed phone numbers" className="border-white/10 bg-white/4" /><Input value={assessmentDraft.urls} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, urls: e.target.value })} placeholder="Allowed URLs" className="border-white/10 bg-white/4" /><Input value={assessmentDraft.hosts} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, hosts: e.target.value })} placeholder="Allowed hosts" className="border-white/10 bg-white/4" /><Input value={assessmentDraft.cidrs} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, cidrs: e.target.value })} placeholder="Allowed networks, e.g. 192.168.4.0/24" className="border-white/10 bg-white/4" /><Input value={assessmentDraft.files} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, files: e.target.value })} placeholder="Allowed files on Kali, e.g. /home/kali/evidence/sample.bin" className="border-white/10 bg-white/4" /><Input value={assessmentDraft.queries} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, queries: e.target.value })} placeholder="Allowed software or CVE queries" className="border-white/10 bg-white/4" /><Input value={assessmentDraft.excluded} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, excluded: e.target.value })} placeholder="Excluded hosts" className="border-white/10 bg-white/4" /><label className="flex items-start gap-3 rounded-lg border border-white/8 p-3 text-xs text-slate-400"><input type="checkbox" checked={assessmentDraft.confirmed} onChange={(e) => setAssessmentDraft({ ...assessmentDraft, confirmed: e.target.checked })} className="mt-0.5" /><span>I confirm that I am authorized to actively assess the targets listed in this scope.</span></label></div><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setShowAssessmentForm(false)} className="border-white/10 bg-transparent text-slate-300">Cancel</Button>{(!assessmentDraft.name || !assessmentDraft.nodeId) && <p className="mr-auto text-xs text-amber-300">{!assessmentDraft.name ? "Enter an assessment name." : "Select an execution node."}</p>}<Button disabled={busy || !assessmentDraft.name || !assessmentDraft.nodeId} onClick={() => void createAssessment()} className="bg-[#a7ff4f] text-[#071007]">Create assessment</Button></div></div></div>}
  </div>;
}




