# Plan 539 — Bind the scheduler-dispatch HMAC to a timestamp and the forwarded identity

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):**
> `git diff --stat 4a7c48bfd..HEAD -- shared/scheduler-dispatch.ts packages/scheduler/src/scheduler-do.ts packages/runtime/src/create-worker.ts packages/platform-node/src/node-dispatch-route.ts packages/scheduler/__tests__/scheduler-do.test.ts packages/platform-node/__tests__/node-dispatch-route.test.ts packages/scheduler/__bench__/sign-dispatch.bench.ts packages/errors/src/hints.ts`
> must print nothing. Then confirm the excerpts in §1 match. Any mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** DONE (review APPROVED after 1 revision; branch `security/improve-539-scheduler-dispatch-signature`, commits 453db6d3b + 4ce724b43 (platform-node snapshot); api:check clean; scheduler + runtime workerd projects green; not merged — ship SchedulerDO and Worker together)
**Priority / effort / risk:** P1 / S-M / MED. **Category:** security. **Depends on:** none.

## 0. Headline finding

The scheduler's dispatch request to the app (`POST /_lunora/scheduler/dispatch`) is authenticated by
an HMAC over the **body only**. Two things the receiver trusts are outside the signature:

1. **Time.** A captured signed request stays valid forever. The only replay damper is the shard's
   mutation-id idempotency row (24 h, and only when the body carries an `id`).
2. **The forwarded identity.** After verifying, both receivers read `x-lunora-userid` and
   `x-lunora-identity` from the request headers and forward them to the shard together with
   `x-lunora-system: 1`, so the job runs with system privileges under that user's RLS context. Those
   headers are not signed, so a holder of one signed request can attach any identity to it.

The fix signs a canonical string of a version tag, a timestamp, both identity header values and the
body; the receiver refuses a signature outside a time window.

## 1. Current state (audit)

- `shared/scheduler-dispatch.ts` (zero-dependency helper inlined by the bundler into the hosts),
  lines 81-97:

    ```ts
    /**
     * Authenticate a scheduler dispatch request.
     *
     * A signature the scheduler computed over the exact `rawBody` wins when both the
     * header and the secret are present. Otherwise the admin bearer is the credential.
     * ...
     */
    const verifySchedulerDispatch = async (request: Request, rawBody: string, credentials: SchedulerDispatchCredentials): Promise<boolean> => {
        const signature = request.headers.get("x-lunora-scheduler-signature");
        const { schedulerSecret } = credentials;

        if (signature !== null && signature.length > 0 && schedulerSecret !== undefined && schedulerSecret.length > 0) {
            return constantTimeEqual(await signCanonical(schedulerSecret, rawBody), signature);
        }

        return checkBearerToken(request, credentials.adminToken);
    };
    ```

    `SchedulerDispatchCredentials` (lines 74-79) is `{ adminToken; schedulerSecret }`.

- **The only HMAC signer** is `SchedulerDO` in `packages/scheduler/src/scheduler-do.ts`:
    - lines 988-994 inside `dispatch()` (inside a `try`, so it runs on **every** attempt, including retries):

        ```ts
        const signature = await this.signDispatch(body);

        if (signature !== undefined) {
            headers["x-lunora-scheduler-signature"] = signature;
        } else if (typeof this.env.LUNORA_ADMIN_TOKEN === "string" && this.env.LUNORA_ADMIN_TOKEN.length > 0) {
            headers.authorization = `Bearer ${this.env.LUNORA_ADMIN_TOKEN}`;
        }
        ```

    - lines 1583-1599, `private async signDispatch(body: string)`: returns `signCanonical(secret, body)`
      or `undefined` when `LUNORA_SCHEDULER_SECRET` is unset.
    - `SchedulerDO` never sends `x-lunora-userid` / `x-lunora-identity`.
- The **bearer** senders, which this plan does NOT change: `@lunora/dispatch`
  (`packages/dispatch/src/create-dispatch-runner.ts:400-420`, sends the admin bearer and, when given,
  the identity headers), `@lunora/queue` (`packages/queue/src/capture.ts:154`), `@lunora/workflow`.
  Holding the admin bearer is full trust, so forwarding identity on that path is by design.
