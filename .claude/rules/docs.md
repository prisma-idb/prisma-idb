---
description: "Writing style for Markdown, MDX docs, READMEs and ADRs; docs site navigation."
paths: "**/*.md, **/*.mdx"
globs: "**/*.md, **/*.mdx"
alwaysApply: false
applyTo: "**/*.md,**/*.mdx"
---

# Writing docs

These rules apply to Markdown, MDX, changesets, ADRs, code comments and JSDoc. They draw on the [Diátaxis framework](https://diataxis.fr/) and Google's [Technical Writing courses](https://developers.google.com/tech-writing) and [developer documentation style guide](https://developers.google.com/style).

## Give each page one job

Diátaxis names four kinds of documentation. Each answers a different reader need, so don't mix them in one section. Link to the other kind instead.

| Kind        | The reader wants to              | Write it as                                                | Leave out                             |
| ----------- | -------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| Tutorial    | Learn by doing                   | A guided lesson with visible results early                 | Options, alternatives, explanation    |
| How-to      | Reach a goal they already know   | Numbered steps in a logical order, named after the task    | Background, full option lists         |
| Reference   | Look up a fact while working     | A neutral description that mirrors the product's structure | Instruction, opinion, history         |
| Explanation | Understand why it works this way | Context, reasons and alternatives, with a bounded scope    | Steps and exhaustive technical detail |

In this repository, API pages under `apps/docs/content/docs/prisma-8/api` are mostly reference, and [ARCHITECTURE.md](../../packages/prisma-orm/docs/ARCHITECTURE.md) and the ADRs are explanation. A changeset is a short release note: reference for the people who upgrade.

## Shape the text

- **Open with the point.** The first sentence of a paragraph says what the paragraph is about. A reader who skims only first sentences should still follow the page.
- **One topic per paragraph, three to five sentences.** Split a paragraph that runs past about seven sentences. Merge a one-sentence paragraph into its neighbor, or turn it into a list.
- **One idea per sentence.** Cut filler ("is able to" becomes "can"). Replace "there is" and weak verbs with the real subject and verb. Put a condition before the instruction it governs.
- **Use lists and tables.** A run of three or more parallel items, or a sentence with several "or" branches, is a list. Cases with the same questions and different answers are a table. Introduce a list or table with a sentence ending in a colon. Keep items parallel in grammar and punctuation.
- **Use active voice and present tense.** Name the actor. Address the reader as "you", never "we".
- **Use one term for one thing.** Define a term the first time you use it, and don't rename it later. Replace "it", "this" and "that" with a noun when the referent could be unclear.
- **Use numbers and names, not adjectives.** Write "throws `IdbRelationUpdateError`", not "fails in some cases".
- **Show a short example before the edge cases.** Code samples must compile against the current packages.
- Use sentence-case headings. Name a how-to heading after the task.
- Describe current behavior. Don't narrate history ("we used to", "Phase 9 added"), and don't send the reader to a plan for a fact you can state inline. The one exception is a changeset, where "Before, X. Now, Y." tells upgraders what changed.
- Don't wrap prose at a fixed column. Prettier formats Markdown on commit.

## Describe behavior with edge cases

A behavior with several edge cases is the usual source of walls of text. Each review finding adds a sentence, and the paragraph grows until nobody can read it. Don't append. Restructure:

1. State the rule in one sentence.
2. Show one short example.
3. List each edge case as its own bullet, with a bold lead-in and one rule.
4. Use a table when the same question has a different answer for each case.

When a review adds a caveat to existing text, put it in the list or table. If the text has no list or table yet, create one. Then count: no paragraph longer than five sentences, and no bullet longer than three sentences.

For example, avoid this:

> It changes the first row of the chain, and `take(0)` matches no row, so it returns `null`, but the data is still validated, so invalid data throws, while foreign-key checks don't run because they need a row, and an update with a relation callback throws if the chain has `orderBy()`.

Write this instead:

> `update()` changes the first row the chain matches. It returns the updated row, or `null` when no row matches.
>
> - **`take(0)`** matches no row, so `update()` returns `null`. It still validates the data.
> - **Relation callbacks** throw `IdbRelationUpdateError` if the chain has `orderBy()`, `skip()` or `take()`.

## Write a changeset

A changeset tells the people who upgrade what changed and what to do. Use this shape:

```md
---
"@prisma-idb/client-idb": patch
---

<One sentence: what is different for a user of the package.>

- <One behavior per bullet: what the code does now. Add the old behavior only when an upgrader could depend on it.>
- <If a caller's code can break, say how to fix it.>
```

- The first sentence must make sense alone. It is what a release summary shows.
- Aim for six bullets or fewer. If you need more, the change probably covers more than one thing, so consider splitting the PR.
- Describe the effect on users, not the implementation. Leave out file names, function names that users can't call, and PR, ADR or phase numbers.
- Put breaking changes in the changeset, and say what to do. Don't promise a safeguard the code doesn't have.

## Write code comments and JSDoc

Apply the same rules. The first sentence says what the code does, and a second says why when the reason isn't obvious. A block over about eight lines usually holds reference material, such as a table of cases. Put that on the docs site and keep the comment to what a caller needs: the return value, what it throws, and any surprising option.

## Docs site

- Pages live in `apps/docs/content/docs`: `(index)` for the legacy generator, `prisma-8` for the Prisma 8 integration, `sync` for sync.
- A new page must be added to its folder's `meta.json`, or it won't appear in the navigation.
- Code samples must compile against the current packages. Prisma 8 model accessors live under `db.orm`, for example `db.orm.note`.

## Every claim matches the code

Wrong claims are the second most common review finding, after missed code paths. Docs, READMEs, changesets, code comments, error messages and CLI advice all count.

- Check each factual statement against the code before you write it: HTTP status codes, command flags (such as `--config`), file paths, what a command does and doesn't do, and which operations share a transaction.
- When a change alters behavior, search the repository, `apps/docs/content/docs` included, for the old wording and update it in the same change.
- A changeset tells package users what changed and what to do. Don't promise a safeguard the code doesn't have. Use an empty changeset when no published file changes; tests and snapshots aren't published.
- When two agent files or docs state the same rule, they must agree. Update both or link one to the other.

`packages/prisma-orm/plans/` is the exception: plans are working notes for agents, not reader-facing docs. Keep them detailed rather than polished, and delete a plan once it is implemented.
