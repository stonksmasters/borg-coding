import type { ModelAdapter, ModelRequest } from "@borg/core";

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  keepAlive?: string;
}

export class OllamaModel implements ModelAdapter {
  readonly id = "ollama";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly keepAlive: string;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = options.model ?? "qwen3-coder:30b";
    this.keepAlive = options.keepAlive ?? "30m";
  }

  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async generate(request: ModelRequest, onToken?: (token: string) => void): Promise<string> {
    const messages = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      { role: "user", content: request.prompt }
    ];

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, messages, stream: true, keep_alive: this.keepAlive })
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let pending = "";
    let output = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string };
        if (chunk.error) throw new Error(chunk.error);
        const token = chunk.message?.content ?? "";
        if (!token) continue;
        output += token;
        onToken?.(token);
      }
    }

    return output;
  }
}