- Receivers (both call the shared verifier, then read the unsigned headers):
    - `packages/runtime/src/create-worker.ts:4152` `verifySchedulerDispatch(request, rawBody, { adminToken: adminBearer, schedulerSecret })`
      and `:4238` `const identity = readForwardedDispatchIdentity(request);`
    - `packages/platform-node/src/node-dispatch-route.ts:86-89` the same call, and `:134`
      `identity: readForwardedDispatchIdentity(request)`.
- `shared/system-dispatch-headers.ts:76-89` `readForwardedDispatchIdentity` returns the raw header
  strings; `:38-62` `buildSystemDispatchHeaders` forwards them to the shard next to `x-lunora-system: 1`.
- Existing tolerance pattern to mirror: `packages/payment/src/webhook.ts:128-141`
  (`toleranceSeconds ?? 300`, `now` injectable, `Math.abs(now - timestamp) > tolerance` refuses).
- Tests that pin today's format and must be updated (not deleted):
    - `packages/scheduler/__tests__/scheduler-do.test.ts:1332-1352` (signature header present) and
      `:1354-1384` ("imports the HMAC key once and signs every dispatch with it": recomputes the
      expected signature over `call.body` at ~line 1376 and compares at 1383).
    - `packages/platform-node/__tests__/node-dispatch-route.test.ts:76-96` (signs `payload` with
      `signCanonical(SECRET, payload)` and posts it with the header).
    - `packages/scheduler/__bench__/sign-dispatch.bench.ts` signs a bare body.
- `packages/errors/src/hints.ts:185-186` — the `DISPATCH_UNAUTHENTICATED` hint; its text is copied
  into `apps/docs/src/content/docs/errors.mdx` by `apps/docs/scripts/generate-error-reference.js`.

## 2. Existing seams (do not reinvent)

- `signCanonical(secret, canonical)` in `shared/hmac-url.ts` (memoized key import) and
  `constantTimeEqual` in `shared/constant-time-equal.ts`. Sign and compare with these only.
- `shared/scheduler-dispatch.ts` stays zero-dependency: relative imports only, named exports only,
  no `.js` extensions, no `@lunora/*` import.

## 3. The behavioural contract to preserve

- The bearer path (`authorization: Bearer <admin token>`) is unchanged, including identity forwarding.
- `verifySchedulerDispatch` still returns a boolean and never throws; each receiver keeps its own
  `DISPATCH_UNAUTHENTICATED` 403 (retryable by consumers).
- A retry re-signs with a fresh timestamp (it already re-signs on every `dispatch()` call; keep it so).
- With `LUNORA_SCHEDULER_SECRET` unset nothing about signing changes.

## 4. Design decisions

- **Canonical string:** `["v1", String(timestamp), userId ?? "", identity ?? "", body].join("\n")`,
  where `userId` / `identity` are the exact `x-lunora-userid` / `x-lunora-identity` header values
  (absent → empty string). Header values cannot contain a raw newline, so `\n` separates the fixed
  fields unambiguously, and the body is last so its own newlines cannot shift a field. Chosen over
  signing only the body plus refusing identity headers on the HMAC path (works today, but the next
  sender that needs an identity would have to redesign the format).
- **Timestamp:** epoch milliseconds as a base-10 integer string in a new header
  `x-lunora-scheduler-timestamp`. Refuse when the header is missing, not a safe integer, or
  `Math.abs(now - timestamp) > SCHEDULER_SIGNATURE_TOLERANCE_MS` (5 minutes, `5 * 60_000`).
- **Injectable clock:** add optional `now?: () => number` to `SchedulerDispatchCredentials`
  (default `Date.now`) so tests never sleep.
- **One change, both sides** (alpha branch, no dual format): the sender and both receivers switch in
  the same commit. A deployment must ship the scheduler DO and the Worker together; note this in the
  commit body.
