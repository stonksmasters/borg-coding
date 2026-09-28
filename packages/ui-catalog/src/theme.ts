import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const ThemeContractSchema = z.object({
  version: z.literal(1),
  family: z.enum(["editorial", "conversion", "workspace"]),
  colors: z.object({ background: color, surface: color, text: color, muted: color, accent: color, onAccent: color, border: color }).strict(),
  typography: z.object({ display: z.enum(["sans", "serif", "mono"]), body: z.enum(["sans", "serif"]), baseSize: z.number().min(14).max(22) }).strict(),
  spacing: z.number().min(0.75).max(1.5),
  radius: z.number().min(0).max(32),
  contentWidth: z.number().min(640).max(1600),
  shadow: z.enum(["none", "soft", "raised"]),
}).strict();
export type ThemeContract = z.infer<typeof ThemeContractSchema>;
export const fontStacks = {
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, Consolas, monospace',
} as const;

export function defaultTheme(family: ThemeContract["family"] = "editorial"): ThemeContract {
  return ThemeContractSchema.parse({
    version: 1, family,
    colors: family === "editorial"
      ? { background: "#f5f3eb", surface: "#ffffff", text: "#1a2925", muted: "#52635c", accent: "#235747", onAccent: "#ffffff", border: "#c4cdc5" }
      : family === "conversion"
        ? { background: "#f7f7fb", surface: "#ffffff", text: "#202336", muted: "#5b6077", accent: "#4147c9", onAccent: "#ffffff", border: "#ccd0e0" }
        : { background: "#f1f4f8", surface: "#ffffff", text: "#172c43", muted: "#52667d", accent: "#145ba0", onAccent: "#ffffff", border: "#c5d0dc" },
    typography: { display: family === "editorial" ? "serif" : "sans", body: "sans", baseSize: 16 },
    spacing: 1, radius: family === "editorial" ? 4 : 12, contentWidth: 1200, shadow: "soft",
  });
}

export function themeVariables(input: ThemeContract): Record<string, string> {
  const theme = ThemeContractSchema.parse(input);
  return {
    ...Object.fromEntries(Object.entries(theme.colors).map(([key, value]) => [`--borg-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value])),
    "--borg-font-display": fontStacks[theme.typography.display], "--borg-font-body": fontStacks[theme.typography.body],
    "--borg-font-size": `${theme.typography.baseSize}px`, "--borg-space": `${theme.spacing}rem`,
    "--borg-radius": `${theme.radius}px`, "--borg-width": `${theme.contentWidth}px`,
    "--borg-shadow": theme.shadow === "none" ? "none" : theme.shadow === "soft" ? "0 8px 32px #172c430d" : "0 16px 48px #172c4326",
  };
}

export function themeStylesheet(theme: ThemeContract): string {
  return `/* Generated from .localcode/build/theme.json. */\n:root {\n${Object.entries(themeVariables(theme)).map(([key, value]) => `  ${key}: ${value};`).join("\n")}\n}\n`;
}
