import { z } from "zod";

const BenchmarkIdSchema = z.string()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Benchmark id must be a lowercase kebab-case identifier.");

const RelativeMarkdownPathSchema = z.string()
  .min(1)
  .max(240)
  .refine((path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") && path.endsWith(".md"), {
    message: "promptPath must be a relative .md path without traversal or backslashes.",
  });

const RouteSchema = z.string()
  .min(1)
  .max(200)
  .refine((route) => route.startsWith("/"), {
    message: "Routes must begin with '/'.",
  });

export const FrontendBenchmarkExpectationsSchema = z.object({
  frontendOnly: z.boolean(),
  requiredRoutes: z.array(RouteSchema).min(1).max(50),
  minimumPages: z.number().int().positive().max(50),
  requireBrowserVerification: z.boolean(),
  requireResponsiveVerification: z.boolean(),
  requireAccessibilityVerification: z.boolean(),
  requireFrontendComplete: z.boolean(),
}).strict().superRefine((value, context) => {
  const uniqueRoutes = new Set(value.requiredRoutes);
  if (uniqueRoutes.size !== value.requiredRoutes.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requiredRoutes"],
      message: "requiredRoutes must not contain duplicates.",
    });
  }
  if (value.minimumPages > uniqueRoutes.size) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minimumPages"],
      message: "minimumPages cannot exceed the number of required routes.",
    });
  }
});

export const FrontendBenchmarkLimitsSchema = z.object({
  maxProjectPlanRevisions: z.number().int().min(0).max(10),
  maxRepairAttemptsPerSlice: z.number().int().min(1).max(20),
  maxContextCharacters: z.number().int().min(4_000).max(250_000),
}).strict();

export const FrontendAutonomyBenchmarkSchema = z.object({
  version: z.literal(1),
  id: BenchmarkIdSchema,
  name: z.string().min(1).max(120),
  kind: z.literal("frontend-autonomy"),
  promptPath: RelativeMarkdownPathSchema,
  expected: FrontendBenchmarkExpectationsSchema,
  limits: FrontendBenchmarkLimitsSchema,
}).strict();

export type FrontendBenchmarkExpectations = z.infer<typeof FrontendBenchmarkExpectationsSchema>;
export type FrontendBenchmarkLimits = z.infer<typeof FrontendBenchmarkLimitsSchema>;
export type FrontendAutonomyBenchmark = z.infer<typeof FrontendAutonomyBenchmarkSchema>;

export function parseFrontendAutonomyBenchmark(input: unknown): FrontendAutonomyBenchmark {
  return FrontendAutonomyBenchmarkSchema.parse(input);
}