- **What remains after this plan** (say it in the commit body, plainly): a captured signed request
  can still be replayed, unchanged, within the 5-minute window; the shard's mutation-id dedupe covers
  replays of jobs that carry an `id`. Rotating `LUNORA_SCHEDULER_SECRET` is unaffected.

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose               | Command                                                                                                                                                                               | Expected    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Install               | `pnpm install`                                                                                                                                                                        | exit 0      |
| Build deps            | `pnpm --filter "@lunora/runtime..." run build` then `pnpm --filter "@lunora/platform-node..." run build` then `pnpm --filter "@lunora/scheduler..." run build`                        | exit 0 each |
| Scheduler test file   | `pnpm --filter "@lunora/scheduler" exec vitest run __tests__/scheduler-do.test.ts`                                                                                                    | all pass    |
| Node route test file  | `pnpm --filter "@lunora/platform-node" exec vitest run __tests__/node-dispatch-route.test.ts`                                                                                         | all pass    |
| Runtime new test file | `pnpm --filter "@lunora/runtime" exec vitest run __tests__/scheduler-dispatch-signature.test.ts`                                                                                      | all pass    |
| Package tests         | `pnpm --filter "@lunora/scheduler" run test`, `pnpm --filter "@lunora/platform-node" run test`, `pnpm --filter "@lunora/runtime" run test`, `pnpm --filter "@lunora/errors" run test` | all pass    |
| Types                 | `pnpm --filter "@lunora/<pkg>" run lint:types` for scheduler, platform-node, runtime, errors                                                                                          | exit 0      |
| Format                | `pnpm exec oxfmt <every changed .ts file>` then `pnpm exec prettier --write apps/docs/src/content/docs/errors.mdx`                                                                    | exit 0      |
| Lint (after format)   | `pnpm --filter "@lunora/<pkg>" run lint:eslint` for scheduler, platform-node, runtime, errors                                                                                         | exit 0      |
| Regenerate error docs | `node --experimental-strip-types apps/docs/scripts/generate-error-reference.js`                                                                                                       | exit 0      |

**Scope.** In scope (the only files you may modify or create):

- `shared/scheduler-dispatch.ts`
- `packages/scheduler/src/scheduler-do.ts` (`dispatch()` header block and `signDispatch` only)
- `packages/runtime/src/create-worker.ts` (only the docblock of `handleSchedulerDispatch`, ~lines 4121-4137, if it describes the signature; no logic change is needed there because it calls the shared verifier)
- `packages/platform-node/src/node-dispatch-route.ts` (only if a docblock describes the format; no logic change expected)
- `packages/scheduler/__tests__/scheduler-do.test.ts`
- `packages/platform-node/__tests__/node-dispatch-route.test.ts`
- `packages/runtime/__tests__/scheduler-dispatch-signature.test.ts` (create)
- `packages/scheduler/__bench__/sign-dispatch.bench.ts`
- `packages/errors/src/hints.ts` (the `DISPATCH_UNAUTHENTICATED` hint) and the regenerated
  `apps/docs/src/content/docs/errors.mdx`

Out of scope: `packages/dispatch`, `packages/queue`, `packages/workflow` (bearer senders),
`shared/system-dispatch-headers.ts`, `shared/hmac-url.ts`, the shard (`packages/do`), any SDK.

**Step 1 — install and build.** Verify: each command exits 0.

**Step 2 — shared helper.** In `shared/scheduler-dispatch.ts`:

- add `const SCHEDULER_SIGNATURE_HEADER = "x-lunora-scheduler-signature";`,
  `const SCHEDULER_TIMESTAMP_HEADER = "x-lunora-scheduler-timestamp";`,
  `const SCHEDULER_SIGNATURE_TOLERANCE_MS = 5 * 60_000;`
- add `schedulerDispatchCanonical(input: { body: string; identity?: string; timestamp: number; userId?: string }): string`
  returning the §4 join.
- add `signSchedulerDispatch(secret: string, input: same shape): Promise<string>` →
  `signCanonical(secret, schedulerDispatchCanonical(input))`.
- extend `SchedulerDispatchCredentials` with `now?: () => number`.
- rewrite the HMAC branch of `verifySchedulerDispatch`: read the timestamp header; refuse (return
  `false`) when it is missing, does not match `/^\d+$/u`, is not a safe integer, or is outside the
  tolerance against `(credentials.now ?? Date.now)()`; otherwise compare
  `await signSchedulerDispatch(secret, { body: rawBody, identity: <x-lunora-identity header or undefined>, timestamp, userId: <x-lunora-userid header or undefined> })`
  with the signature using `constantTimeEqual`.
