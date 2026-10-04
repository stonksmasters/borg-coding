export function splitNdjsonBuffer(buffer: string, done: boolean): { lines: string[]; remainder: string } {
  const lines = buffer.split("\n");
  if (done) return { lines, remainder: "" };
  return { lines: lines.slice(0, -1), remainder: lines.at(-1) ?? "" };
}
