import { z } from "zod";

export const BenchmarkRunStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "BLOCKED",
  "INVALID_RUN",
]);

export const BenchmarkFailureCategorySchema = z.enum([
  "planning",
  "workflow",
  "context",
  "implementation",
  "repair",
  "verification",
  "design",
  "progression",
  "recovery",
  "completion",
]);

export const BenchmarkFailureSchema = z.object({
  code: z.string()
    .min(3)
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Failure codes must be uppercase snake case."),
  category: BenchmarkFailureCategorySchema,
  message: z.string().min(1).max(2_000),
  taskId: z.string().min(1).nullable().default(null),
  sliceId: z.string().min(1).nullable().default(null),
}).strict();

export const BenchmarkRunResultSchema = z.object({
  version: z.literal(1),
  benchmarkId: z.string().min(1),
  status: BenchmarkRunStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  failures: z.array(BenchmarkFailureSchema).max(200),
}).strict();

export type BenchmarkRunStatus = z.infer<typeof BenchmarkRunStatusSchema>;
export type BenchmarkFailureCategory = z.infer<typeof BenchmarkFailureCategorySchema>;
export type BenchmarkFailure = z.infer<typeof BenchmarkFailureSchema>;
export type BenchmarkRunResult = z.infer<typeof BenchmarkRunResultSchema>;