- update the docblock to say what is signed and why (one short paragraph), and export the new names
  in the existing named `export { … }` list (alphabetical, as it is now).

Verify: `grep -n "SCHEDULER_TIMESTAMP_HEADER\|schedulerDispatchCanonical\|SCHEDULER_SIGNATURE_TOLERANCE_MS" shared/scheduler-dispatch.ts`
shows the definitions and the export list.

**Step 3 — failing receiver tests.** Update `node-dispatch-route.test.ts`:

- the "accepts an HMAC over the exact body" test now signs with
  `signSchedulerDispatch(SECRET, { body: payload, timestamp: NOW })`, sends both headers, and builds
  the route with `now: () => NOW` (if `createNodeDispatchRoute` cannot take `now`, see STOP below).
- add: "refuses a signature older than the tolerance" (timestamp `NOW - SCHEDULER_SIGNATURE_TOLERANCE_MS - 1`);
  "refuses a signed request with an added x-lunora-userid header" (sign without identity, send with
  `x-lunora-userid: "u2"`); "refuses a signature without a timestamp header"; and
  "accepts a signature that covers the forwarded identity" (sign with `userId: "u1"`, send the same
  header) asserting `invoke` received `identity: { userId: "u1" }`.
- keep "refuses a signature computed over a different body".

Create `packages/runtime/__tests__/scheduler-dispatch-signature.test.ts`, modelled on
`packages/runtime/__tests__/scheduled-workpool.test.ts` (its `okShard()`, `fakeContext`, and
`dispatch()` helpers; copy what you need). Build the worker with
`createWorker({ shardDO: <a shard namespace that records the forwarded request headers> })` and pass
`{ LUNORA_SCHEDULER_SECRET: SECRET }` as `env`. Tests: a fresh signature → 200 and the shard sees no
`x-lunora-userid`; a signature with an added `x-lunora-userid` header → 403; a stale timestamp → 403.
To make "fresh" deterministic, spy `Date.now` with `vi.spyOn(Date, "now").mockReturnValue(NOW)` and
restore it in `finally` (the runtime does not take `now` from options).

Verify: the node-route and runtime test files → the new refusal tests FAIL before Step 4 because the
receiver still checks the body-only HMAC (the accept tests may fail too; note which).

**Step 4 — receivers.** `node-dispatch-route.ts` and `create-worker.ts` call
`verifySchedulerDispatch` already; they need no logic change. If `createNodeDispatchRoute`'s options
type must carry `now` for the test, add an optional `now?: () => number` to its options and pass it
through to the credentials — this IS in scope (it is the same file). Update any docblock in either
file that says the signature covers "the exact body" so it names the canonical string instead.
Verify: node-route and runtime test files → all pass.

**Step 5 — sender.** In `scheduler-do.ts`, change `signDispatch(body)` to
`signDispatch(body: string, timestamp: number)` returning `signSchedulerDispatch(secret, { body, timestamp })`,
and in `dispatch()` compute `const timestamp = Date.now();` right before signing (inside the same
`try`), set both `x-lunora-scheduler-signature` and `x-lunora-scheduler-timestamp` (use the exported
constants). Keep the comment explaining why signing happens inside the `try`. Import the helpers from
`../../../shared/scheduler-dispatch` (no extension).
Update `scheduler-do.test.ts`: the "posts … with an HMAC signature header" test also asserts the
timestamp header is a decimal string; the "imports the HMAC key once…" test recomputes the expected
signature over `schedulerDispatchCanonical({ body: call.body, timestamp: Number(call.headers.get("x-lunora-scheduler-timestamp")) })`
using the same raw `crypto.subtle` key it already builds. Add "re-signs a retried dispatch with a
fresh timestamp": make the first fetch answer 500 and the second 200, advance `Date.now` (spy)
between the two alarms, and assert the two timestamp headers differ and each signature verifies.
Verify: scheduler test file → all pass.

