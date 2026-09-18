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
    case "DELIVERING": return { title: "Preparing delivery", detail: "BORG is saving the verified changes." };
    default: return null;
  }
}
