# Plan 477 — Per-project egress allowlist for tenant Workers, enforced in the dispatch namespace's Outbound Worker

**Baseline:** `origin/feat/cloud-platform-dx` @ `1d8f444fe` (2026-10-11)
**Status:** BLOCKED on account access — Workers for Platforms is not enabled on the Lunora account, so the Phase 0 probe cannot run (§5). Default: opt-in, default-open for every project, with a report-first flow.

## 0. Headline finding

A tenant Worker on Workers for Platforms can `fetch()` any host on the internet. Nothing in Lunora Cloud, and nothing in the
framework, lets an org say "this app may call these hosts only". The Outbound Worker that sits on every tenant `fetch()` already
exists and already disables raw `connect()`. It has no policy, so it is the natural enforcement point, and it is the only one that
sees every outbound call.

Size: **M–L**. The enforcement is small; the policy plumbing, the probe and the per-target story are the bulk.

## 1. Current state (audit)

- `apps/cloud/src/outbound/worker.ts:20-24` — the Outbound Worker's only job is to stamp lineage. It calls `stampLineage` (`:22`)
  and has no other bindings; it cannot read tenant policy or call the control plane.
- `apps/cloud/outbound.wrangler.jsonc:14` — "no bindings and no vars of its own".
- `apps/cloud/src/dispatcher/worker.ts:488` —
  `env.DISPATCHER.get(route.scriptName, undefined, { limits, outbound: { lineage: … } })`. The `outbound` options object is the
  existing channel to the Outbound Worker.
- `apps/cloud/dispatcher.wrangler.jsonc:20, 55, 73` — each namespace's `outbound` service and `parameters: ["lineage"]`
  declaration. Any new parameter must be declared in every environment.
- `grep -ri egress apps/cloud/src` finds nothing policy-related. The framework's only egress controls are container-scoped
  (`packages/container/src/types.ts:130-138`: `allowedHosts`), and there is no `network` key for Workers.
- Plan 365 (§2.3) records the limit: Durable Object stubs and direct service bindings do not pass through `fetch()`.

## 2. Existing seams (do not reinvent)

- **The per-request policy channel already exists.** `ScriptFacts` is served by `/v1/tenants/plan` and cached per isolate
  (`apps/cloud/src/targets/cloudflare-wfp/route.ts:24-28`, `:215`). An egress policy is one more per-script fact.
- **The `outbound` parameter channel is already used** for `lineage`. A second parameter follows the same declaration shape.
- `limitsForPlan` (`billing/plans`) is the model for "a plan-dependent value computed in the dispatcher, applied in the call".

## 3. The behavioural contract to preserve

- A project with no egress policy behaves exactly as today.
- A `fetch()` to an allowed origin is unchanged in method, headers and body.
- A denied `fetch()` returns `403` with `{ "error": "egress_denied", "origin": "<origin>" }` and never reaches the network.
- A redirect to a denied origin never reaches the network, whichever hop it is on.
- Raw sockets (`connect()`) stay disabled.
- Changing the policy does not require a deploy (it is not in the release manifest).
- The lineage contract (`apps/cloud/src/dispatcher/lineage.ts`) is unchanged.

## 4. Design decisions

1. **Default-open for every project, new ones included. Enforcement is opt-in, and the first step is observation.**
   _Decided, replacing the earlier "default-deny later" note._ Lunora apps call third-party APIs (payments, mail, model
   providers, the customer's own systems). A default-deny, even for new projects only, breaks the first deploy of exactly the
   apps that most need care, and the failure looks like an outage in the user's app. The best DX is to make the safe state
   reachable in one click, with the list built from evidence:
    - **`off`** (default): no policy, no recording.
    - **`report`**: the dispatcher lets every request through and records each destination origin with a count. Nothing is
      refused, so nothing breaks.
    - **`enforce`**: the recorded origins plus the platform origins are the allowlist; everything else gets the 403.

    The studio's egress card starts in `report` as soon as the owner turns the feature on, shows the observed origins with counts,
    and offers "enforce these N origins" as the single action. Removing an origin from the list is a plain edit. Denials are
    visible in logs with the origin named, so a missing entry is one click to fix, not a support ticket.
    _Rejected:_ default-deny for new projects. It is the stronger position on paper, but it moves the cost onto every new user's
    first deploy. A later plan can revisit it once the data shows how many projects reach `enforce` on their own.

2. **The policy travels as a second `outbound` parameter. Unsigned, unless Phase 0 Q5 says tenants can reach it.** The dispatcher
   computes `{ v, mode, origins: string[] }` and passes it in the `outbound` options. The parameter goes from the dispatcher to the
   Outbound Worker directly, not through tenant traffic. Lineage needs a signature because its header round-trips through tenant
   requests; this value does not. If Q5 shows a tenant can set or read an outbound parameter, sign it the way lineage is signed.
   _Rejected:_ the Outbound Worker calling the control plane per fetch (a network hop and a new failure mode per call); a KV
   lookup in the Outbound Worker (a new binding and a second source of truth).
3. **Exact origin matching, `https` only by default.** An origin is `scheme://host[:port]`, compared exactly, host case-folded.
   Paths, userinfo and wildcards are rejected at write time. `http://` is allowed only when listed explicitly.
4. **The Outbound Worker performs the upstream request itself and walks redirects.** It calls `fetch` with `redirect: "manual"`,
   reads each `Location`, checks the next origin, and repeats up to 5 hops, then returns the final response. A denied hop stops the
   walk with the 403 body. A tenant that asked for manual redirects receives the 3xx, checked before it is returned. Phase 0 Q2 only
   establishes whether the tenant's runtime re-enters the Outbound Worker when it follows a redirect itself; if it does, that is a
   second check.
5. **Platform calls are exempt by origin, from the platform's own list.** Telemetry export (`LUNORA_OTLP_ENDPOINT`; plan 458 has an
   open item to verify OTLP egress from a celld isolate) and the AI proxy (`LUNORA_AI_PROXY_URL`) are platform origins. The dispatcher
   adds them to every computed policy, in every mode.