**Step 6 — bench and hint.** In `sign-dispatch.bench.ts` sign `schedulerDispatchCanonical({ body, timestamp: 1_700_000_000_000 })`
in the "new" case so the bench measures what ships. In `hints.ts`, append to the
`DISPATCH_UNAUTHENTICATED` hint: "A signed dispatch is also refused when the scheduler's and the
worker's clocks differ by more than five minutes." Run the regenerate-error-docs command, then the
docs format command.
Verify: `git diff --stat` shows `apps/docs/src/content/docs/errors.mdx` changed by that sentence only.

**Step 7 — red without the fix (mandatory).** Commit (Step 9), then
`git diff 4a7c48bfd..HEAD -- shared/scheduler-dispatch.ts | git apply -R` and run the node-route test
file: the stale-timestamp and added-identity tests must FAIL (they may fail to compile because the new
helpers are gone; that counts only if the failure is in those tests' file — report exactly what you
saw). Restore with `git checkout -- shared/scheduler-dispatch.ts`; confirm `git status --short` is clean.

**Step 8 — gates.** Format, lint and types for scheduler, platform-node, runtime, errors; the four
package test suites. Verify: all exit 0.

**Step 9 — commit.** Stage every in-scope file you changed, by path. Message:

```
security(scheduler): sign dispatch time and forwarded identity

The scheduler's dispatch HMAC covered the body only: a captured request stayed
valid forever, and the x-lunora-userid / x-lunora-identity headers both hosts
forward to the shard with x-lunora-system were unsigned. The signature now
covers a version tag, a timestamp header, both identity values and the body,
and the Worker and Node receivers refuse it outside a 5-minute window.

Wire change: ship the SchedulerDO and the Worker together. A captured request
can still be replayed unchanged inside the window; jobs with an id are deduped
by the shard's mutation-id row.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

No new `ctx.*` surface or binding. The change is to an existing host contract (the scheduler dispatch
route) on both hosts that serve it: `cloudflare` (`create-worker.ts`) and `node`
(`node-dispatch-route.ts`); both call the one shared verifier, so they cannot diverge. No
`PlatformCapabilities` row changes.

## 7. Phasing & ordering

| Phase        | Work      | Gate                                                                              |
| ------------ | --------- | --------------------------------------------------------------------------------- |
| 0            | Steps 1-9 | refusal tests red without the fix; four packages' tests, types, lint green        |
| 1 (reviewer) | workerd   | reviewer runs the `workerd` projects of `@lunora/scheduler` and `@lunora/runtime` |

## 8. Risks & STOP conditions

- **STOP** on drift or excerpt mismatch.
- **STOP** if you find another production caller that sends `x-lunora-scheduler-signature`
  (`grep -rn "scheduler-signature" packages/*/src shared` must show only the files in §1).
- **STOP** if any test outside the three test files in scope fails because of the format change
  (e.g. an e2e or a workerd fixture that signs by hand) — report the file; do not edit it.
- **STOP** if `createNodeDispatchRoute`'s options are built somewhere outside
  `node-dispatch-route.ts` in a way that would need a change in another file to pass `now`.
- **Risk:** clock skew between the scheduler DO and the Worker. Both run on Cloudflare's clock; 5
  minutes is the payment webhook's tolerance. Mitigation: the new hint names it.
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

1. (Owner) Should the receiver also refuse the identity headers on the HMAC path when no sender ever
   signs them? With this plan they are allowed only when signed, which is strictly tighter than today.

## Done criteria (all must hold)

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only files from the §5 scope list.
- [ ] `grep -rn "signCanonical(schedulerSecret, rawBody)" shared/` prints nothing.
- [ ] `grep -n "x-lunora-scheduler-timestamp\|SCHEDULER_TIMESTAMP_HEADER" packages/scheduler/src/scheduler-do.ts` prints at least one line.
- [ ] New refusal tests (stale, added identity, missing timestamp) exist in the node-route and runtime
      test files and pass; they failed with the shared verifier reverted (Step 7).
- [ ] scheduler, platform-node, runtime, errors: `test`, `lint:types`, `lint:eslint` exit 0.
- [ ] One commit with the message above.
