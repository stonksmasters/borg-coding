import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync as writeRawFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const FRONTEND_SLICES = [
  { id: "foundation", title: "Visual foundation", goal: "Build the application shell, design system, navigation, and first useful screen with representative local data." },
  { id: "flows", title: "Core frontend flows", goal: "Complete the requested screens and interactions using local data and clear loading, empty, and error states. Do not add a database." },
  { id: "responsive", title: "Responsive layouts", goal: "Refine every frontend screen for desktop, tablet, and phone, including navigation and touch interactions." },
  { id: "accessibility", title: "Accessibility", goal: "Check keyboard use, focus, labels, contrast, semantics, and screen reader behavior across the frontend." },
  { id: "polish", title: "Frontend polish", goal: "Finish visual details, motion, performance, and browser verification. Prepare a documented data contract for a later backend session." },
] as const;

export type SliceAction = "initial" | "revise" | "advance";
export type SliceState = { version: 1; current: number; status: "working" | "awaiting_feedback" | "frontend_complete"; brief: string; lastTaskId: string | null; feedback: string[] };
export type ProjectDoc = { path: string; title: string; content: string };
const folder = ".localcode/build";
const stateFile = "state.json";

function docsDirectory(root: string) {
  const parent = join(resolve(root), ".localcode");
  const dir = join(parent, "build");
  if ([parent, dir].some((path) => existsSync(path) && !lstatSync(path).isDirectory())) throw new Error("Build docs path is not a normal directory.");
  return dir;
}
function statePath(root: string) { return join(docsDirectory(root), stateFile); }
function safeRead(path: string) { return existsSync(path) && lstatSync(path).isFile() ? readFileSync(path, "utf8") : ""; }
function writeFileSync(path: string, content: string) {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("Build doc path is not a normal file.");
  writeRawFileSync(path, content, "utf8");
}

export function readSliceState(root: string): SliceState | null {
  try {
    const value = JSON.parse(safeRead(statePath(root))) as SliceState;
    return value.version === 1 && Number.isInteger(value.current) && value.current >= 0 && Array.isArray(value.feedback) ? value : null;
  } catch { return null; }
}

export function currentSlice(state: SliceState) { return FRONTEND_SLICES[Math.min(state.current, FRONTEND_SLICES.length - 1)]; }

export function prepareSlice(root: string, brief: string, action: SliceAction, feedback: string, taskId: string, approvedPlan = ""): SliceState {
  const previous = readSliceState(root);
  if (previous?.status === "frontend_complete") throw new Error("Frontend is complete. Start a separate backend task using the documented data contract.");
  if (previous?.status === "awaiting_feedback" && action === "initial") throw new Error("Review the last slice first: approve it or request a revision.");
  if (previous && action === "advance" && previous.status !== "awaiting_feedback") throw new Error("The current slice is not ready for approval.");
  if (!previous && action !== "initial") throw new Error("No frontend slice is ready for feedback yet.");
  const next: SliceState = previous ? {
    ...previous,
    current: action === "advance" ? Math.min(previous.current + 1, FRONTEND_SLICES.length - 1) : previous.current,
    status: "working",
    lastTaskId: taskId,
    feedback: feedback.trim() ? [...previous.feedback, feedback.trim().slice(0, 4000)] : previous.feedback,
  } : { version: 1, current: 0, status: "working", brief: brief.trim(), lastTaskId: taskId, feedback: [] };
  const dir = docsDirectory(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(root), JSON.stringify(next, null, 2) + "\n");
  if (!previous) writeFileSync(join(dir, "brief.md"), `# Product brief\n\n${brief.trim()}\n`);
  writeFileSync(join(dir, "README.md"), `# Build docs\n\n- [Product brief](brief.md)\n- [Frontend plan](plan.md)\n- [Approved slice plan](current-plan.md)\n- [Progress](progress.md)\n- [Decisions and feedback](decisions.md)\n- [Data contract](data-contract.md)\n- [Session handoff](handoff.md)\n- [Completed slice history](history.md)\n- Approved plans for earlier sessions are in plans/.\n\nThese files are the durable source of truth for later sessions. Update them when implementation changes the plan.\n`);
  writeFileSync(join(dir, "plan.md"), `# Frontend slices\n\n${FRONTEND_SLICES.map((slice, index) => `${index + 1}. **${slice.title}** — ${slice.goal}`).join("\n")}\n\nDatabase and server work starts in a separate session after the frontend is reviewed.\n`);
  const planText = `# Approved plan: ${currentSlice(next).title}\n\n${approvedPlan.trim().slice(0, 30_000) || currentSlice(next).goal}\n`;
  writeFileSync(join(dir, "current-plan.md"), planText);
  if (existsSync(join(dir, "plans")) && !lstatSync(join(dir, "plans")).isDirectory()) throw new Error("Plan archive is not a normal directory.");
  mkdirSync(join(dir, "plans"), { recursive: true });
  writeFileSync(join(dir, "plans", `${currentSlice(next).id}-${taskId}.md`), planText);
  writeFileSync(join(dir, "progress.md"), `# Progress\n\nCurrent slice: **${currentSlice(next).title}** (${next.current + 1}/${FRONTEND_SLICES.length})\n\nStatus: working\n\nPrevious slices: ${next.current ? FRONTEND_SLICES.slice(0, next.current).map((slice) => slice.title).join(", ") : "none"}\n`);
  if (feedback.trim()) writeFileSync(join(dir, "decisions.md"), `${safeRead(join(dir, "decisions.md")) || "# Decisions and feedback\n"}\n## ${new Date().toISOString()} — ${action}\n\n${feedback.trim().slice(0, 4000)}\n`);
  else if (!existsSync(join(dir, "decisions.md"))) writeFileSync(join(dir, "decisions.md"), "# Decisions and feedback\n");
  if (!existsSync(join(dir, "data-contract.md"))) writeFileSync(join(dir, "data-contract.md"), "# Data contract\n\nRecord the frontend's entities, fields, state transitions, and persistence needs here as screens are built. The backend planning session will use this contract.\n");
  if (!existsSync(join(dir, "history.md"))) writeFileSync(join(dir, "history.md"), "# Completed slice history\n");
  writeFileSync(join(dir, "handoff.md"), `# Session handoff\n\nCurrent task: ${taskId}\n\nImplement only **${currentSlice(next).title}**. ${currentSlice(next).goal}\n\nRead the other build docs before editing. Record decisions, files changed, verification results, and remaining issues here. Stop after this slice and request user feedback.\n`);
  return next;
}

