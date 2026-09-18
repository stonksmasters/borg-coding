# Design Quality System

Last updated: 2026-09-18

## Principle

Technically correct is not the same as finished.

BORG's frontend product should be judged as a real interface: visual hierarchy, composition, typography, spacing, interaction, responsiveness, credibility, and polish all matter.

The system therefore separates design direction from implementation and verifies design quality independently from the implementer's own claims.

## Design Director

Before significant greenfield frontend work, the Design Director creates an art-direction contract.

It should define:

- target audience and product feel;
- composition and focal hierarchy;
- typography hierarchy;
- color direction;
- spacing and visual rhythm;
- density;
- imagery or illustration treatment when relevant;
- component character;
- motion and interaction restraint;
- mobile adaptation;
- content voice;
- anti-patterns to avoid.

The direction should be specific enough for an implementer to make visual decisions consistently.

## Quality bar

BORG should prefer:

- clear visual hierarchy;
- intentional whitespace and density;
- strong focal points;
- composition that varies visual weight;
- reusable systems without turning every surface into identical cards;
- coherent typography;
- mobile-first interaction where appropriate;
- restrained motion that supports understanding;
- credible content;
- purposeful states for loading, empty, error, hover, focus, and success.

BORG should avoid:

- generic AI dashboard styling;
- endless rounded cards;
- arbitrary gradients;
- excessive glassmorphism;
- weak contrast;
- identical section rhythms;
- placeholder content presented as real data;
- fake social proof;
- fake metrics, awards, reviews, testimonials, or customer logos;
- controls that look interactive but do nothing;
- desktop layouts merely squeezed onto mobile.

## Implementation contract

The frontend implementer should receive the approved design direction together with the current slice or entity context.

The implementer may refine local details, but should not silently replace the art direction.

Material changes to the visual language should be recorded as project decisions.

## Visual verification

Design-directed work should preserve browser evidence at relevant viewports.

Evidence may include:

- desktop screenshots;
- mobile screenshots;
- focused component captures;
- interaction states;
- visual-regression comparison;
- accessibility evidence;
- console and network status.

Screenshots are evidence inputs, not automatically proof of quality.

## Independent review

A Visual Director or equivalent independent quality gate should review the result after implementation.

The review should focus on observable problems such as:

- weak hierarchy;
- inconsistent spacing;
- poor responsive adaptation;
- content overflow;
- visual imbalance;
- illegible text;
- awkward component density;
- broken state design;
- low credibility;
- interaction ambiguity;
- obvious unfinished areas.

The reviewer should produce concrete findings tied to evidence.

## Repair loop

Design repair is bounded.

1. identify blocking or high-value findings;
2. hand those findings to the implementer;
3. repair only the relevant surfaces;
4. recapture evidence;
5. re-review.

Design review should not become an endless subjective loop. The system should use severity, acceptance criteria, and bounded attempt policies.

## Design system versus sameness

Reusable tokens and primitives are good.

Uniformity is not the objective.

BORG should build coherent systems while preserving meaningful variation between hero areas, discovery surfaces, detail pages, conversion flows, dashboards, and utility states.

## Existing products

When working in an established application, preserve existing brand and design-system conventions unless the user explicitly requests a redesign.

The Design Director should then interpret the request inside the existing system rather than invent a new visual language.

## Future component quality corpus

The page/component corpus should retain design evidence so future promotion decisions are based on observed quality.

A reusable component may eventually carry:

- screenshots;
- supported variants;
- responsive behavior;
- accessibility status;
- design tags;
- interaction characteristics;
- known constraints;
- provenance.

Retrieval from the corpus is later. Quality and trustworthy metadata come first.
