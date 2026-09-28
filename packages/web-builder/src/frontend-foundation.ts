import { catalogFiles, selectCatalog } from "../../ui-catalog/src/index.ts";
import { defaultTheme, themeStylesheet } from "../../ui-catalog/src/theme.ts";
import type { WebsiteTemplate } from "./project-bootstrap.ts";

/** Returns inspectable files; callers own all filesystem side effects. */
export function frontendFoundationFiles(template: WebsiteTemplate): Record<string, string> {
  const family = template === "dashboard" ? "workspace" : template === "ecommerce" || template === "saas-landing" || template === "waitlist" ? "conversion" : "editorial";
  // Marketing uses editorial composition even with a conversion-oriented token family.
  const pattern = template === "ecommerce" ? "commerce" : template === "dashboard" ? "workspace" : "editorial";
  const items = selectCatalog(pattern === "commerce" ? "conversion" : pattern);
  const theme = defaultTheme(family);
  const component = pattern === "commerce" ? "CommercePage" : pattern === "workspace" ? "WorkspacePage" : "EditorialPage";
  return {
    ...catalogFiles(items),
    ".localcode/build/theme.json": JSON.stringify(theme, null, 2) + "\n",
    ".localcode/build/catalog.json": JSON.stringify({ version: 1, selections: items.map(({ id, version, provenance, evidence }) => ({ id, version, provenance, evidence })), assets: [{ id: "system-fonts", source: "operating-system", distribution: "not-bundled" }], reviewStatus: "pending" }, null, 2) + "\n",
    "src/borg/theme.css": themeStylesheet(theme),
    "src/style.css": '@import "./borg/theme.css";\n@import "./borg/foundation.css";\n',
    "src/App.tsx": `import { ${component} } from "./borg/${pattern}";\nexport default function App() { return <${component} />; }\n`,
  };
}