6. **Per-target, honest about unsupported.** The control exists only where an Outbound Worker exists. The BYO-Cloudflare target has no
   dispatcher or Outbound Worker, so the studio says "not enforced here" rather than show a control that does nothing.

## 5. Workstreams

**Phase 0 — result (2026-10-11): BLOCKED on the account, not on the design.** The Lunora Cloudflare account has no Workers for Platforms. `wrangler dispatch-namespace list` returns error 10121 ("You do not have access to dispatch namespaces"), and every question below needs a dispatch namespace and the Outbound Worker on it. Nothing was run. Unblock by enabling Workers for Platforms on the account (dashboard), or by pointing the probe at an account that has it. Q5 has no non-WfP route.

**Phase 0 — probe (S, a real staging account, once WfP is available).** Five questions, each answer recorded in this file:

- Q1: can an `outbound` parameter carry a structured object, or only a string? What is the size limit?
- Q2: when a tenant follows a redirect it received, does that second request pass through the Outbound Worker again?
- Q3: does an `outbound` service receive a request for a `fetch()` that a tenant makes to its own dispatch-namespace sibling?
- Q4: does a denied `fetch()` ever leave the platform? (Expected: no.)
- Q5: can a tenant Worker set or read an `outbound` parameter? (Expected: no. A yes changes §4.2 to a signed value.)

**A. Policy model and API (M).** Store `{ mode, origins }` on the project (JSON column, or a table if edge-rule storage is the better
precedent; decide by reading how edge rules are stored). Control-plane endpoints to read and replace it, with owner/admin
authorization and an audit row. A `GET …/egress/observed` endpoint returns the origins recorded in `report` mode with counts.
Origin validation is shared with the dispatcher.

**B. Dispatcher parameter and recording (S).** Extend `ScriptFacts` with an optional `egress` field, populate it from the control
plane, add the platform origins from §4.5, and pass it in the `outbound` options. Declare the parameter in `dispatcher.wrangler.jsonc`
for every environment (plan 475 §5B's conformance test covers this). In `report` mode the Outbound Worker records origins; the recording
goes through `PLATFORM_METRICS` (counts per origin per script), not per-request writes.

**C. Outbound enforcement (M).** Parse the target URL, check the origin, perform the upstream request with manual redirects, walk the hops as
§4.4 describes, return the JSON 403 on denial, otherwise return the response unchanged. Add
`apps/cloud/__bench__/dispatcher-outbound.bench.ts` (the only bench today is `box-session.bench.ts`).

**D. Studio: observe, then enforce (S).** The egress card: a mode control; in `report` mode, the observed-origin table with counts and
an "enforce these N origins" action; in `enforce` mode, the editable list with the platform origins shown as locked; on BYO targets, a
"not enforced here" state.

**E. Docs and the matrix (S).** A page that opens with the report-first flow, then describes the enforcement and its limits (Durable
Object stubs and service bindings, per plan 365 §2.3).

## 6. Platform parity

| Feature                                                | `cloudflare-wfp`                        | `cloudflare-workers` (BYO)              | `celld-vps`                                | Notes                                                                                                          |
| ------------------------------------------------------ | --------------------------------------- | --------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Per-project `fetch()` allowlist (report, then enforce) | native (Outbound Worker, after Phase 0) | unsupported (no dispatcher or Outbound) | unsupported until celld's egress is probed | Studio shows "not enforced here" for `unsupported`. Not a framework `ctx.*` surface, so codegen is unaffected. |

## 7. Phasing & ordering

| Phase | Work                             | Gate                                                                                                                                                                           |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Probe Q1–Q5 on staging           | Answers recorded here; a STOP in §8 if Q1 or Q4 forces a different design                                                                                                      |
| 1     | A and B (report mode only)       | Unit tests: `off` is byte-identical to today; `report` forwards every request unchanged and records origins                                                                    |
| 2     | C (enforce) with a staging drill | Allowed origin reaches a test server; denied origin gets the 403 and the server sees nothing; a redirect to a denied origin is stopped at its hop; platform OTLP still exports |
| 3     | D and E                          | Studio flow reviewed end to end: enable, observe, enforce; docs reviewed                                                                                                       |

## 8. Risks & STOP conditions

- **STOP** if Q1 shows the parameter cannot carry a policy of realistic size. The fallback is a signed reference plus a read in the
  Outbound Worker, which needs its own design review.
- **STOP** if Q4 shows a denied request reaches the network. The enforcement point is wrong; re-scope before building the studio.
- **Risk:** the report window misses a host used only on a rare path (a monthly job, a webhook retry). _Mitigate:_ the studio shows
  when observation started and how many days it covers, and enforcement asks for confirmation when the window is under seven days.
- **Risk:** connector Workers (plan 480) call out through `fetch()`. Plan 480 places connectors only in namespaces with an Outbound
  Worker, so this policy covers their `fetch()` calls too.
- **Perf watch:** one `fetch()` microbenchmark on the Outbound path, before and after, in the new bench file from C.

## 9. Open questions — decided

1. **Default-open forever, or default-deny for new projects?** Decided: default-open for everyone, with an observe-then-enforce flow
   (§4.1). Default-deny is deferred until observation data shows the enforce rate.
2. **Should `http://` origins be allowed?** Decided: only when listed explicitly; `localhost` is allowed under `wrangler dev` only.
3. **Should denials count against the usage meter?** Decided: no. They appear in metrics and logs. Metering them would charge tenants
   for their own misconfiguration.
