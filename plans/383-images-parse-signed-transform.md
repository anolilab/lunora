# Plan 383: Export `parseSignedTransform` so verified image-transform strings round-trip to `TransformOptions`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/bindings/src/images`
> On any drift, compare the "Current state" excerpts against live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (same branch as 381/382; independent commit)
- **Category**: bug / dx
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`verifySignedImageUrl` verifies the HMAC over a serialized transform string and hands the caller back only the **raw string**, with a contract comment saying the Worker "should apply exactly this (verified) transform via `ctx.images.transform(...)`" — which takes a `TransformOptions` object. No deserializer exists, so every app must hand-write the inverse of `serializeTransform` (split on `&`, split on first `=`, guess which values are numbers/booleans/JSON). A mis-parse silently un-binds the transform the signature protects — dropping a `width` renders full-size, the exact "ask for a larger render than the caps allow" attack the signing exists to close. The library should ship the inverse of its own encoder.

## Current state

- `packages/bindings/src/images/signed-delivery-url.ts:26-36` — the encoder:
    ```ts
    const serializeTransform = (transform: TransformOptions | undefined): string => {
        if (transform === undefined) {
            return "";
        }
        return Object.entries(transform)
            .filter(([, value]) => value !== undefined)
            .toSorted(([a], [b]) => (a > b ? 1 : 0) - (a < b ? 1 : 0))
            .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
            .join("&");
    };
    ```
- Same file (~:135-143) — `verifySignedImageUrl`'s result type carries `transform?: string` ("The raw, verified transform string (the `t` query value), when present").
- `TransformOptions` — read its declaration (grep `TransformOptions` in `packages/bindings/src/images/`) to enumerate value kinds: numbers, strings, booleans, and object-valued keys (e.g. gravity coordinates). The parser's per-key typing comes from that type, not from guessing.
- Check the barrel `packages/bindings/src/images/index.ts` for the export list; `parseSignedTransform` goes there as a named export.

## Commands you will need

| Purpose    | Command                                            | Expected on success                                        |
| ---------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Install    | `pnpm install`                                     | exit 0                                                     |
| Build deps | `pnpm --filter "@lunora/bindings..." run build`    | exit 0                                                     |
| Tests      | `pnpm --filter "@lunora/bindings" run test`        | all pass                                                   |
| Typecheck  | `pnpm --filter "@lunora/bindings" run lint:types`  | exit 0                                                     |
| Lint       | `pnpm --filter "@lunora/bindings" run lint:eslint` | exit 0                                                     |
| API gate   | `pnpm run build:packages && pnpm run api:check`    | exit 0 (`api:update` + commit snapshot for the new export) |

## Scope

**In scope**:

- `packages/bindings/src/images/signed-delivery-url.ts`
- `packages/bindings/src/images/index.ts` (export)
- `packages/bindings/__tests__/images/` (extend the signed-delivery-url test file)

**Out of scope**:

- The signature canonical — the raw string stays what is signed; parsing happens after verification.
- `serializeTransform` itself — do not change the encoding (existing signed URLs in the wild must keep verifying).

## Git workflow

- Branch: `improve/wave22-bindings`
- Commit: `feat(bindings): parse verified image transform strings`

## Steps

### Step 1: Write the exact inverse

`parseSignedTransform(t: string): TransformOptions` in `signed-delivery-url.ts`:

- `""` → `{}`;
- split on `&`, each part on the FIRST `=` only;
- per key, coerce by `TransformOptions`' declared type: values that `JSON.parse` cleanly as objects (starts with `{`/`[`) → parsed; `"true"`/`"false"` for boolean keys; numeric strings for number keys (`Number(...)` + `Number.isFinite` check); everything else stays a string;
- an unknown key or an uncoercible value throws a `TypeError` naming the key (fail loud — a verified string that doesn't parse means encoder/decoder drift, never user input, since the HMAC already passed).

Prefer a small per-key kind table derived from reading `TransformOptions` over generic sniffing where the type makes values ambiguous (e.g. a string key whose value looks numeric).

### Step 2: Return it from `verifySignedImageUrl`

Add `transformOptions?: TransformOptions` beside the existing raw `transform` in the result (populate only when `valid && transform !== undefined`; a parse failure on a VERIFIED string should surface as a thrown `TypeError`, not `valid: false` — the signature was genuine, the library drifted).

**Verify**: `pnpm --filter "@lunora/bindings" run lint:types` → exit 0.

### Step 3: Tests

In the existing signed-delivery-url test file (`packages/bindings/__tests__/images/`):

- round-trip property: for a representative `TransformOptions` (number + string + boolean + object-valued key), `parseSignedTransform(serializeTransform(x))` deep-equals `x`;
- `""` → `{}`;
- value containing `=` (e.g. a string option with base64 padding, if `TransformOptions` has any string key) survives the first-`=` split;
- `verifySignedImageUrl` on a signed URL returns matching `transformOptions`;
- unknown key throws.

**Verify**: `pnpm --filter "@lunora/bindings" run test` → all pass, 5 new tests.

## Test plan

Covered in Step 3; model on the existing sign/verify tests in the same file.

## Done criteria

- [ ] `parseSignedTransform` exported from the images barrel
- [ ] Round-trip test passes
- [ ] All commands in the table exit 0, api snapshot updated
- [ ] No files outside the in-scope list modified

## STOP conditions

- `TransformOptions` contains a key whose serialized form is ambiguous to invert (two types sharing one representation) — report the key rather than guessing; the fix may need a versioned encoding, which is out of scope.

## Maintenance notes

- Encoder and parser MUST evolve together — add a comment on both pointing at each other and at the round-trip test. Reviewer: check every `TransformOptions` key kind is covered by the round-trip test's fixture.
