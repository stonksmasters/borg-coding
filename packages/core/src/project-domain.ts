import { z } from "zod";

export const projectPhases = ["planning", "frontend", "backend", "delivery", "complete"] as const;
export const ProjectPhaseSchema = z.enum(projectPhases);
export type ProjectPhase = z.infer<typeof ProjectPhaseSchema>;

export const ProjectEntityStatusSchema = z.enum(["planned", "in_progress", "verified"]);
export type ProjectEntityStatus = z.infer<typeof ProjectEntityStatusSchema>;

export const ProjectSliceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  outcome: z.string(),
  scope: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
});
export type ProjectSlice = z.infer<typeof ProjectSliceSchema>;

export const ProjectPageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  route: z.string().startsWith("/"),
  purpose: z.string(),
  sections: z.array(z.string()),
  componentIds: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
});
export type ProjectPage = z.infer<typeof ProjectPageSchema>;

export const ProjectComponentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["layout", "section", "ui", "feature"]),
  purpose: z.string(),
  usedBy: z.array(z.string()),
  variants: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
});
export type ProjectComponent = z.infer<typeof ProjectComponentSchema>;

export const ProjectStyleSystemSchema = z.object({
  direction: z.string(),
  colors: z.array(z.string()),
  typography: z.array(z.string()),
  spacing: z.array(z.string()),
  radii: z.array(z.string()),
  shadows: z.array(z.string()),
  layoutPrinciples: z.array(z.string()),
  motion: z.array(z.string()),
  responsive: z.array(z.string()),
  accessibility: z.array(z.string()),
  avoid: z.array(z.string()),
});
export type ProjectStyleSystem = z.infer<typeof ProjectStyleSystemSchema>;

export const ProjectRequirementSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  scope: z.enum(["project", "page", "component", "style", "slice"]),
  targetId: z.string().min(1).nullable().default(null),
  acceptanceCriteria: z.array(z.string()).default([]),
});
export type ProjectRequirement = z.infer<typeof ProjectRequirementSchema>;

export const ProjectDecisionSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  rationale: z.string().default(""),
  scope: z.enum(["project", "page", "component", "style", "slice"]),
  targetId: z.string().min(1).nullable().default(null),
  createdAt: z.string().datetime(),
});
export type ProjectDecision = z.infer<typeof ProjectDecisionSchema>;

export const ProjectPlanSchema = z.object({
  version: z.literal(2),
  revision: z.number().int().positive(),
  status: z.enum(["proposed", "approved", "frontend_complete"]),
  phase: z.literal("frontend"),
  siteGoal: z.string(),
  audience: z.string(),
  // Kept for v2 persistence compatibility. sitemap is the canonical page inventory.
  pages: z.array(z.string()),
  features: z.array(z.string()),
  sitemap: z.array(ProjectPageSchema),
  components: z.array(ProjectComponentSchema),
  styles: ProjectStyleSystemSchema,
  visualDirection: z.string(),
  backendRequired: z.boolean(),
  slices: z.array(ProjectSliceSchema).min(1),
  requirements: z.array(ProjectRequirementSchema).optional(),
  decisions: z.array(ProjectDecisionSchema).optional(),
  acceptanceCriteria: z.array(z.string()),
  proposedAt: z.string().datetime(),
  approvedAt: z.string().datetime().nullable(),
});
export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;
