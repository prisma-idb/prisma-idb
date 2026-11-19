---
description: "Writing style for Markdown, MDX docs, READMEs and ADRs; docs site navigation."
paths: "**/*.md, **/*.mdx"
globs: "**/*.md, **/*.mdx"
alwaysApply: false
applyTo: "**/*.md,**/*.mdx"
---

# Writing docs

Follow the Google developer documentation style:

- Put the point first. One idea per sentence; keep sentences short.
- Use active voice and present tense. Address the reader as "you".
- Define a term the first time you use it. Use the same term for the same thing throughout.
- Prefer lists and tables to long paragraphs. Use sentence-case headings.
- Describe current behavior. Don't narrate history ("we used to", "Phase 9 added"), and don't send the reader to a plan for a fact you can state inline.
- Don't wrap prose at a fixed column. Prettier formats Markdown on commit.

## Docs site

- Pages live in `apps/docs/content/docs`: `(index)` for the legacy generator, `prisma-8` for the Prisma 8 integration, `sync` for sync.
- A new page must be added to its folder's `meta.json`, or it won't appear in the navigation.
- Code samples must compile against the current packages.

`packages/prisma-orm/plans/` is the exception: plans are working notes for agents, not reader-facing docs. Keep them detailed rather than polished, and delete a plan once it is implemented.
