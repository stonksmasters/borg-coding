const runningStates = new Set(["CREATED", "CLASSIFYING", "DISCOVERING", "PLANNING", "IMPLEMENTING", "VERIFYING", "REVIEWING", "DELIVERING"]);
const executionStates = new Set(["IMPLEMENTING", "VERIFYING", "REVIEWING", "DELIVERING"]);

export function taskIsRunning(state: string) { return runningStates.has(state); }
export function taskNeedsAttention(state: string) { return state === "AWAITING_APPROVAL"; }
export function executionIsRunning(state: string) { return executionStates.has(state); }

export function taskProgress(state: string): { title: string; detail: string } | null {
  switch (state) {
    case "CREATED":
    case "CLASSIFYING": return { title: "Starting the task", detail: "BORG is preparing the project and selecting the work needed." };
    case "DISCOVERING": return { title: "Reviewing the project", detail: "BORG is reading the current website before proposing changes." };
    case "PLANNING": return { title: "Preparing the design plan", detail: "The proposed design choices will appear when planning finishes." };
    case "IMPLEMENTING": return { title: "Building the approved website", detail: "BORG is working inside the isolated project copy. Changes will appear in the live preview." };
    case "VERIFYING": return { title: "Checking the website", detail: "BORG is running project and browser checks on the updated site." };
    case "REVIEWING": return { title: "Reviewing the result", detail: "BORG is checking the completed changes before presenting them." };
    case "DELIVERING": return { title: "Saving the verified slice", detail: "BORG is checkpointing the reviewed changes into the website project." };
    case "AWAITING_APPROVAL": return { title: "Waiting for approval", detail: "Review the proposed plan before BORG changes project files." };
    case "BLOCKED": return { title: "Build needs attention", detail: "A verification or review gate blocked the current slice. Open Review history, Terminal, and Docs for evidence." };
    case "FAILED": return { title: "Build stopped", detail: "The current task failed. The last confirmed changes and terminal evidence remain available for inspection." };
    case "RECOVERY_REQUIRED": return { title: "Recovery required", detail: "BORG reached a durable recovery boundary and preserved the last valid project state for a safe retry." };
    case "CANCELLED": return { title: "Task stopped", detail: "No further work is running for this task." };
    case "PAUSED": return { title: "Task paused", detail: "The task is paused with its current state preserved." };
    default: return null;
  }
}
