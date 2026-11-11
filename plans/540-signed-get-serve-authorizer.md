# Plan 540 — Ship a signed-GET authorizer for `serveStorageObject` and use it in the recipes

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):**
> `git diff --stat 4a7c48bfd..HEAD -- packages/storage/src/index.ts packages/storage/src/signed-url.ts packages/server/src/http-storage.ts registry/storage/README.md packages/cli/skills/lunora-setup-storage/SKILL.md packages/storage/docs/index.mdx packages/codegen/src/capabilities.ts`
> must print nothing. Then confirm the excerpts in §1 match. Any mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO
**Priority / effort / risk:** P1 / S / LOW. **Category:** security. **Depends on:** none.

## 0. Headline finding

The documented recipe for gating `serveStorageObject` is
`async ({ request }) => (await verifySignedUrl(new URL(request.url), secret)).valid`. `verifySignedUrl`
only proves the URL was signed by us and has not expired; it returns the signed `method`, `key` and
`bucketName` for the caller to enforce. Checking `.valid` alone accepts a URL minted for a different
verb (an upload URL), for a different bucket, or for a different key than the one the route resolved.
The recipe is copied into apps from three places.

## 1. Current state (audit)

- `packages/server/src/http-storage.ts:270-278` — `StorageServeAuthorizer` docblock:

    ```ts
     * For a signed-URL topology this is where `verifySignedUrl` goes:
     * `async ({ request }) => (await verifySignedUrl(new URL(request.url), secret)).valid`.
     */
    type StorageServeAuthorizer = (context: StorageServeAuthzContext) => boolean | Promise<boolean>;
    ```

    `StorageServeAuthzContext` (lines 261-266) is `{ key: string; request: Request }`, where `key` is
    "the object key the caller asked for — already resolved by the route". Lines 310-313 repeat
    "pass `verifySignedUrl` (or a session check) as the gate".

- `registry/storage/README.md:69-74` — the copy-in recipe:

    ```ts
    import { serveStorageObject } from "@lunora/server";
    import { verifySignedUrl } from "@lunora/storage";

    // inside an httpAction handler
    return serveStorageObject(ctx, key, request, async ({ request: r }) => (await verifySignedUrl(new URL(r.url), env.STORAGE_SIGNING_SECRET)).valid);
    ```

    The hand-written route in the same README (lines ~80-110) does check `method` and `key`.

- `packages/cli/skills/lunora-setup-storage/SKILL.md:60-64` — "call `verifySignedUrl` inside its
  `authorize` gate". (This file is the source; `.agents/skills` and `.claude/skills` are symlinks to it.)
- `packages/storage/src/signed-url.ts:197-268` — `verifySignedUrl(input, secret, options?: { expectedHost?: string })`
  returns `{ bucketName, contentType, key, method, valid: true }` on success and
  `{ reason, valid: false }` otherwise; `method` is `"GET" | "PUT"`.
- `packages/storage/src/index.ts:7` — `export { buildSignedUrl, verifySignedUrl } from "./signed-url";`
- `packages/codegen/src/capabilities.ts:510-517` — the storage capability row lists
  `bindingFreeExports: ["buildPresignedUrl", "buildSignedUrl", "scopeKey", "verifySignedUrl"]`
  (exports usable without the storage binding). The new export belongs in this list.
- `examples/blog/src/server/index.ts:94-96` shows the full check in app code:
  `!verdict.valid || verdict.key === undefined || verdict.method !== "PUT" || verdict.bucketName !== "default"`.
- `@lunora/storage` does NOT depend on `@lunora/server` (see `packages/storage/package.json`
  `dependencies`), so the new helper must be typed structurally, not with `StorageServeAuthorizer`.
- Test pattern: `packages/storage/__tests__/signed-url.test.ts` (builds URLs with `buildSignedUrl({ baseUrl, bucketName, key, secret, method?, expiresInSeconds? })` and verifies).

## 2. Existing seams (do not reinvent)

- `verifySignedUrl` does all cryptography and expiry; the helper only adds the three equality checks.
- Each file in `packages/storage/src` has one concern and named exports; create a new file for the
  helper (a file with a single named export is fine).

## 3. The behavioural contract to preserve

- `verifySignedUrl`'s signature and result are unchanged.
- `serveStorageObject` is unchanged (its gate already fails closed on anything but `true`).

## 4. Design decisions

