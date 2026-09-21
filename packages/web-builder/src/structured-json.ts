export type JsonArtifactSource = "model" | "repaired";

export type StructuredJsonParseResult<T> = {
  value: T;
  source: JsonArtifactSource;
  repairSummary: string | null;
};

function stripMarkdownFence(value: string) {
  return value
    .trim()
    .replace(/^```(?:json|javascript|js)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function escapeRawControlCharacters(value: string) {
  let output = "";
  let inString = false;
  let escaped = false;
  let changed = false;
  for (const char of value) {
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = false;
      continue;
    }
    if (char === "\n") {
      output += "\\n";
      changed = true;
      continue;
    }
    if (char === "\r") {
      output += "\\r";
      changed = true;
      continue;
    }
    if (char === "\t") {
      output += "\\t";
      changed = true;
      continue;
    }
    output += char;
  }
  return { value: output, changed };
}

function stripCommentsAndInvalidCommas(value: string) {
  let output = "";
  let inString = false;
  let escaped = false;
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && value[index + 1] === "/") {
      changed = true;
      index += 2;
      while (index < value.length && value[index] !== "\n") index += 1;
      if (index < value.length) output += "\n";
      continue;
    }
    if (char === "/" && value[index + 1] === "*") {
      changed = true;
      index += 2;
      while (index < value.length - 1 && !(value[index] === "*" && value[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < value.length && /\s/.test(value[lookahead])) lookahead += 1;
      if (value[lookahead] === "," || value[lookahead] === "]" || value[lookahead] === "}") {
        changed = true;
        continue;
      }
    }
    output += char;
  }
  return { value: output, changed };
}

function trimAfterCompleteRoot(value: string) {
  const start = value.search(/[\[{]/);
  if (start < 0) return { value, changed: false };
  const first = value[start];
  const expectedRoot = first === "{" ? "}" : "]";
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.at(-1) === char) stack.pop();
      else return { value, changed: false };
      if (!stack.length && char === expectedRoot) {
        const suffix = value.slice(index + 1).trim();
        if (suffix || start > 0) return { value: value.slice(start, index + 1), changed: true };
        return { value, changed: false };
      }
    }
  }
  return { value, changed: false };
}

function closeOpenContainers(value: string) {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack.at(-1) === char) stack.pop();
      else return { value, changed: false };
    }
  }
  if (inString || !stack.length) return { value, changed: false };
  return { value: value + stack.reverse().join(""), changed: true };
}

function syntaxErrorPosition(message: string) {
  const match = message.match(/position\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function significantBefore(value: string, position: number) {
  let index = Math.min(position - 1, value.length - 1);
  while (index >= 0 && /\s/.test(value[index])) index -= 1;
  return index;
}

function significantAtOrAfter(value: string, position: number) {
  let index = Math.max(0, position);
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function likelyMissingComma(value: string, position: number) {
  const before = significantBefore(value, position);
  const after = significantAtOrAfter(value, position);
  if (before < 0 || after >= value.length) return false;
  const previous = value[before];
  const next = value[after];
  const previousEndsValue = previous === '"' || previous === "}" || previous === "]" || /[0-9eEln]/.test(previous);
  const nextStartsValue = next === '"' || next === "{" || next === "[" || next === "-" || /[0-9tfn]/.test(next);
  return previousEndsValue && nextStartsValue;
}

function repairFromSyntaxError(value: string, error: SyntaxError) {
  const message = error.message;
  const position = syntaxErrorPosition(message);
  if (position === null) return null;

  if (
    /Expected ',' or '[}\]]' after (?:array element|property value)/i.test(message)
    || (/Unexpected token/i.test(message) && likelyMissingComma(value, position))
  ) {
    const insertion = significantAtOrAfter(value, position);
    if (insertion < value.length && likelyMissingComma(value, insertion)) {
      return {
        value: value.slice(0, insertion) + "," + value.slice(insertion),
        action: `inserted a missing comma near JSON position ${insertion}`,
      };
    }
  }

  if (/Expected ':' after property name/i.test(message)) {
    const insertion = significantAtOrAfter(value, position);
    return {
      value: value.slice(0, insertion) + ":" + value.slice(insertion),
      action: `inserted a missing colon near JSON position ${insertion}`,
    };
  }

  return null;
}

export function parseStructuredJson<T = unknown>(input: string): StructuredJsonParseResult<T> {
  const original = input;
  let candidate = stripMarkdownFence(input);
  const actions: string[] = [];
  if (candidate !== original.trim()) actions.push("removed markdown or surrounding artifact text");

  const controls = escapeRawControlCharacters(candidate);
  candidate = controls.value;
  if (controls.changed) actions.push("escaped raw control characters inside JSON strings");

  const commas = stripCommentsAndInvalidCommas(candidate);
  candidate = commas.value;
  if (commas.changed) actions.push("removed comments, duplicate commas, or trailing commas");

  const trimmed = trimAfterCompleteRoot(candidate);
  candidate = trimmed.value;
  if (trimmed.changed) actions.push("trimmed text outside the first complete JSON root");

  const closed = closeOpenContainers(candidate);
  candidate = closed.value;
  if (closed.changed) actions.push("closed unterminated JSON containers at end of artifact");

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const value = JSON.parse(candidate) as T;
      return {
        value,
        source: actions.length ? "repaired" : "model",
        repairSummary: actions.length ? actions.join("; ") : null,
      };
    } catch (error) {
      lastError = error;
      if (!(error instanceof SyntaxError)) break;
      const repaired = repairFromSyntaxError(candidate, error);
      if (!repaired || repaired.value === candidate) break;
      candidate = repaired.value;
      actions.push(repaired.action);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown JSON parse failure");
  throw new Error(detail);
}

export function taggedJsonBody(answer: string, tag: string): string | null {
  if (!/^[a-z0-9-]+$/i.test(tag)) throw new Error("Structured artifact tag is invalid.");
  const match = answer.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

export function structuredJsonSyntaxRepairPrompt(input: {
  tag: string;
  parserError: string;
  malformedArtifact: string;
}) {
  const body = taggedJsonBody(input.malformedArtifact, input.tag) ?? input.malformedArtifact.trim();
  return [
    "STRUCTURED ARTIFACT SYNTAX REPAIR.",
    "Repair JSON syntax only. Preserve the existing product decisions, wording, arrays, ids, routes, ordering, and values unless a character-level syntax correction requires a change.",
    "Do not redesign, summarize, research, add commentary, or regenerate the artifact from scratch.",
    `Parser error: ${input.parserError}`,
    "Return exactly one corrected machine-readable block and nothing else:",
    `<${input.tag}>${body}</${input.tag}>`,
    "The content inside the marker must be strict JSON accepted by JSON.parse: double-quoted keys and strings, no comments, no trailing commas.",
  ].join("\n\n");
}
