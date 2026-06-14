# Plan 002: Placeholder detection must not match real values by substring

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP condition" occurs, stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 151a3eca..HEAD -- packages/config/src/scaffold-dev-variables.ts`
> If the file changed, compare the "Current state" excerpt to the live code; on
> a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

`isPlaceholderValue` decides whether a `.dev.vars` entry is a "fill-me-in"
placeholder (so it gets regenerated) or a real value (left untouched). It tests
markers like `todo`, `change-me`, `example`, `xxx` with `String.includes`, an
unanchored substring match. So a **real** value that merely contains one of
those substrings — `https://todoist.com/hooks/abc`, an API token literally
`xxxK3y...`, `UNCHANGED_PRODUCTION_SECRET` (contains `change`? no — but
`change-me` ⊄; however `todo` ⊂ `todoist`, `example` ⊂ many URLs) — is
misclassified as a placeholder. When the key also matches the secret-key regex,
the scaffolder **overwrites the real secret with a freshly generated one**,
silently destroying a value the user set. Anchoring the markers to word
boundaries removes the false positives while still catching genuine
placeholders.

## Current state

- `packages/config/src/scaffold-dev-variables.ts:70-82` — the matcher:

  ```ts
  const isPlaceholderValue = (value: string): boolean => {
      const normalised = value.trim().toLowerCase();

      if (normalised === "") {
          return true;
      }

      if (normalised.startsWith("<") && normalised.endsWith(">")) {
          return true;
      }

      return PLACEHOLDER_MARKERS.some((marker) => normalised.includes(marker));
  };
  ```

- `PLACEHOLDER_MARKERS` ends (lines ~60-62) with entries like `"fill_in"`,
  `"xxx"`, and earlier includes markers such as `todo`, `change-me`, `example`,
  `changeme`, `your-` (read the full array at the top of the file to get the
  exact list — do not guess it).
- The overwrite path — `:95-96`:

  ```ts
  const generatedSecretFor = (key, rawValue, randomHex) =>
      SECRET_KEY.test(key) && isPlaceholder(rawValue) ? randomHex(SECRET_BYTES) : undefined;
  ```

  i.e. a secret-looking key + a value `isPlaceholder` returns `true` for ⇒ a new
  random secret replaces it.

## Commands you will need

| Purpose   | Command                                            | Expected |
|-----------|----------------------------------------------------|----------|
| Build deps (once) | `pnpm run build:packages`                  | exit 0 (dist is gitignored/built on demand) |
| Typecheck | `pnpm --filter "@cirrus/config" run lint:types`    | exit 0   |
| Tests     | `pnpm --filter "@cirrus/config" run test`          | all pass |

## Scope

**In scope**:
- `packages/config/src/scaffold-dev-variables.ts` (only `isPlaceholderValue`
  and, if needed, how `PLACEHOLDER_MARKERS` is shaped)
- `packages/config/__tests__/scaffold-dev-variables.test.ts` (or the existing
  test file covering this module — find it and extend it)

**Out of scope**:
- The `<...>` angle-bracket branch and the empty-string branch — both correct,
  leave them.
- `SECRET_KEY` / `SECRET_BYTES` / the random generator — unrelated.
- Any change that would make a genuine placeholder (`TODO`, `change-me`,
  `<your-key>`) start being treated as real — that would reintroduce committed
  placeholders. The change must *only narrow* false positives.

## Git workflow

- Branch: `advisor/002-config-placeholder-substring`
- Commit: `fix(config): anchor .dev.vars placeholder markers to word boundaries`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Match markers on word boundaries instead of raw substrings

Replace the final `return` of `isPlaceholderValue` so each marker matches only
as a whole token, not as a substring of a larger word. Markers contain
non-word characters (e.g. `change-me`, `fill_in`), so a `\b`-only regex is
insufficient; treat the marker as bounded by start/end or a non-alphanumeric
neighbor. A robust approach:

```ts
return PLACEHOLDER_MARKERS.some((marker) => {
    const escaped = marker.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    // marker must stand alone: bounded by string edges or a non-alphanumeric char
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "u").test(normalised);
});
```

This keeps `todo`, `change-me`, `example` matching when they are the value (or a
standalone token in it) but stops `todoist`, `examples-of-life`, etc. from
matching.

If `PLACEHOLDER_MARKERS` contains a marker that is *meant* to match as a prefix
(e.g. `your-`), preserve that intent — read each marker and decide; do not blanket
word-boundary a prefix marker into uselessness. If unsure about a specific
marker's intent, that is a STOP condition (ask).

**Verify**: `pnpm --filter "@cirrus/config" run lint:types` → exit 0.

### Step 2: Add regression tests for the false positives

In the test file, add cases asserting `isPlaceholderValue` (or the public
`isPlaceholder`/scaffold behavior — match what the existing tests exercise)
returns:
- `true` for genuine placeholders: `"TODO"`, `"change-me"`, `"<your-key>"`,
  `""`, `"xxx"`.
- `false` for real values that contain a marker as a substring:
  `"https://todoist.com/x"`, `"prod-example-secret-do-not-touch"` (pick values
  that contain a marker substring per the actual `PLACEHOLDER_MARKERS`),
  and a 64-hex-char string.

If `isPlaceholderValue` is not exported, test through the nearest exported
surface (the scaffold/augment planner) by asserting a real secret value is
**not** regenerated.

**Verify**: `pnpm --filter "@cirrus/config" run test` → all pass.

## Test plan

- New tests in the existing scaffold-dev-variables test file, following its
  structure, covering: genuine placeholders still detected; substring-collision
  real values no longer detected; a real secret value survives an augment pass.
- Verification: `pnpm --filter "@cirrus/config" run test` → all pass including
  the new cases.

## Done criteria

ALL must hold:

- [ ] `pnpm --filter "@cirrus/config" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/config" run test` exits 0; new tests prove a real
      value containing a marker substring is not classified as a placeholder
- [ ] Every existing placeholder marker still matches when it is the standalone
      value (no regression in placeholder detection)
- [ ] `git status` shows only the two in-scope files modified
- [ ] `plans/README.md` row updated

## STOP conditions

- The `PLACEHOLDER_MARKERS` array or `isPlaceholderValue` no longer matches the
  excerpt.
- A marker's intended matching semantics (whole-token vs prefix) is ambiguous
  from the code/comments — report rather than guess.
- A change that fixes false positives also breaks a genuine-placeholder test you
  cannot reconcile.

## Maintenance notes

- When adding a new marker to `PLACEHOLDER_MARKERS`, remember matching is now
  whole-token; document that in a comment by the array.
- Reviewer: confirm no marker that is supposed to match a prefix was neutered.
