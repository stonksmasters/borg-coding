export type MessageBlock =
  | { type: "prose"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; language: string; text: string }
  | { type: "terminal"; language: string; text: string }
  | { type: "diff"; text: string }
  | { type: "warning"; text: string }
  | { type: "status"; text: string }
  | { type: "evidence"; text: string }
  | { type: "plan"; text: string };

const terminalLanguages = new Set(["sh", "shell", "bash", "zsh", "fish", "powershell", "ps1", "cmd", "bat", "terminal", "console"]);

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function parseMessage(text: string, kind?: string): MessageBlock[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (kind === "diff") return [{ type: "diff", text: trimmed }];
  if (kind === "terminal") return [{ type: "terminal", language: "shell", text: trimmed }];
  if (kind === "warning") return [{ type: "warning", text: trimmed }];
  if (kind === "status") return [{ type: "status", text: trimmed }];
  if (kind === "evidence" || kind === "tool") return [{ type: "evidence", text: trimmed }];
  if (kind === "plan") return [{ type: "plan", text: trimmed }];

  const blocks: MessageBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  let prose: string[] = [];

  const flushProse = () => {
    const value = prose.join("\n").trim();
    if (value) blocks.push({ type: "prose", text: value });
    prose = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^```([^\s`]*)\s*$/);
    if (fence) {
      flushProse();
      const language = (fence[1] || "text").toLowerCase();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      const value = body.join("\n");
      if (language === "diff" || language === "patch") blocks.push({ type: "diff", text: value });
      else if (terminalLanguages.has(language)) blocks.push({ type: "terminal", language, text: value });
      else blocks.push({ type: "code", language, text: value });
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushProse();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushProse();
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const match = isOrdered ? lines[index].match(/^\s*\d+[.)]\s+(.+)$/) : lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushProse();
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^\s*(warning|caution|error):/i.test(line)) {
      flushProse();
      blocks.push({ type: "warning", text: line.replace(/^\s*(warning|caution|error):\s*/i, "") });
      index += 1;
      continue;
    }

    if (!line.trim()) {
      flushProse();
      index += 1;
      continue;
    }

    prose.push(line);
    index += 1;
  }
  flushProse();
  return blocks;
}
