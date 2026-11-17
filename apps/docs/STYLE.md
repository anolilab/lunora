# Lunora docs style guide

Rules for every page under `apps/docs/src/content/docs/**` and
`packages/*/docs/**`. Adapted from the
[Astro Docs writing style](https://contribute.docs.astro.build/guides/writing-style/),
[code-sample](https://contribute.docs.astro.build/reference/code-samples/),
[API reference](https://contribute.docs.astro.build/reference/api-references/)
and [recipe](https://contribute.docs.astro.build/guides/recipe-writing/) guides,
plus rules for readers that are coding agents (pages are also served as
`/llms.txt`, `/llms-full.txt` and per-page markdown via
`src/routes/llms[.]mdx.docs.$.ts`).

## Accuracy comes first

- Every API name, option, default, CLI flag, error code, limit and file path on
  a page must match the source in `packages/*/src`. When prose and code
  disagree, the code wins: fix the page.
- Do not document what does not exist. Planned work belongs in `plans/`, not in
  the docs. If a page has to mention an unshipped feature, say so in one plain
  sentence.
- Numbers (limits, thresholds, timeouts, defaults) are copied from the constant
  in the source, not rounded or remembered.

## Page types

Each page is one of these. Keep the type pure; link to the other types instead
of mixing them.

| Type      | Where                                          | Job                                            |
| --------- | ---------------------------------------------- | ---------------------------------------------- |
| Tutorial  | `tutorial/*`, `getting-started`                | Build one thing end to end, start to finish    |
| How-to    | `frameworks/*`, `migrating/*`, most task pages | Do one specific task from a stated start       |
| Concept   | `concepts/*`, `architecture`                   | Explain how a feature works and when to use it |
| Reference | `packages/*`, `errors`, `exit-codes`, `limits` | Complete, scannable list of APIs/options       |

### How-to pages

1. One-sentence intro saying what the reader will have at the end.
2. `## Prerequisites` when anything beyond "an existing Lunora app" is needed.
3. Numbered steps (`<Steps>` / `<Step>` for long ones), imperative mood, one
   action per step.
4. Optional `## Next steps` / related links at the end.

### Concept pages

1. Open with what the feature is and the problem it solves, in two or three
   sentences. No history, no storytelling.
2. Show the smallest working example early, before edge cases.
3. Then: how it works, options, limits, gotchas, when **not** to use it.

### Reference pages (package pages)

1. One-paragraph summary: what the package is for and when you need it.
2. `## Installation` with the install command.
3. `## Usage` with a minimal working example.
4. `## API` — one heading per export or option, heading text in inline code
   (`` ### `shardBy(key)` ``). Under it, in this order: **Type:**, **Default:**
   (only if there is one), then a description that starts with what the item
   is or does.
5. Cover every public export of `src/index.ts` (and other entry points in
   `package.json` `exports`). Internal helpers stay out.

## Voice

- Present tense, second person, active voice. "The runtime retries the
  mutation", not "the mutation will be retried".
- No "we", "us", "our", "let's", "I". No jokes, no hype ("blazing", "magic",
  "simply", "just", "easy", "seamless").
- Imperative for instructions: "Run the following command." Avoid "You
  should…". Use "You can…" only to say an option exists.
- Give the reason with the instruction: "To avoid a cold start, set …".
  Separate opinion from instruction: state the criterion, then the choice.
- Short sentences and paragraphs. Spell out an acronym on first use per page
  (Durable Object (DO), optimistic concurrency control (OCC)).
- Only document how Lunora works. Link out for Cloudflare, React, SQLite, etc.

## Headings

- The frontmatter `title` is the `<h1>`; sections start at `##`.
- Short, no trailing punctuation, sentence case. Code names in backticks.
- Headings are link targets and appear in "On this page": make them
  descriptive ("Shard an existing table", not "More").

## Code samples

- Every sample is real, working code that type-checks against the current API.
  No `foo`/`bar`; use the app's domain (messages, channels, users).
- Imports are explicit and from the package that exports the symbol (the build
  runs `scripts/check-doc-imports.mjs` and fails on fake imports).
- Give a file name: ` ```ts title="lunora/messages.ts" `.
- Introduce each sample with a full sentence ("The following mutation inserts a
  message:"), never "like so:". Explain several samples one at a time.
- Show one realistic value for an option, not every possible value.
- Terminal commands use ` ```bash ` and the package manager the rest of the
  page uses (pnpm by default).

## Generated content

- The block between the `generated:error-codes` markers in `errors.mdx` is
  written from `packages/errors/src/catalog.ts`. Fix the catalog, not the page.
- `apps/docs/src/content/docs/packages/**` is a build-time copy. Package pages
  are authored in `packages/<name>/docs/`.

## Lists, tables, callouts

- Ordered lists for sequences, bullets otherwise. Promote an item to a heading
  when it grows past a short paragraph or carries a lot of code.
- Tables for options/limits/comparisons with more than three rows.
- Callouts (`<Callout type="warn">` or `type="info"`) only for things that would otherwise cause a bug,
  data loss or a surprise bill. Do not wrap ordinary prose in a callout.
- "for example" in running text; "e.g." only inside parentheses.

## Links

- Link the first mention of another Lunora concept on a page to its page.
- Internal links are root-relative (`/docs/concepts/sharding`), and must point
  to a page that exists.
- Link text names the destination ("see [Sharding](/docs/concepts/sharding)"),
  never "click here".

## For agents as readers

- Each page stands alone: state the import path, the file it goes in, and the
  command to run. Do not rely on "as shown above" across pages.
- Name exact symbols, flags and env vars in backticks so they can be grepped.
- Put the constraint next to the API it constrains (limits, required
  bindings, what throws), not in a separate "notes" section far below.
- Every error the user can hit names its code and links to `/docs/errors`.
- Frontmatter `description` is one sentence that says what the page covers; it
  is what `llms.txt` shows. Start it with a verb on how-to pages.