- New export `authorizeSignedGet(secret, { bucketName, expectedHost? })` returning
  `(context: { key: string; request: Request }) => Promise<boolean>`. `bucketName` is required: an
  optional bucket would reintroduce the cross-bucket confusion the signature binds against.
  Chosen over documenting the four checks (they were already documented, and the short recipe still
  dropped them) and over changing `verifySignedUrl` to take expectations (a wider API change).
- Returns `true` only when `valid === true`, `method === "GET"`, `key === context.key`, and
  `bucketName === options.bucketName`. A thrown error propagates (the server gate already treats a
  throw as a denial).

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose             | Command                                                                                                                                                        | Expected |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Install             | `pnpm install`                                                                                                                                                 | exit 0   |
| Build deps          | `pnpm --filter "@lunora/storage..." run build` and `pnpm --filter "@lunora/codegen..." run build`                                                              | exit 0   |
| New test file       | `pnpm --filter "@lunora/storage" exec vitest run __tests__/signed-get-authorizer.test.ts`                                                                      | all pass |
| Package tests       | `pnpm --filter "@lunora/storage" run test`, `pnpm --filter "@lunora/codegen" exec vitest run __tests__/capabilities` (if no such file exists, skip and say so) | all pass |
| Types               | `pnpm --filter "@lunora/storage" run lint:types`, `pnpm --filter "@lunora/server" run lint:types`, `pnpm --filter "@lunora/codegen" run lint:types`            | exit 0   |
| Format              | `pnpm exec oxfmt <changed .ts files>`; `pnpm exec prettier --write <changed .md/.mdx files>`                                                                   | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/storage" run lint:eslint`, same for `server`, `codegen`                                                                                | exit 0   |
| Registry sync       | `pnpm run lint:registry:sync`                                                                                                                                  | exit 0   |

**Scope.** In scope:

- `packages/storage/src/signed-get-authorizer.ts` (create)
- `packages/storage/src/index.ts` (one export line)
- `packages/storage/__tests__/signed-get-authorizer.test.ts` (create)
- `packages/server/src/http-storage.ts` (docblocks at ~270-278 and ~310-313 only)
- `registry/storage/README.md` (the recipe at lines 69-74 and its sentence)
- `packages/cli/skills/lunora-setup-storage/SKILL.md` (the sentence at lines 60-64)
- `packages/storage/docs/index.mdx` (one short paragraph + snippet where `serveStorageObject` or the
  signed-download route is described; if there is no such place, skip and say so)
- `packages/codegen/src/capabilities.ts` (add the name to the storage `bindingFreeExports`, keeping
  alphabetical order)

Out of scope: `api-snapshots/*` (the reviewer regenerates them after a full build; see §7),
`verifySignedUrl` itself, `serveStorageObject`'s code, `examples/*`, `apps/*`.

**Step 1 — install and build.** Verify: exit 0.

**Step 2 — failing tests** in `packages/storage/__tests__/signed-get-authorizer.test.ts`, importing
from `../src/signed-get-authorizer` and `../src/signed-url`. Build URLs with `buildSignedUrl`
(`baseUrl: "https://cdn.test"`, `bucketName: "default"`, `secret: "shh"`). Each test builds
`new Request(url)` and calls `authorizeSignedGet("shh", { bucketName: "default" })({ key, request })`:

