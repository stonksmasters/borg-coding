const fabricatedImplementationClaims: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(?:i|we)\s+(?:implemented|patched|modified|changed|created|deleted|fixed|updated|refactored|rewrote|added|removed)\b/i, label: "claims completed code mutation" },
  { pattern: /\bimplementation\s+(?:is\s+)?(?:complete|completed|finished|done)\b/i, label: "claims implementation completed" },
  { pattern: /\b(?:changes|files)\s+(?:made|changed|modified|updated)\s*:/i, label: "presents a completed change report" },
  { pattern: /\b(?:tests?|test suite|build|typecheck|lint(?:ing)?|browser verification)\s+(?:all\s+)?(?:passed|succeeded|completed|ran successfully)\b/i, label: "claims verification evidence that architect mode cannot produce" },
  { pattern: /\b(?:ran|executed)\s+(?:the\s+)?(?:tests?|build|typecheck|lint|npm\s+(?:test|run\s+\w+)|browser verification)\b/i, label: "claims commands were executed during architect phase" },
  { pattern: /^#{0,3}\s*(?:implementation report|implementation summary|completed work|changes made|verification results)\b/im, label: "uses a post-implementation report heading" },
];

export interface ArchitectOutputValidation {
  valid: boolean;
  reason: string | null;
}

export function validateArchitectOutput(answer: string): ArchitectOutputValidation {
  const value = answer.trim();
  if (!value) return { valid: false, reason: "Architect returned an empty plan." };
  if (/<function=[a-zA-Z0-9_.:-]+>|<parameter=[a-zA-Z0-9_.:-]+>|<\/tool_call>/i.test(value)) {
    return { valid: false, reason: "Architect returned raw tool-call protocol instead of a plan." };
  }
  for (const claim of fabricatedImplementationClaims) {
    if (claim.pattern.test(value)) return { valid: false, reason: claim.label };
  }
  return { valid: true, reason: null };
}

export function assertArchitectOutput(answer: string): void {
  const result = validateArchitectOutput(answer);
  if (!result.valid) throw new Error(`Architect output rejected: ${result.reason}`);
}
