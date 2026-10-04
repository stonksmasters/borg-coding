import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PersonalStyleProfileSchema, approvePersonalStyleProfile, createPersonalStyleProposal, inventoryWebsiteProjects } from "../packages/design-intelligence/src/index.ts";
import { SqliteTaskRepository } from "../packages/persistence/src/sqlite-task-repository.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "C:\\Users\\johnb\\Code" },
    database: { type: "string", default: ".borg/borg.db" },
    approve: { type: "boolean", default: false },
  },
});

const corpusRoot = resolve(values.root!);
const databasePath = resolve(values.database!);
mkdirSync(dirname(databasePath), { recursive: true });
const repository = new SqliteTaskRepository(databasePath);
const existing = repository.listPersonalStyleProfiles()
  .map((item) => PersonalStyleProfileSchema.safeParse(item))
  .filter((item) => item.success)
  .map((item) => item.data);
const proposal = createPersonalStyleProposal(corpusRoot);
const previous = existing.find((item) => item.fingerprint === proposal.fingerprint);
const nextVersion = previous?.version ?? Math.max(0, ...existing.map((item) => item.version)) + 1;
let next = previous ?? PersonalStyleProfileSchema.parse({ ...proposal, version: nextVersion });

if (values.approve) {
  const evidenceRoot = resolve(".borg", "style-evidence", `v${next.version}`);
  for (const reference of next.references) {
    for (const evidence of reference.evidenceFiles) {
      const source = resolve(corpusRoot, evidence.path);
      const destination = resolve(evidenceRoot, evidence.path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  }
  next = next.status === "approved"
    ? PersonalStyleProfileSchema.parse({ ...next, evidenceRoot })
    : approvePersonalStyleProfile(PersonalStyleProfileSchema.parse({ ...next, evidenceRoot }));
}

if (next.status === "approved" && values.approve) repository.activatePersonalStyleProfile(next);
else repository.savePersonalStyleProfile(next);
const inventory = inventoryWebsiteProjects(corpusRoot);
repository.close();
process.stdout.write(JSON.stringify({
  status: next.status,
  profile: `${next.id}@${next.version}`,
  fingerprint: next.fingerprint,
  corpusProjects: inventory.length,
  curatedReferences: next.references.map((item) => ({ project: item.project, role: item.role, qualityScore: item.qualityScore })),
  evidenceFiles: next.references.reduce((count, item) => count + item.evidenceFiles.length, 0),
  nextAction: next.status === "approved" ? "Profile is active for new website design briefs." : "Review this proposal, then rerun with --approve.",
}, null, 2) + "\n");
