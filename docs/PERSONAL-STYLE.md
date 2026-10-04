# Personal website style profile

BORG keeps an approved, local design grammar derived from the operator's authored website corpus. Source websites are read only. The active profile is stored in SQLite; bounded visual evidence is copied under `.borg/style-evidence/`.

## Refresh workflow

```powershell
npm run style:scan
```

This inventories website projects under `C:\Users\johnb\Code`, hashes curated source evidence, and saves a proposed profile without activating it.

After reviewing the printed reference list and fingerprint:

```powershell
npm run style:approve
```

Approval copies the bounded evidence set, activates that profile version, and supersedes the prior approved version. Use `npm run style:scan -- --root <path> --database <path>` when selecting another corpus or BORG database.

## Runtime behavior

New website design briefs select one adaptive archetype: editorial premium, service conversion, or product operational. Shared hierarchy, imagery, composition, content, motion, and mobile rules become blocking requirements. Archetype typography and composition remain bounded creative direction. The resolved contract is persisted with the project in `.localcode/build/design-profile.json` and is inherited by implementation and visual review.
