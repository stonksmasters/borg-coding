import { cpus, platform, release, totalmem, arch } from "node:os";

export async function captureBenchmarkEnvironment(ollamaUrl = "http://127.0.0.1:11434", model = "qwen3-coder:30b") {
  const url = new URL(ollamaUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Benchmark environment discovery requires a local Ollama URL without credentials.");
  }
  const read = async (path: string, body?: object): Promise<Record<string, unknown> | null> => {
    try {
      const response = await fetch(new URL(path, url), { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
      return response.ok ? await response.json() as Record<string, unknown> : null;
    } catch { return null; }
  };
  const [shown, loaded] = await Promise.all([read("/api/show", { model }), read("/api/ps")]);
  const running = Array.isArray(loaded?.models) ? loaded.models as Array<Record<string, unknown>> : null;
  const resident = running?.find((item) => item.name === model || item.model === model);
  return {
    capturedAt: new Date().toISOString(),
    hardware: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length, memoryBytes: totalmem() },
    node: process.version,
    model,
    modelDetails: shown?.details ?? null,
    modelCapabilities: shown?.capabilities ?? null,
    modelParameters: shown?.parameters ?? null,
    modelDigest: resident?.digest ?? null,
    residentContextLength: resident?.context_length ?? null,
    residentVramBytes: resident?.size_vram ?? null,
    initialLoadState: running === null ? "unknown" : resident ? "warm" : "cold",
  };
}
