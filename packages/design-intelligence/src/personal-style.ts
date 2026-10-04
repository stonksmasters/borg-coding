import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const StyleArchetypeSchema = z.enum(["editorial-premium", "service-conversion", "product-operational"]);
export type StyleArchetype = z.infer<typeof StyleArchetypeSchema>;

const ConstraintSchema = z.object({
  id: z.string().min(1).max(100),
  rule: z.string().min(1).max(800),
  enforcement: z.enum(["hard", "creative-bound"]),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(12),
}).strict();

const ReferenceSchema = z.object({
  id: z.string().min(1).max(100),
  project: z.string().min(1).max(200),
  archetypes: z.array(StyleArchetypeSchema).min(1).max(3),
  qualityScore: z.number().min(0).max(100),
  role: z.enum(["primary", "supporting"]),
  sourceFiles: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1),
  evidenceFiles: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive() }).strict()).max(8),
}).strict();

const ArchetypeProfileSchema = z.object({
  id: StyleArchetypeSchema,
  description: z.string().min(1).max(1000),
  referenceIds: z.array(z.string().min(1)).min(1),
  typography: z.array(z.string().min(1).max(500)).min(2),
  composition: z.array(z.string().min(1).max(500)).min(2),
  imagery: z.array(z.string().min(1).max(500)).min(1),
  interaction: z.array(z.string().min(1).max(500)).min(1),
}).strict();

export const PersonalStyleProfileSchema = z.object({
  id: z.string().min(1).max(100),
  version: z.number().int().positive(),
  status: z.enum(["proposed", "approved", "superseded"]),
  name: z.string().min(1).max(200),
  corpusRoot: z.string().min(1),
  evidenceRoot: z.string().min(1).nullable().default(null),
  createdAt: z.string().datetime(),
  approvedAt: z.string().datetime().nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  corpusInventory: z.array(z.object({
    project: z.string().min(1).max(200),
    websiteMarkers: z.array(z.string().min(1).max(100)).max(10),
    curatedReferenceId: z.string().min(1).max(100).nullable(),
  }).strict()).min(1),
  references: z.array(ReferenceSchema).min(3),
  invariants: z.array(ConstraintSchema).min(8),
  archetypes: z.array(ArchetypeProfileSchema).length(3),
  prohibitedPatterns: z.array(z.string().min(1).max(500)).min(5),
}).strict();
export type PersonalStyleProfile = z.infer<typeof PersonalStyleProfileSchema>;

export const ResolvedStyleContractSchema = z.object({
  profileId: z.string().min(1),
  profileVersion: z.number().int().positive(),
  archetype: StyleArchetypeSchema,
  referenceIds: z.array(z.string().min(1)).min(1),
  hardConstraints: z.array(z.string().min(1)).min(5),
  creativeBounds: z.array(z.string().min(1)).min(2),
  assetRequirements: z.array(z.string().min(1)).min(1),
}).strict();
export type ResolvedStyleContract = z.infer<typeof ResolvedStyleContractSchema>;

