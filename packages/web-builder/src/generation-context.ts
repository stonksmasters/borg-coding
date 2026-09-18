import type { WebsiteTemplate } from "./project-bootstrap.ts";

export type WebsiteWorkflowKind = "initial_generation" | "iterative_edit";

export type WebsiteGenerationProject = {
  name: string;
  template: WebsiteTemplate;
  originalBrief: string | null;
};

const templateGoals: Record<WebsiteTemplate, string[]> = {
  "saas-landing": [
    "Lead with a decisive product value proposition and one primary conversion path.",
    "Use product proof, feature storytelling, pricing or plan context when requested, and a credible final CTA.",
  ],
  portfolio: [
    "Make the creator's identity and strongest work immediately legible.",
    "Prioritize selected work, role/context, process or capabilities, and a clear contact path.",
  ],
  ecommerce: [
    "Prioritize merchandise discovery, product hierarchy, collection navigation, and confident purchase paths.",
    "Use realistic product placeholders without inventing ratings, customer counts, or testimonials.",
  ],
  dashboard: [
    "Treat this as an application workspace rather than a marketing landing page.",
    "Use clear navigation, dense-but-readable information hierarchy, purposeful empty states, and responsive operational workflows.",
  ],
  waitlist: [
    "Keep the conversion path focused: proposition, trust-building product explanation, and a strong signup experience.",
    "If signup persistence is requested, use the supported local API and SQLite pattern rather than fake submission behavior.",
  ],
};

export function websiteGenerationContext(project: WebsiteGenerationProject, workflow: WebsiteWorkflowKind): string {
  const workflowRules = workflow === "initial_generation"
    ? [
        "This is the first AI generation for this website. Replace the bootstrap canvas with a complete, cohesive first version rather than lightly restyling the starter.",
        "Establish reusable design tokens and components before repeating one-off section styles.",
        "Deliver a complete page experience with intentional navigation, hero, meaningful content structure, calls to action, footer, responsive behavior, and useful states appropriate to the brief.",
      ]
    : [
        "This is a follow-up edit to an existing generated website. Inspect the current implementation before changing it.",
        "Preserve working behavior, established visual language, reusable components, and content that the request does not ask to change.",
        "Make the smallest coherent change that fully satisfies the request, then re-run browser verification.",
      ];

  return [
    "BORG WEBSITE BUILDER CONTRACT",
    `Website: ${project.name}`,
    `Template starting point: ${project.template}`,
    project.originalBrief ? `Original website brief: ${project.originalBrief}` : "Original website brief: not recorded",
    `Workflow: ${workflow}`,
    "",
    "Constrained MVP stack: React + Vite + TypeScript + Tailwind/CSS, npm, the bundled local API middleware, and SQLite when persistence is required. Do not replace the framework, package manager, database, or local preview architecture unless the user explicitly asks.",
    "Supported full-stack primitives include static pages, forms, local API endpoints, SQLite-backed CRUD, seed data, basic dashboards, and local-only auth placeholders. Prefer these proven local patterns over introducing a new server framework.",
    "Avoid unnecessary dependencies. Reuse existing components and design tokens. Keep frontend and backend contracts consistent.",
    "Never leave fake buttons, dead controls, TODO placeholders, lorem ipsum, fabricated social proof, or claims unsupported by the implementation.",
    ...templateGoals[project.template],
    ...workflowRules,
  ].join("\n");
}