export function markSliceReady(root: string, taskId: string, summary: string): SliceState | null {
  const state = readSliceState(root);
  if (!state || state.lastTaskId !== taskId) return null;
  const next: SliceState = { ...state, status: state.current === FRONTEND_SLICES.length - 1 ? "frontend_complete" : "awaiting_feedback" };
  writeFileSync(statePath(root), JSON.stringify(next, null, 2) + "\n");
  const dir = docsDirectory(root);
  writeFileSync(join(dir, "progress.md"), `${safeRead(join(dir, "progress.md"))}\n## Review status\n\nCompleted slice: **${currentSlice(state).title}** (${state.current + 1}/${FRONTEND_SLICES.length})\n\nStatus: ${next.status.replaceAll("_", " ")}\n\n${summary.slice(0, 3000)}\n`);
  writeFileSync(join(dir, "handoff.md"), `${safeRead(join(dir, "handoff.md"))}\n## Verified outcome\n\n${summary.slice(0, 3000)}\n\n${next.status === "frontend_complete" ? "Frontend review is complete. Begin database planning in a new session after user feedback." : "Ask the user for feedback. In a new session, revise this slice or approve it and start the next slice."}\n`);
  writeFileSync(join(dir, "history.md"), `${safeRead(join(dir, "history.md"))}\n## ${currentSlice(state).title} — ${taskId}\n\n${summary.slice(0, 3000)}\n`);
  return next;
}

export function readProjectDocs(root: string): ProjectDoc[] {
  let dir: string;
  try { dir = docsDirectory(root); } catch { return []; }
  const names = ["README.md", "brief.md", "plan.md", "current-plan.md", "progress.md", "decisions.md", "data-contract.md", "handoff.md", "history.md"];
  if (existsSync(join(dir, "plans")) && lstatSync(join(dir, "plans")).isDirectory()) names.push(...readdirSync(join(dir, "plans")).filter((name) => name.endsWith(".md")).sort().map((name) => `plans/${name}`));
  return names.flatMap((name) => {
    const path = join(dir, name);
    return existsSync(path) ? [{ path: `${folder}/${name}`, title: name.replace(/\.md$/, "").replaceAll("-", " "), content: safeRead(path).slice(0, 100_000) }] : [];
  });
}

export function slicePrompt(state: SliceState): string {
  const slice = currentSlice(state);
  return `FRONTEND SLICE ${state.current + 1}/${FRONTEND_SLICES.length}: ${slice.title}. ${slice.goal} Read .localcode/build/README.md and the linked docs. Implement only this slice. Do not create or modify backend, API, authentication, or database code. Use local representative data where needed. Keep the change small enough to verify in this session. Update the handoff and decisions docs with evidence. Stop after verification and ask the user to review the result; the next slice belongs to a new session.`;
}
