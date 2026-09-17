"use client";

import { AlertCircle, Bot, Globe2, User } from "lucide-react";
import { MessageBlockView, ProseBlock, ToolCallBlock } from "./message-blocks";
import { parseMessage } from "./message-parser";

export interface RenderableMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  kind?: string;
  text: string;
}

export function AssistantMessage({ message }: { message: RenderableMessage }) {
  const blocks = message.role === "assistant" || message.role === "system"
    ? parseMessage(message.text, message.kind)
    : [];
  const shell = message.role === "system"
    ? "rounded-xl border border-amber-300/12 bg-amber-300/[0.025] p-4"
    : message.role === "tool"
      ? "rounded-xl border border-sky-300/10 bg-sky-300/[0.025] p-4"
      : "py-2";
  const icon = message.role === "user" ? <User className="size-4" />
    : message.role === "assistant" ? <Bot className="size-4" />
      : message.role === "tool" ? <Globe2 className="size-4" />
        : <AlertCircle className="size-4" />;
  const iconClass = message.role === "user" ? "bg-white/8 text-slate-300"
    : message.role === "assistant" ? "bg-[#a7ff4f]/12 text-[#a7ff4f]"
      : message.role === "tool" ? "bg-sky-300/10 text-sky-200"
        : "bg-amber-300/10 text-amber-200";

  return <article className={`flex gap-3 ${shell}`}>
    <div className={`grid size-8 shrink-0 place-items-center rounded-md ${iconClass}`}>{icon}</div>
    <div className="min-w-0 flex-1">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">{message.role === "user" ? "You" : message.role === "assistant" ? "BORG" : message.role === "tool" ? "Tool" : "Runtime"}</p>
      {message.role === "user" ? <ProseBlock text={message.text} />
        : message.role === "tool" ? <ToolCallBlock text={message.text} />
          : <div className="space-y-4">{blocks.map((block, index) => <MessageBlockView key={`${message.id}:${index}`} block={block} />)}</div>}
    </div>
  </article>;
}