const curatedReferences = [
  { id: "millers-glass", project: "millers-glass-website", role: "primary", qualityScore: 96, archetypes: ["editorial-premium", "service-conversion"], source: ["app/globals.css", "app/page.tsx"], evidence: ["public/og.png", "public/images/shower-hero.jpg"] },
  { id: "around-the-house", project: "AroundtheHouse", role: "primary", qualityScore: 93, archetypes: ["service-conversion"], source: ["src/app/globals.css", "src/components/Hero.jsx"], evidence: ["docs/tablet-audit-after.png", "docs/mobile-audit-after.png"] },
  { id: "shades-of-texas", project: "shadesoftx.com", role: "primary", qualityScore: 94, archetypes: ["service-conversion"], source: ["resources/views/components/sections/home/hero.blade.php", "resources/css/updated-landing-page.css"], evidence: ["build/assets/hero-1-CD8nRIRJ.jpg"] },
  { id: "tootie", project: "tootie", role: "primary", qualityScore: 91, archetypes: ["editorial-premium"], source: ["src/index.css", "src/components/Hero.jsx"], evidence: [] },
  { id: "karuta-vault", project: "karuta-vault", role: "primary", qualityScore: 92, archetypes: ["product-operational"], source: ["src/home.css", "src/HomePage.tsx"], evidence: [] },
  { id: "borg-digital", project: "borg-digital-operations", role: "primary", qualityScore: 89, archetypes: ["product-operational", "service-conversion"], source: ["app/globals.css", "components/home/HeroSection.tsx"], evidence: [] },
  { id: "audit", project: "Audit", role: "supporting", qualityScore: 86, archetypes: ["product-operational", "service-conversion"], source: ["app/globals.css", "components/reviews-embed.tsx"], evidence: ["tmp-review-widget-mobile-final.png"] },
] as const;

function inside(root: string, candidate: string) {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(".." + sep) && value !== ".." && !isAbsolute(value));
}

function safeRoot(input: string) {
  const candidate = realpathSync(resolve(input));
  if (!lstatSync(candidate).isDirectory()) throw new Error("Style corpus root must be a directory.");
  return candidate;
}

