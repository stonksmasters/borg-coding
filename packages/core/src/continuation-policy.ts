import type { Approval, TaskCheckpoint, TaskContinuation, TaskState } from "./contracts.ts";

export interface ContinuationDecision {
  status: TaskContinuation["status"];
  resultingState: TaskState;
  resumeAction: TaskContinuation["resumeAction"];
  detail: string;
}

export function evaluateContinuation(
  checkpoint: TaskCheckpoint,
  approvalStatus: Approval["status"] | null,
  repositoryState: TaskContinuation["repositoryState"],
  repositoryDetail = "",
): ContinuationDecision {
  const mutationStage = ["IMPLEMENTING", "VERIFYING", "REVIEWING", "DELIVERING"].includes(checkpoint.taskState);
  const invalidWorktree = checkpoint.worktreePath !== null && (repositoryState === "missing" || repositoryState === "diverged");
  const missingApproval = (checkpoint.mode === "edit" || checkpoint.mode === "agent")
    && checkpoint.taskState !== "AWAITING_APPROVAL"
    && approvalStatus !== "APPROVED";
  const staleApprovalCheckpoint = checkpoint.taskState === "AWAITING_APPROVAL"
    && (approvalStatus !== "REQUESTED" || repositoryState === "dirty");

  if (mutationStage || invalidWorktree || missingApproval || staleApprovalCheckpoint) {
    const detail = mutationStage
      ? `The checkpoint stopped during ${checkpoint.taskState}. Inspect the existing worktree and last durable event before continuing; BORG will not replay the interrupted mutation automatically. ${repositoryDetail}`.trim()
      : missingApproval
        ? "Mutation authority is no longer valid. A new approval is required."
        : staleApprovalCheckpoint
          ? "This earlier approval checkpoint cannot be continued: its approval has already been decided or its worktree contains later edits. Checkpoints do not roll back files or undo approval decisions. Start a new task to run the saved request again."
        : repositoryDetail || "The recorded worktree is no longer safe to continue.";
    return { status: "recovery_required", resultingState: "RECOVERY_REQUIRED", resumeAction: "inspect_worktree", detail };
  }

  if (checkpoint.taskState === "AWAITING_APPROVAL") {
    return { status: "ready", resultingState: "AWAITING_APPROVAL", resumeAction: "await_approval", detail: "The saved plan is ready for a new approval decision." };
  }
  if (checkpoint.taskState === "DELIVERY_READY") {
    if (!checkpoint.worktreePath) return { status: "recovery_required", resultingState: "RECOVERY_REQUIRED", resumeAction: "inspect_worktree", detail: "Delivery checkpoint has no recorded worktree." };
    return { status: "ready", resultingState: "DELIVERY_READY", resumeAction: "deliver", detail: `Verified delivery state restored. ${repositoryDetail}`.trim() };
  }
  if (checkpoint.taskState === "COMPLETE") {
    return { status: "completed", resultingState: "COMPLETE", resumeAction: "none", detail: "This checkpoint already represents a completed task." };
  }
  return { status: "ready", resultingState: "PAUSED", resumeAction: "replan", detail: "Checkpoint is ready for a fresh planning continuation." };
}
