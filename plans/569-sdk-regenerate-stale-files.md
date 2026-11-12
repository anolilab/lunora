# Plan 569 — SDK regeneration removes stale transport files and stamps only what it copied

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** BLOCKED (needs owner: deletion policy inside a user-chosen output directory)

Finding row 27 of the 2026-11-11 audit (issue #1527). Decision plan: do not dispatch until the owner
picks an option in section 4. Rebase on plan 568, which touches the same file.

## 0. Headline finding

`lunora sdk generate` never deletes anything in its output directory. A transport file removed
upstream survives every regeneration (Go compiles every `.go` file in the package directory, so a
stale one can break or shadow the build). The stamp `lunora-transport.json` lists whatever is on
disk under each vendored destination, not what was copied, so on the second run it records the
generated Dart files under `lib/` as transport files. And for targets with two `vendor` entries, a
symlink refused in the second entry leaves the first already copied, contrary to the comment that
says a refusal writes nothing.

## 1. Current state (audit)

- `packages/cli/src/commands/sdk/vendor.ts`:
    - Lines 108-130 `copyEntry`: `assertNoSymlinks(sourceRoot, source)` for THIS entry, then
      `cpSync(source, destination, { filter, force: true, recursive: true })` (overwrites, never
      deletes), then returns `walk(destination)` — the destination, not the source.
    - Lines 82-85 (comment on `assertNoSymlinks`): "Scanning first means a refusal writes nothing."
    - Lines 171 and 204: `target.vendor.flatMap((entry) => copyEntry(...))` — scan and copy are
      interleaved per entry.
    - Lines 296-312 `writeStamp`: writes `files: result.files` into `lunora-transport.json`.
- `packages/cli/src/commands/sdk/handler.ts` lines 95-114: vendoring runs first, then every
  generated file is written with `writeFileSync` (also never deleting files a previous run
  generated).
- `packages/codegen/src/sdk/targets/dart.ts` lines ~485-507: Dart's generated files live inside
  the vendored `lib/`. `rust.ts` lines ~319-322 and `ruby.ts` lines ~289-292 declare two vendor
  entries.

## 2. Existing seams

`walk`, `isTestFile`, `assertNoSymlinks`, the stamp.

## 3. The behavioural contract to preserve

A first run into an empty directory produces the same files as today. Files the user put in the
output directory that were never in a stamp are never touched.

## 4. Design decisions — NEEDS OWNER

Two parts are decision-free bugs (workstream A). The deletion (workstream B) is a policy choice.

**Workstream A (no decision needed, size S):**

- Build `VendorResult.files` from a walk of each SOURCE entry (applying `isTestFile`), mapped to
  destination paths, not from the destination.
- Run `assertNoSymlinks` over every vendor entry before the first `cpSync`.

**Workstream B (decision):** what may regeneration delete?

- **Option 1 — delete the previous stamp's files absent from the new list (recommended).** Only
  paths Lunora itself recorded as vendored are candidates. Because the stamp is a file in the user's
  tree, treat it as untrusted: before any unlink, require each path to be relative, normalised, with
  no `..` segment, resolving inside the output directory, and `lstat` a regular file (never a
  symlink or directory). Skip and warn on anything else. Generated files are out of scope for
  deletion in this option (the stamp, after workstream A, no longer lists them).
- **Option 2 — also track generated files** in the stamp (a second list) and delete stale ones with
  the same guard. Fixes stale generated surfaces too; larger change across `handler.ts`.
- **Option 3 — no deletion; warn.** List files in the previous stamp that the new run did not
  produce, and tell the user to remove them. Safest, leaves the Go hazard to the user.

Recommendation: workstream A plus Option 1, with the path guard above, in one PR; Option 2 as a
follow-up if stale generated files show up in practice.

## 5. Workstreams

To be written as executor steps once the owner picks an option. Scope then: `vendor.ts`,
`__tests__/commands/sdk.test.ts`, `__tests__/commands/sdk-vendor-symlink-guard.test.ts` (and
`handler.ts` for Option 2).

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work           | Gate                                                                           |
| ----- | -------------- | ------------------------------------------------------------------------------ |
| 0     | Owner decision | an option chosen in this file                                                  |
| 1     | Workstream A   | stamp from source walk; two-entry refusal writes nothing (tests)               |
| 2     | Workstream B   | stale-file test; crafted-stamp test (`../`, absolute, symlink) deletes nothing |

## 8. Risks & STOP conditions

- **STOP** if any deletion path can be reached without the path guard.
- **Risk:** a user who edited a vendored file loses the edit on regeneration. Already true today
  for overwritten files; deletion extends it to removed ones.

## 9. Open questions

1. Which option for workstream B?
2. Ship workstream A alone first?