function fileRecord(root: string, path: string) {
  const candidate = resolve(root, path);
  if (!inside(root, candidate) || !existsSync(candidate)) throw new Error(`Curated style evidence is missing or outside the corpus root: ${path}`);
  const absolute = realpathSync(candidate);
  if (!inside(root, absolute) || !lstatSync(absolute).isFile()) throw new Error(`Curated style evidence is not a regular file: ${path}`);
  const bytes = readFileSync(absolute);
  return { path: relative(root, absolute).replaceAll("\\", "/"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

export function inventoryWebsiteProjects(corpusRoot: string) {
  const root = safeRoot(corpusRoot);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !["node_modules", ".git"].includes(entry.name))
    .map((entry) => {
      const projectRoot = join(root, entry.name);
      const markers = ["package.json", "composer.json", "index.html", "vite.config.js", "vite.config.ts"];
      const websiteMarkers = markers.filter((item) => existsSync(join(projectRoot, item)));
      return { project: entry.name, path: projectRoot, websiteMarkers };
    })
    .filter((item) => item.websiteMarkers.length > 0);
}

export function createPersonalStyleProposal(corpusRoot: string, now = new Date()): PersonalStyleProfile {
  const root = safeRoot(corpusRoot);
  const discoveredProjects = inventoryWebsiteProjects(root);
  const references = curatedReferences.map((item) => {
    const { source, evidence, ...identity } = item;
    const projectRoot = resolve(root, item.project);
    if (!inside(root, projectRoot) || !existsSync(projectRoot)) throw new Error(`Curated project is missing: ${item.project}`);
    const sourceFiles = source.map((path) => fileRecord(projectRoot, path)).map(({ path, sha256 }) => ({ path: `${item.project}/${path}`, sha256 }));
    const evidenceFiles = evidence.filter((path) => existsSync(resolve(projectRoot, path))).map((path) => {
      const value = fileRecord(projectRoot, path);
      return { ...value, path: `${item.project}/${value.path}` };
    });
    return { ...identity, role: item.role as "primary" | "supporting", archetypes: [...item.archetypes], sourceFiles, evidenceFiles };
  });
  const invariants = [
    { id: "single-focal-point", enforcement: "hard", rule: "Every homepage hero must establish one unmistakable focal point through scale, contrast, position, or imagery.", evidence: ["millers-glass", "around-the-house", "shades-of-texas", "tootie"] },
    { id: "display-scale", enforcement: "creative-bound", rule: "Marketing display type should normally use clamp() and reach roughly 64–120px on desktop with 0.9–1.08 line height where content length permits.", evidence: ["millers-glass", "around-the-house", "tootie"] },
    { id: "composition-variation", enforcement: "hard", rule: "At least one major section must change alignment, density, or visual weight; repeated equal card grids cannot define the page.", evidence: ["millers-glass", "around-the-house", "karuta-vault"] },
    { id: "semantic-color", enforcement: "hard", rule: "Use a high contrast neutral foundation, one primary saturated accent, and at most one supporting accent, each with a named semantic role.", evidence: ["millers-glass", "around-the-house", "shades-of-texas", "borg-digital"] },
    { id: "credible-imagery", enforcement: "hard", rule: "Prominent marketing sections require credible photography, product imagery, or authored artwork; emoji and unrelated placeholder imagery are forbidden.", evidence: ["millers-glass", "around-the-house", "shades-of-texas", "tootie", "karuta-vault"] },
    { id: "restrained-shape", enforcement: "creative-bound", rule: "Default controls use 0–8px radii; larger radii require an explicit image-framing, conversion, or product-interface purpose.", evidence: ["millers-glass", "tootie", "borg-digital", "shades-of-texas"] },
    { id: "tracked-labels", enforcement: "creative-bound", rule: "Eyebrows and metadata use compact uppercase text, strong weight, and deliberate tracking when they support hierarchy.", evidence: ["millers-glass", "around-the-house", "shades-of-texas", "tootie"] },
    { id: "purposeful-content", enforcement: "hard", rule: "Every section must serve conversion, trust, navigation, explanation, or an operational task and may not contain fabricated proof.", evidence: ["around-the-house", "shades-of-texas", "audit", "karuta-vault"] },
    { id: "restrained-motion", enforcement: "hard", rule: "Motion must explain hierarchy, reveal, state, or interaction, normally within 180–400ms, and must respect reduced motion.", evidence: ["millers-glass", "tootie", "borg-digital"] },
    { id: "mobile-art-direction", enforcement: "hard", rule: "Mobile must define its own focal crop, content priority, CTA placement, and rhythm rather than mechanically stacking desktop.", evidence: ["around-the-house", "shades-of-texas", "audit"] },
  ] as const;
  const archetypes = [
    { id: "editorial-premium", description: "Image-led premium marketing with dramatic type, restrained detail, and asymmetric editorial rhythm.", referenceIds: ["millers-glass", "tootie"], typography: ["Pair an expressive display face with a neutral body face.", "Use oversized, tightly led headlines and quiet utility labels."], composition: ["Prefer split, layered, staggered, or image-dominant heroes.", "Use borders, structured rows, and broad whitespace before adding cards."], imagery: ["Use large, credible photography or authored brand artwork as a compositional anchor."], interaction: ["Use subtle reveals and image scale changes; keep controls direct and restrained."] },
    { id: "service-conversion", description: "High-clarity local service design with forceful hierarchy, visible trust, real service imagery, and decisive actions.", referenceIds: ["around-the-house", "shades-of-texas", "millers-glass", "audit"], typography: ["Use a bold sans display hierarchy with compact tracked labels.", "Keep body copy readable and concrete with prominent phone and quote actions."], composition: ["Use split heroes, strong color bands, trust rows, and alternating proof sections.", "Keep primary and secondary actions visible without turning every element into a button."], imagery: ["Use real service, installation, or finished-work photography with intentional mobile crops."], interaction: ["Prioritize reachable CTAs, clear focus, and restrained hover lift or color changes."] },
    { id: "product-operational", description: "Dense but legible product UI with high contrast, strong state hierarchy, and visually rich domain assets.", referenceIds: ["karuta-vault", "borg-digital", "audit"], typography: ["Use a strong sans hierarchy with compact metadata and optional mono labels.", "Keep operational text dense but scannable through scale and weight."], composition: ["Build around task flows, stateful panels, and a dominant working surface.", "Use cards only when they represent real objects or operational groupings."], imagery: ["Use domain artwork, product previews, or data visualizations rather than decorative filler."], interaction: ["Make selection, loading, empty, error, and completion states visually explicit."] },
  ] satisfies z.input<typeof ArchetypeProfileSchema>[];
  const prohibitedPatterns = ["Emoji or text glyphs used as hero artwork", "Centered-everything page composition", "Three-card grids repeated as the primary page structure", "Arbitrary gradients, glow, glass, or pills without a semantic purpose", "Generic icon-title-paragraph filler", "Fabricated testimonials, ratings, logos, awards, counts, or performance claims", "Mobile layouts that only stack desktop columns", "Dead controls, lorem ipsum, or visible implementation placeholders"];
  const corpusInventory = discoveredProjects.map((item) => ({
    project: item.project,
    websiteMarkers: item.websiteMarkers,
    curatedReferenceId: references.find((reference) => reference.project === item.project)?.id ?? null,
  }));
  const fingerprintSource = JSON.stringify({ corpusInventory, references, invariants, archetypes, prohibitedPatterns });
  return PersonalStyleProfileSchema.parse({
    id: "johnb-adaptive-design-grammar", version: 1, status: "proposed", name: "John B. adaptive design grammar",
    corpusRoot: root, evidenceRoot: null, createdAt: now.toISOString(), approvedAt: null,
    fingerprint: createHash("sha256").update(fingerprintSource).digest("hex"), corpusInventory, references, invariants, archetypes, prohibitedPatterns,
  });
}

export function approvePersonalStyleProfile(profile: PersonalStyleProfile, approvedAt = new Date()) {
  return PersonalStyleProfileSchema.parse({ ...profile, status: "approved", approvedAt: approvedAt.toISOString() });
}

export function selectStyleArchetype(request: string): StyleArchetype {
  if (/\b(dashboard|admin|app|workspace|inventory|analytics|portal|editor|studio|saas|marketplace)\b/i.test(request)) return "product-operational";
  if (/\b(service|contractor|local|quote|estimate|book|appointment|repair|install|roof|glass|shade|homeowner)\b/i.test(request)) return "service-conversion";
  return "editorial-premium";
}

export function resolveStyleContract(profile: PersonalStyleProfile, request: string): ResolvedStyleContract {
  if (profile.status !== "approved") throw new Error("Personal style profile must be approved before use.");
  const archetype = selectStyleArchetype(request);
  const selected = profile.archetypes.find((item) => item.id === archetype)!;
  return ResolvedStyleContractSchema.parse({
    profileId: profile.id,
    profileVersion: profile.version,
    archetype,
    referenceIds: selected.referenceIds,
    hardConstraints: profile.invariants.filter((item) => item.enforcement === "hard").map((item) => item.rule).concat(profile.prohibitedPatterns.map((item) => `Prohibited: ${item}`)),
    creativeBounds: profile.invariants.filter((item) => item.enforcement === "creative-bound").map((item) => item.rule).concat(selected.typography, selected.composition, selected.interaction),
    assetRequirements: selected.imagery,
  });
}

export function personalStylePrompt(contract: ResolvedStyleContract) {
  return [
    "APPROVED PERSONAL STYLE CONTRACT — shared invariants are blocking requirements.",
    `Profile: ${contract.profileId} v${contract.profileVersion}`,
    `Selected archetype: ${contract.archetype}`,
    `Reference evidence: ${contract.referenceIds.join(", ")}`,
    "Hard constraints:", ...contract.hardConstraints.map((item) => `- ${item}`),
    "Creative bounds:", ...contract.creativeBounds.map((item) => `- ${item}`),
    "Asset requirements:", ...contract.assetRequirements.map((item) => `- ${item}`),
    "When the request forbids downloads or the worktree has no suitable photography, create substantial authored SVG or CSS artwork with an accessible image role and name. Decorative emoji, text glyphs, and visible placeholders do not satisfy this requirement.",
  ].join("\n");
}
