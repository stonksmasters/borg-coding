import { z } from "zod";

export const ContextScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page"), id: z.string().min(1) }),
  z.object({ type: z.literal("component"), id: z.string().min(1) }),
  z.object({ type: z.literal("styles"), id: z.literal("global") }),
]);

export const ContextProfileSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["slice", "page", "component", "styles"]),
  id: z.string().min(1),
  phase: z.literal("frontend"),
  planRevision: z.number().int().positive(),
  workflowVersion: z.number().int().positive().nullable(),
  sliceIndex: z.number().int().nonnegative().nullable(),
  sliceId: z.string().min(1).nullable(),
  scope: ContextScopeSchema.nullable(),
});

export const ContextManifestItemSchema = z.object({
  kind: z.enum(["contract", "authority", "projection", "registry", "source"]),
  path: z.string().min(1),
  reason: z.string().min(1),
  characters: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  required: z.boolean(),
});

export const ContextPackSchema = z.object({
  version: z.literal(1),
  profile: ContextProfileSchema,
  authority: z.enum(["workflow", "legacy_projection"]),
  sliceId: z.string().min(1),
  text: z.string(),
  manifest: z.array(ContextManifestItemSchema),
  characters: z.number().int().nonnegative(),
  budgetCharacters: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ContextPackRecordSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  pack: ContextPackSchema,
  createdAt: z.string().datetime(),
});

export type ContextScope = z.infer<typeof ContextScopeSchema>;
export type ContextProfile = z.infer<typeof ContextProfileSchema>;
export type ContextManifestItem = z.infer<typeof ContextManifestItemSchema>;
export type ContextPack = z.infer<typeof ContextPackSchema>;
export type ContextPackRecord = z.infer<typeof ContextPackRecordSchema>;
