# Plan 571 — `lunora analyze` reports bundle modules, not output files

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** DONE (APPROVED; PR #1570, branch fix/improve-571-analyze-metafile)

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/cli/src/commands/analyze/handler.ts packages/cli/__tests__/commands/analyze.test.ts packages/cli/docs/index.mdx`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 30 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

`lunora analyze` runs `wrangler deploy --dry-run --outdir <tmp>` and then reports every FILE in that
directory: the total includes source maps, "top modules" are output files (usually one bundle plus
its `.map`), and the `_generated` footprint is a substring match on output paths, which a bundled
worker never has. So the report overstates size and never shows which source modules weigh what.

## 1. Current state (audit)

- `packages/cli/src/commands/analyze/handler.ts`:
    - Lines 25-39: `AnalyzeFileEntry { path; sizeBytes }`, `AnalyzeReport { generatedFiles; outdir; topModules; totalBytes; totalFiles }`.
    - Lines 49-67 `walk(root)`: every file under the outdir.
    - Lines 82-95 `buildReport(outdir)`:

        ```ts
        const all = walk(outdir);
        const sorted = all.toSorted((a, b) => b.sizeBytes - a.sizeBytes);
        const totalBytes = all.reduce((sum, entry) => sum + entry.sizeBytes, 0);
        const generatedFiles = all.filter((entry) => entry.path.includes("_generated"));
        return { generatedFiles, outdir, topModules: sorted.slice(0, 10), totalBytes, totalFiles: all.length };
        ```

    - Lines 97-117 `renderText`; lines 126-195 `runAnalyzeCommand` (temp outdir via `mkdtempSync`,
      spawns `wrangler deploy --dry-run --outdir <outdir>`, or walks `options.inspectOnly` directly in
      tests; removes the temp dir in `finally`).
- Installed `wrangler@4.156.2` supports `--metafile [path]` on `deploy`: "Path to output build
  metadata from esbuild. If flag is used without a path, defaults to 'bundle-meta.json' inside the
  directory specified by --outdir." That file is esbuild's metafile: `outputs[<file>].inputs[<input path>].bytesInOutput`
  is each source module's contribution to that output.
- When the entry is pre-bundled (`no_bundle`, or a framework build such as SvelteKit's
  `.svelte-kit/cloudflare/_worker.js`), wrangler may write no metafile; the command must degrade, not
  fail.
- Tests: `packages/cli/__tests__/commands/analyze.test.ts` — fixture (lines 36-44) is a fake outdir
  with `worker.js` (3000 B), `chunk.js` (200 B) and `lunora/_generated/api.ts` (500 B); line 52 pins
  `totalFiles: 3`, `totalBytes: 3700`, `topModules[0].path === "worker.js"` and the `_generated`
  match; line 102 asserts the spawned args contain `--outdir`; line 122 checks the npm launcher.
- `packages/cli/docs/index.mdx` lines 1904-1908 describe the command ("bundle size, the heaviest
  modules, and the state of `_generated/` files").

## 2. Existing seams (do not reinvent)

`walk`, `formatBytes`, the spawner/`inspectOnly` split, `EXIT_CODE`.

## 3. The behavioural contract to preserve

Exit codes, the spawner contract and the npm/pnpm launcher logic are unchanged. `--format json`
keeps the existing keys (`generatedFiles`, `outdir`, `topModules`, `totalBytes`, `totalFiles`) with
their new meaning, plus one new key (below). This is a behaviour change for JSON consumers; the
commit body says so.

## 4. Design decisions

- **Spawn with a metafile:** pass `--metafile` with NO path (so wrangler writes
  `<outdir>/bundle-meta.json`), keeping `--outdir`. With `inspectOnly`, read
  `<inspectOnly>/bundle-meta.json` if present.
- **Totals:** output files from `walk`, excluding `*.map` files and `bundle-meta.json`.
- **With a metafile:** sum `bytesInOutput` per input path across all outputs; `topModules` = the 10
  largest inputs (`{ path: <input path>, sizeBytes }`); `generatedFiles` = inputs whose path has a
  `_generated` directory segment (`/(^|[\\/])_generated[\\/]/u`), sorted largest first.
- **Without one (or unparsable):** `topModules` = the 10 largest output files (maps excluded),
  `generatedFiles` = `[]`, and one `logger.warn` saying the per-module breakdown is unavailable
  because wrangler wrote no esbuild metafile (a pre-bundled entry).
- **New key** `breakdown: "metafile" | "output-files"` on `AnalyzeReport`, so JSON consumers know
  which meaning `topModules` has. `renderText` titles the list "top modules by bytes in bundle" or
  "largest output files" accordingly.
- **Rejected:** decoding source maps per module (needs a VLQ decoder dependency for a fallback path).

## 5. Workstreams

One workstream, size M. One commit, type `fix`, scope `cli`.

### Commands you will need

| Purpose         | Command (worktree root)                                                                                        | Expected |
| --------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| Install         | `pnpm install --frozen-lockfile`                                                                               | exit 0   |
| Build deps once | `pnpm --filter "@lunora/cli..." run build`                                                                     | exit 0   |
| Test file       | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/analyze.test.ts`                               | all pass |
| Package tests   | `pnpm --filter "@lunora/cli" run test`                                                                         | all pass |
| Format code     | `pnpm exec oxfmt packages/cli/src/commands/analyze/handler.ts packages/cli/__tests__/commands/analyze.test.ts` | exit 0   |
| Format docs     | `pnpm exec prettier --write packages/cli/docs/index.mdx`                                                       | exit 0   |
| ESLint          | `pnpm --filter "@lunora/cli" run lint:eslint`                                                                  | exit 0   |
| Types           | `pnpm --filter "@lunora/cli" run lint:types`                                                                   | exit 0   |

### Scope

**In scope:** `packages/cli/src/commands/analyze/handler.ts`,
`packages/cli/__tests__/commands/analyze.test.ts`, `packages/cli/docs/index.mdx` (the
`### lunora analyze` paragraph only).

**Out of scope:** `commands/analyze/index.ts` (flags), `util/spawn.ts`, `apps/docs/**`,
`plans/README.md`.

### Git workflow

- Branch `fix/improve-571-analyze-metafile`, from `origin/alpha`. Do not push.
- One commit: `fix(cli): size analyze modules from the esbuild metafile`; body ≤ 4 lines, including
  one line noting the JSON report's `topModules` now lists source modules and the new `breakdown`
  key; last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, repo-root
  `pnpm run test`, or `pnpm -r …`. Never kill a process by pattern. Never run real `wrangler` in
  tests.
- oxfmt before ESLint; Prettier for the `.mdx`. No `.js` import extensions. Named exports only.
  Comments say why.
- No `.skip`, `@ts-expect-error`, `as any`, or new `eslint-disable` without rule + `-- reason`.

### Step 1: Install and build

**Verify:** exit 0.

### Step 2: Write the failing tests

In `analyze.test.ts`, replace the fixture-dependent assertions (the test at line 52) with cases
that describe the new behaviour:

1. Outdir with `index.js` (3000 B), `index.js.map` (5000 B) and a `bundle-meta.json` whose
   `outputs["index.js"].inputs` has `src/server.ts` (1800), `lunora/_generated/server.ts` (700),
   `node_modules/x/index.js` (500), each as `{ bytesInOutput: N }`: report has `totalFiles: 1`,
   `totalBytes: 3000`, `breakdown: "metafile"`, `topModules[0]` is `src/server.ts` with 1800, and
   `generatedFiles` is exactly `[{ path: "lunora/_generated/server.ts", sizeBytes: 700 }]`.
2. Same outdir with no `bundle-meta.json`: `breakdown: "output-files"`, `topModules` is
   `[{ path: "index.js", sizeBytes: 3000 }]` (map excluded), `generatedFiles` is `[]`, and a
   warning was logged.
3. A path such as `src/not_generated_here.ts` is NOT counted as generated.
4. Extend the test at line 102: the spawned args contain `--metafile`.

**Verify:** test-file command → cases 1-4 FAIL.

### Step 3: Implement

Per section 4. Type the metafile read defensively (`unknown` → narrowed), never `as any`.

**Verify:** test-file command passes; the json-format test (line 68) and launcher test (line 122)
still pass.

### Step 4: Docs

Update the `### lunora analyze` paragraph in `packages/cli/docs/index.mdx` to say it sizes source
modules from wrangler's esbuild metafile, excludes source maps from the total, and falls back to
output files for a pre-bundled entry.

**Verify:** `pnpm exec prettier --check packages/cli/docs/index.mdx` exits 0.

### Step 5: Gates, then commit

**Verify:** both formatters, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 6: Prove the tests need the fix (after the commit; no stash)

```bash
git show 79b0c5a6a:packages/cli/src/commands/analyze/handler.ts > packages/cli/src/commands/analyze/handler.ts
pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/analyze.test.ts   # new cases FAIL
git checkout HEAD -- packages/cli/src/commands/analyze/handler.ts
git status --short   # empty
```

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                   |
| ----- | --------- | ------------------------------------------------------ |
| 0     | Steps 1-6 | new cases red on base, green with fix; cli gates green |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if another test file or source file imports `AnalyzeReport` and breaks on the new key.
- **Risk:** a non-cloudflare target (`lunora.config` `target`) may not run wrangler at all. Out of
  scope; the command already only supports wrangler.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] New cases fail against `79b0c5a6a`'s `analyze/handler.ts`.
- [ ] `grep -n '"--metafile"' packages/cli/src/commands/analyze/handler.ts` matches.
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only in-scope files.

## Maintenance notes

If wrangler changes the metafile's default location, only `runAnalyzeCommand` reads it.
