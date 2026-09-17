"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, Clipboard, FileCode2, TerminalSquare, TriangleAlert } from "lucide-react";
import type { MessageBlock } from "./message-parser";

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|(?:[A-Za-z]:\\|\.\.?\/)?[\w@.-]+(?:[\\/][\w@.()\[\]{} -]+)+(?::\d+(?::\d+)?)?)/g).filter(Boolean);
  return <>{parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-[0.92em] text-[#c7ff93]">{part.slice(1, -1)}</code>;
    const looksLikePath = /[\\/]/.test(part) && !/^https?:\/\//i.test(part);
    if (looksLikePath) return <span key={index} className="font-mono text-[0.92em] text-sky-200">{part}</span>;
    return <span key={index}>{part}</span>;
  })}</>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-400 hover:bg-white/10 hover:text-white">{copied ? <Check className="size-3" /> : <Clipboard className="size-3" />}{copied ? "Copied" : "Copy"}</button>;
}

const keywordSets: Record<string, Set<string>> = {
  ts: new Set(["const", "let", "var", "function", "class", "interface", "type", "export", "import", "from", "return", "if", "else", "for", "while", "async", "await", "new", "extends", "implements", "private", "public", "protected", "readonly", "throw", "try", "catch"]),
  tsx: new Set(["const", "let", "function", "class", "interface", "type", "export", "import", "from", "return", "if", "else", "async", "await", "new"]),
  js: new Set(["const", "let", "var", "function", "class", "export", "import", "from", "return", "if", "else", "for", "while", "async", "await", "new", "throw", "try", "catch"]),
  javascript: new Set(["const", "let", "var", "function", "class", "export", "import", "from", "return", "if", "else", "for", "while", "async", "await", "new", "throw", "try", "catch"]),
  python: new Set(["def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "try", "except", "finally", "with", "async", "await", "yield", "raise", "True", "False", "None"]),
  py: new Set(["def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "try", "except", "finally", "with", "async", "await", "yield", "raise", "True", "False", "None"]),
  rust: new Set(["fn", "let", "mut", "pub", "impl", "trait", "struct", "enum", "use", "mod", "match", "if", "else", "for", "while", "loop", "return", "async", "await", "move", "where"]),
  go: new Set(["func", "package", "import", "type", "struct", "interface", "var", "const", "return", "if", "else", "for", "range", "go", "defer", "select", "switch", "case"]),
  csharp: new Set(["using", "namespace", "class", "interface", "record", "public", "private", "protected", "internal", "static", "async", "await", "return", "if", "else", "foreach", "while", "new", "var", "string", "int", "bool"]),
  cs: new Set(["using", "namespace", "class", "interface", "record", "public", "private", "protected", "internal", "static", "async", "await", "return", "if", "else", "foreach", "while", "new", "var", "string", "int", "bool"]),
};

function highlightLine(line: string, language: string): ReactNode[] {
  const keywords = keywordSets[language] ?? new Set<string>();
  const tokens = line.split(/(\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b)/g);
  return tokens.map((token, index) => {
    if (!token) return null;
    if (/^(\/\/|#)/.test(token)) return <span key={index} className="text-slate-500">{token}</span>;
    if (/^("|'|`)/.test(token)) return <span key={index} className="text-amber-200">{token}</span>;
    if (/^\d/.test(token)) return <span key={index} className="text-violet-200">{token}</span>;
    if (keywords.has(token)) return <span key={index} className="text-sky-300">{token}</span>;
    return <span key={index}>{token}</span>;
  }).filter(Boolean) as ReactNode[];
}

function CodeFrame({ label, icon, text, language, terminal = false }: { label: string; icon: ReactNode; text: string; language: string; terminal?: boolean }) {
  const rendered = useMemo(() => text.split("\n").map((line, index) => <div key={index} className="min-h-[1.35rem]"><span className="mr-4 inline-block w-6 select-none text-right text-slate-700">{index + 1}</span>{terminal ? <span className="text-slate-200">{line}</span> : highlightLine(line, language)}</div>), [language, terminal, text]);
  return <div className="overflow-hidden rounded-xl border border-white/10 bg-[#070a0f] shadow-sm">
    <div className="flex items-center justify-between border-b border-white/8 bg-white/[0.025] px-3 py-2"><div className="flex items-center gap-2 text-xs text-slate-400">{icon}<span className="font-medium text-slate-300">{label}</span>{language && <span className="rounded bg-white/6 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-500">{language}</span>}</div><CopyButton text={text} /></div>
    <pre className="max-h-[34rem] overflow-auto p-4 font-mono text-[13px] leading-[1.35rem] text-slate-300"><code>{rendered}</code></pre>
  </div>;
}

export function ProseBlock({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap text-[15px] leading-7 text-slate-300"><InlineText text={text} /></p>;
}

export function CodeBlock({ text, language }: { text: string; language: string }) {
  return <CodeFrame label="Code" icon={<FileCode2 className="size-3.5" />} text={text} language={language || "text"} />;
}

export function TerminalBlock({ text, language }: { text: string; language: string }) {
  return <CodeFrame label="Terminal" icon={<TerminalSquare className="size-3.5" />} text={text} language={language || "shell"} terminal />;
}

export function DiffBlock({ text }: { text: string }) {
  return <div className="overflow-hidden rounded-xl border border-white/10 bg-[#070a0f]">
    <div className="flex items-center justify-between border-b border-white/8 px-3 py-2"><div className="flex items-center gap-2 text-xs font-medium text-slate-300"><FileCode2 className="size-3.5" />Diff</div><CopyButton text={text} /></div>
    <pre className="max-h-[34rem] overflow-auto p-3 font-mono text-[13px] leading-6">{text.split("\n").map((line, index) => <div key={index} className={`${line.startsWith("+") && !line.startsWith("+++") ? "bg-emerald-400/10 text-emerald-200" : line.startsWith("-") && !line.startsWith("---") ? "bg-red-400/10 text-red-200" : line.startsWith("@@") ? "text-sky-300" : "text-slate-400"} px-2`}>{line || " "}</div>)}</pre>
  </div>;
}

export function ToolCallBlock({ text }: { text: string }) {
  return <div className="rounded-lg border border-sky-300/12 bg-sky-300/[0.04] px-4 py-3 text-sm leading-6 text-sky-100"><InlineText text={text} /></div>;
}

export function EvidenceBlock({ text }: { text: string }) {
  return <div className="rounded-lg border border-violet-300/12 bg-violet-300/[0.035] px-4 py-3"><p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-violet-300/80">Evidence</p><ProseBlock text={text} /></div>;
}

export function PlanBlock({ text }: { text: string }) {
  return <div className="rounded-xl border border-[#a7ff4f]/15 bg-[#a7ff4f]/[0.035] px-4 py-4"><p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#a7ff4f]/80">Plan</p><ProseBlock text={text} /></div>;
}

export function WarningBlock({ text }: { text: string }) {
  return <div className="flex gap-3 rounded-lg border border-amber-300/18 bg-amber-300/[0.045] px-4 py-3 text-sm leading-6 text-amber-100"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-300" /><span><InlineText text={text} /></span></div>;
}

export function StatusBlock({ text }: { text: string }) {
  return <div className="rounded-lg border border-white/8 bg-white/[0.025] px-4 py-3 text-sm leading-6 text-slate-400"><InlineText text={text} /></div>;
}

export function MessageBlockView({ block }: { block: MessageBlock }) {
  if (block.type === "prose") return <ProseBlock text={block.text} />;
  if (block.type === "code") return <CodeBlock text={block.text} language={block.language} />;
  if (block.type === "terminal") return <TerminalBlock text={block.text} language={block.language} />;
  if (block.type === "diff") return <DiffBlock text={block.text} />;
  if (block.type === "warning") return <WarningBlock text={block.text} />;
  if (block.type === "status") return <StatusBlock text={block.text} />;
  if (block.type === "evidence") return <EvidenceBlock text={block.text} />;
  if (block.type === "plan") return <PlanBlock text={block.text} />;
  if (block.type === "heading") {
    const classes = block.level <= 2 ? "text-lg font-semibold text-slate-100" : "text-base font-semibold text-slate-200";
    return <div className={classes}><InlineText text={block.text} /></div>;
  }
  if (block.type === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return <Tag className={`${block.ordered ? "list-decimal" : "list-disc"} space-y-1.5 pl-6 text-[15px] leading-7 text-slate-300`}>{block.items.map((item, index) => <li key={index}><InlineText text={item} /></li>)}</Tag>;
  }
  return <div className="overflow-x-auto rounded-lg border border-white/8"><table className="min-w-full text-left text-sm"><thead className="bg-white/[0.035] text-slate-300"><tr>{block.headers.map((header, index) => <th key={index} className="border-b border-white/8 px-3 py-2 font-medium"><InlineText text={header} /></th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-b border-white/5 last:border-0">{block.headers.map((_, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top text-slate-400"><InlineText text={row[cellIndex] ?? ""} /></td>)}</tr>)}</tbody></table></div>;
}
