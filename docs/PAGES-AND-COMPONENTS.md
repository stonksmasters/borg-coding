# Pages and Components

Last updated: 2026-09-18

## Purpose

BORG should treat pages and reusable components as first-class product entities rather than as incidental files discovered only when a model searches the repository.

This is the foundation for scoped workspaces, smaller context windows, better iteration quality, and eventually a reusable BORG component corpus.

## Product model

A website contains two parallel inventories:

### Pages

Pages are navigable product surfaces.

Examples:

- Home;
- Search;
- Product Detail;
- Cart;
- Checkout;
- Account;
- Admin Dashboard.

A page may own route-level acceptance criteria, composition, data requirements, responsive requirements, and page-specific verification.

### Components

Components are reusable UI capabilities used by one or more pages.

Examples:

- Header;
- ProductCard;
- ProductGrid;
- CreatorBadge;
- CartDrawer;
- PriceDisplay;
- ReviewSummary.

A component should have a stable identity even when its implementation spans multiple files.

## Why this matters

Without first-class entities, BORG has to rediscover structure from the repository every time the user asks for a change.

With explicit entities, BORG can answer:

- what is this component for;
- where is it used;
- what files implement it;
- what does it depend on;
- what design contract applies;
- what pages would be affected by a change;
- what verification evidence exists;
- what changed most recently.

This reduces context size and makes targeted iteration safer.

## Page registry

The page registry should eventually record:

- stable ID;
- display name;
- route;
- purpose;
- source files;
- component dependencies;
- data dependencies;
- page-level design contract;
- acceptance criteria;
- verification state;
- last modified time;
- active findings;
- edit history.

The registry should be derived and maintained by the system, not manually curated by the user.

## Component registry

The component registry should eventually record:

- stable ID;
- display name;
- category;
- purpose;
- source files;
- props or public interface;
- child components;
- parent consumers;
- pages where it appears;
- design contract;
- responsive behavior;
- verification state;
- edit history;
- reuse status.

## Dedicated workspaces

The main project workspace remains the place to view the full build.

A Page workspace narrows the product to one page.

A Component workspace narrows the product to one reusable component.

When the user opens a scoped workspace, BORG should compile context around that entity rather than loading the entire project history.

### Page workspace

Expected surfaces:

- focused preview of the page;
- page composition;
- components used;
- route and data contract;
- page-specific plan or requested change;
- current verification evidence;
- recent changes;
- active findings.

### Component workspace

Expected surfaces:

- isolated or story-like preview;
- component purpose;
- variants;
- props and interfaces;
- usage locations;
- dependencies;
- design contract;
- recent changes;
- current verification evidence.

## Scoped execution

A request made inside a Page or Component workspace should default to that scope.

BORG may inspect dependencies when necessary, but it should not turn every local edit into a project-wide planning cycle.

Example:

User opens ProductCard and asks for a premium hover treatment.

The normal loop should be:

1. compile ProductCard context;
2. inspect its implementation and direct dependencies;
3. implement the bounded change;
4. verify isolated and in-page behavior;
5. update entity history and evidence.

It should not regenerate the website plan.

## Global component corpus

Over time, BORG can maintain a library of high-quality page and component artifacts across projects.

The near-term goal is collection and quality:

- identify useful reusable components;
- preserve metadata;
- record screenshots and verification;
- classify variants;
- keep provenance;
- avoid low-quality duplicates.

Automatic retrieval and injection into model context is intentionally later.

A weak component library retrieved aggressively would make output more generic, not better.

## Promotion criteria

A component should not be promoted into the reusable corpus merely because it exists.

Promotion should eventually require evidence such as:

- visual quality;
- responsive behavior;
- accessibility;
- clean public interface;
- low coupling;
- successful use in a real page;
- no active serious findings;
- clear provenance and license status.

## Relationship to slices

Slices and entities are related but not identical.

A slice is execution scope for a phase.

A page or component is a durable product entity.

One slice may create several components. A later slice may refine a component created earlier. After the initial build, the user may edit a page or component without creating a new project-wide slice plan.

## Success criteria

This system is successful when the user can open a project, see Pages and Components as separate categories, select one, and work on it with:

- dramatically smaller context;
- clear dependencies;
- focused preview;
- focused verification;
- durable edit history;
- no loss of project-level design and architecture constraints.