1. a GET URL for key `a.png`, asked for `a.png` → `true`;
2. a PUT URL (`method: "PUT"`, `contentType: "image/png"`) for `a.png` → `false`;
3. a GET URL minted for bucket `"other"` → `false`;
4. a GET URL for `a.png` while the route resolved `b.png` → `false`;
5. a GET URL signed with a different secret → `false`;
6. `expectedHost` is forwarded: a URL minted for `https://cdn.test`, served as `https://worker.test/...`
   (rewrite the URL's host), with `{ bucketName: "default", expectedHost: "cdn.test" }` → `true`, and
   without `expectedHost` → `false`.

If `buildSignedUrl`'s option for the content type is named differently, read
`packages/storage/src/signed-url.ts:60-140` and use the real name.
Verify: the new test file fails (module not found).

**Step 3 — the helper.** Create `packages/storage/src/signed-get-authorizer.ts` with a single named
export `authorizeSignedGet`, a docblock that says why it exists (a valid signature alone admits a PUT
URL, another bucket or another key), and the four checks from §4. Add
`export { authorizeSignedGet } from "./signed-get-authorizer";` to `packages/storage/src/index.ts`
next to the signed-url export. No `.js` extension.
Verify: new test file → all pass.

**Step 4 — recipes.** Replace the one-line recipes:

- `http-storage.ts` docblocks: for a signed-URL topology pass
  `authorizeSignedGet(secret, { bucketName })` from `@lunora/storage`; a bare `.valid` check admits
  an upload URL, another bucket or another key.
- `registry/storage/README.md` recipe:
  `return serveStorageObject(ctx, key, request, authorizeSignedGet(env.STORAGE_SIGNING_SECRET, { bucketName: "default" }));`
  with `import { authorizeSignedGet } from "@lunora/storage";` (use the bucket name the registry
  item's `storage.ts` mints with; read `registry/storage/storage.ts` to confirm it is `"default"`,
  otherwise use the real one). Add one sentence on why `.valid` alone is not enough.
- `SKILL.md` sentence: pass `authorizeSignedGet(secret, { bucketName })` as the gate.
- `packages/storage/docs/index.mdx`: a short paragraph with the same snippet.
- `capabilities.ts`: add `"authorizeSignedGet"` to the storage `bindingFreeExports`.

Verify: `grep -rn "verifySignedUrl(new URL(r.url)" registry packages/server/src packages/cli/skills`
prints nothing; `grep -rn "authorizeSignedGet" registry/storage/README.md packages/server/src/http-storage.ts packages/cli/skills/lunora-setup-storage/SKILL.md packages/codegen/src/capabilities.ts`
prints at least one line per file.

**Step 5 — red without the fix (mandatory).** Commit (Step 7). Then change the helper's body to
`return verdict.valid` only (a deliberate break), run the new test file, confirm tests 2, 3 and 4
FAIL, then restore with `git checkout -- packages/storage/src/signed-get-authorizer.ts` and confirm
`git status --short` is clean.

**Step 6 — gates.** Format, lint, types (storage, server, codegen), storage tests, registry sync.
Verify: all exit 0.

**Step 7 — commit.** Stage the in-scope files by path. Message:

```
security(storage): add authorizeSignedGet for serveStorageObject

The documented serveStorageObject gate checked verifySignedUrl(...).valid
only, which admits an upload URL, a URL for another bucket, or one for another
key. authorizeSignedGet also requires method GET, the route's key and the
expected bucket; the server docblock, the registry item and the setup skill
now use it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

`authorizeSignedGet` is a binding-free helper (pure WebCrypto via `verifySignedUrl`), listed in the
storage capability's `bindingFreeExports`; it adds no `ctx.*` surface and needs no host contract. Same
mapping as `verifySignedUrl` on every target. No `PlatformCapabilities` row changes.

## 7. Phasing & ordering

| Phase                       | Work          | Gate                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 (executor)                | Steps 1-7     | tests red with the broken helper; storage/server/codegen types and lint green                                                                                                                                                                                         |
| 1 (reviewer, then executor) | API snapshots | reviewer runs a full `pnpm run build:packages` in the worktree, then asks the executor to run `pnpm run api:update`, confirm only `api-snapshots/storage.api.md` and `api-snapshots/codegen.api.md` change, and commit them as `chore(storage): update api snapshots` |

## 8. Risks & STOP conditions

- **STOP** on drift or excerpt mismatch.
- **STOP** if `@lunora/storage` already exports a helper that performs these checks (search
  `packages/storage/src` for `method === "GET"` first).
- **STOP** if `scripts/check-skill-mirrors.js` (run by `pnpm install`) fails after you edit
  `SKILL.md`.
- **STOP** if a codegen test asserts the exact `bindingFreeExports` list and fails; report it, do not
  edit that test unless it is a snapshot of this exact list (then update it and say so).
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

1. A matching PUT helper for the hand-written upload route is a natural follow-up; not in this plan.

## Done criteria (all must hold)

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only §5 in-scope files (plus, after phase 1, the two snapshots).
- [ ] `grep -n "authorizeSignedGet" packages/storage/src/index.ts` prints one line.
- [ ] Six new tests pass; tests 2-4 failed with the deliberate break (Step 5).
- [ ] storage tests, storage/server/codegen `lint:types` and `lint:eslint`, `lint:registry:sync` exit 0.
- [ ] One commit with the message above (phase 1 adds a second).
