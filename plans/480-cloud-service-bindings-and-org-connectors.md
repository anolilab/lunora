# Plan 480 — Service bindings and org-owned connectors on Workers for Platforms, with cycles refused at deploy time

**Baseline:** `origin/feat/cloud-platform-dx` @ `1d8f444fe` (2026-10-11)
**Status:** PARTIAL — the BYO service-binding path is verified on the Lunora account; the WfP path is blocked on account access (no Workers for Platforms). Plan 457 is restored and its framework side is in place. Connector ownership decided: **per org**. Workstream A shipped as a pure function, `findServiceCycle` in `apps/cloud/src/deploy/service-graph.ts`, with tests for self-loop, two-cycle, three-cycle, diamond and external edges. It is not wired: no target accepts `service` and the deploy manifest carries no service declaration, so nothing calls it. The module is marked unwired and tied to the `service` rows of `BINDING_SUPPORT`. B to E not started.

## 0. Headline finding

The framework is building typed service bindings to sibling Workers (plan 457). Lunora Cloud refuses them on every managed target. That is the right default
today, but it leaves two real needs unmet:

- an app that already ships sibling Workers cannot move them onto Lunora Cloud;
- an organisation has no way to deploy one shared integration Worker (a CRM client, an ERP client) once and bind it into several of its apps, with the
  secrets kept out of each app.

Service bindings also bypass the dispatcher and the Outbound Worker, so the loop protection for `fetch()` (`apps/cloud/src/dispatcher/lineage.ts:14-21`) does
not see them. The answer proposed is **static acyclicity**: the binding graph is declared, not computed at runtime, so a cycle is refused before anything runs.

Size: **L**. Depends on a probe that could make the design smaller or larger.

## 1. Current state (audit)

- `apps/cloud/src/provision-contract.ts:375` — the `cloudflare-wfp` row; `service: "unsupported"` at `:397`.
- `apps/cloud/src/provision-contract.ts:336` — `celld-vps` refuses `service`: "a box runs one fleet per project". A different reason from WfP's.
- `apps/cloud/src/provision-contract.ts:413-440` — `cloudflare-workers` (BYO) also marks `service` unsupported (`:433`).
- `apps/cloud/src/dispatcher/lineage.ts:19-21` — documents that service bindings escape lineage tracking.
- `packages/platform/src/capabilities/celld.ts:223-229` — celld's binding list includes "services"; the cloud's refusal is about fleet topology.
- The framework already has binding validation and manifest code that handles services (`packages/config/src/cloudflare/validate-bindings.ts`,
  `wrangler-to-alchemy.ts`). Whether plan 457's declaration format is what landed is unverified.
- `apps/cloud/src/secrets/` (`crypto.ts`, `select.ts`) is the tenant secret path.
- Plan 365 (§2.3): recursion protection "does not see DO-to-DO calls or direct service bindings".

## 2. Existing seams (do not reinvent)

- The framework's service-binding declaration and typed client (plan 457, if it landed). The cloud consumes the same manifest; it adds no second declaration.
- `buildBindingManifest` (`packages/config/src/cloudflare/binding-manifest.ts`) — the cloud's deploy manifest is built from it.
- `BINDING_SUPPORT` and `UNSUPPORTED_REASONS` (`provision-contract.ts`) — the single place a target's support is recorded. The matrix changes in the same change that enables a binding.
- `apps/cloud/src/secrets/` for connector secrets. Values never go into a staging file or a manifest.
- `lineage.ts` for the signed-depth pattern, if the static answer proves insufficient.
- The catalog install flow (plan-independent) for the install UX pattern, see §4.3.

## 3. The behavioural contract to preserve

- A project with no service bindings deploys exactly as today.
- A service binding is refused at deploy, with the reason, on any target that cannot provide it. Never silently dropped.
- A deploy whose declared service graph contains a cycle is refused before any provisioning, naming the cycle.
- A connector's secrets are never returned by any API and never appear in a manifest.
- Removing a connector grant takes effect without a code deploy.

## 4. Design decisions

1. **Services and connectors are two different things, and the loop rule differs.**
    - A **service** is a sibling Worker owned by the same project. It may call its own siblings, so cycles must be refused.
    - A **connector** is a leaf: a Worker that exposes entrypoints and holds no service bindings back to tenant Workers. It cannot call a tenant, so it
      cannot close a loop through one. Connectors need no per-call depth.
2. **Static acyclicity for services.** At deploy time, build the directed graph of declared service bindings for the project and refuse any cycle. Bindings
   are declared in config, not computed, so the check is complete for service-to-service calls.
   _Rejected:_ a runtime depth counter carried in each call (the caller computes it, so a tenant can forge it, and it cannot see a direct binding call).
   _Rejected:_ refusing service bindings on WfP entirely (safe, but leaves the migration case unmet).
3. **Connectors are owned by the org. Decided.** A connector belongs to one organisation, deployed once by an org admin, and granted to named projects in that org.
   The grant is a row, so revoking it is central and does not need a code change in each project.
   _Why per org:_ the data a connector touches (the org's CRM, its ERP credentials) is the org's. Ownership by the org is also the only model that matches the
   secrets story: the org's admin sets the secrets, and the org's projects never see them.
   _Why not platform-curated first:_ curation is a distribution question, not an ownership one. A platform-curated template can later be _installed into_ an
   org through the existing catalog flow (`apps/cloud/src/catalog/`), which produces an org-owned connector. Building curation first would mean the platform
   owns credentials it does not hold.
   _Rejected:_ binding a connector by name in each project's `wrangler.jsonc` (the org could not revoke it centrally).
4. **Connector secrets stay in the sealed store.** Set and rotate through `apps/cloud/src/secrets/`; the connector reads them through a binding it alone holds.
   Values are never listed or returned.
5. **WfP support is conditional on Phase 0.** If a dispatch-namespace Worker cannot hold a service binding to a sibling in the same namespace, the WfP row stays
   `unsupported` and only the BYO and celld paths are enabled. This is a STOP, not a workaround.
6. **UX and DX.** The developer declares a service in config and deploys; the studio shows the graph and the cycle error with the cycle named. For connectors, the
   org admin uploads once from the studio or `lunora connector deploy`, sets secrets with `lunora connector secret put NAME` (value read from stdin or a file, never
   an argument), and grants to a project with one click. Each grant shows which artifact hash it runs, so an upgrade is visible as a change.

## 5. Workstreams

**Phase 0 — result (2026-10-11): partial.**

- **BYO path, verified on the Lunora account.** A caller Worker binds a callee Worker with `services: [{ binding: "CALLEE", service: "pcheck-svc-callee", entrypoint: "CalleeApi" }]` and gets a typed RPC result (`[{"id":"c1","name":"Example"}]`). Named entrypoints work; a default export with only an RPC class fails the deploy with error 10068 ("no registered event handlers"), so the callee also needs a `fetch`. Both probe Workers were deleted afterwards.
- **WfP questions Q1 and Q2: blocked** by the account (no dispatch namespaces, error 10121). See plan 477 §5.
- **Q4 (tail attribution), answered on the BYO path:** the callee's tail logs `CalleeApi.ping - Ok` and its own `console.log`, but do not name the calling Worker. A caller must be identified by the caller's own logs or a header it passes; the callee cannot attribute the call on its own.
- **Q3 (`props`): not run.**
- **Plan 457 is restored and mostly shipped** (`plans/457-service-bindings.md`). The typed-service snapshot it left open is implemented by #1024, so this plan's framework dependency is in place.

**Phase 0 — probe (S, staging account), original questions:** Each answer recorded in this file:

- Q1: can a dispatch-namespace user Worker declare a service binding to another script in the same namespace, at upload time?
- Q2: can it bind to a script in a different namespace or an account-level Worker?
- Q3: can the binding carry `props` (fixed per binding), enough to tell a connector which org it serves?
- Q4: does a service-binding call appear in the callee's tail logs with the caller's script name?

**A. Declaration and deploy-time cycle check (M).** _Pure function shipped and unwired; see Status._ Read the service map from the manifest, build the graph across the project's own Workers, refuse cycles with the cycle
named. Unit tests: acyclic, self-loop, two-cycle, three-cycle, and a diamond (allowed).

**B. WfP binding support (M, after Q1).** Remove the `service` refusal for `cloudflare-wfp` only, emit the binding in the upload, and extend the provision contract test
that asserts the matrix matches `CELLD_RELEASE_BINDINGS`.

**C. Org connector model (L).** An org-level connector entity (name, owning org, artifact reference, entrypoints), a project grant table, org-admin authorization on both,
and the deploy path that binds granted connectors. The artifact is uploaded by an org admin, so it is not signed by the platform: the catalog's Ed25519 verification
(`apps/cloud/src/catalog/signature.ts`) checks the platform's key and does not apply. Use what fits org-uploaded code: a content hash recorded at upload, the same size
and sha256 checks the catalog applies to each file (`apps/cloud/src/catalog/artifact.ts`), and an upload authorised to org admins only. The grant records who uploaded the
artifact and at what hash.

**D. Connector secrets (S).** Route through `apps/cloud/src/secrets/`, expose only the binding to the connector, and test that no API response or manifest contains a secret value.

**E. Studio and CLI (M).** Connector list, upload, secret management, grants with the artifact hash shown, per-target "not supported" states.

**F. Platform-curated templates (later, not in this plan).** Installing a template into an org through the catalog. Recorded here so the org-ownership decision is not reopened for it.

## 6. Platform parity

| Feature                   | `cloudflare-wfp`                         | `cloudflare-workers` (BYO)                                                                     | `celld-vps`                                                  | Notes                                                           |
| ------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| Service binding (sibling) | unsupported until Q1 passes, then native | unsupported (no namespace; a Worker in the customer account could bind natively, to be probed) | unsupported (one fleet per box, `provision-contract.ts:336`) | Framework side is plan 457; the cloud row is what changes here. |
| Org connector (leaf)      | depends on Q1/Q2                         | unsupported                                                                                    | unsupported                                                  | A cloud feature; stated so the matrix cannot drift.             |

Framework `ctx.*` is unchanged; plan 457 owns the `ctx`/client surface.

## 7. Phasing & ordering

| Phase | Work        | Gate                                                                                           |
| ----- | ----------- | ---------------------------------------------------------------------------------------------- |
| 0     | Probe Q1–Q4 | Answers recorded; STOP per §8 if Q1 is no                                                      |
| 1     | A           | Cycle tests green; a deploy with a cycle is refused before provisioning (fake driver)          |
| 2     | B           | A staging project with two sibling Workers calls each other in an acyclic direction end to end |
| 3     | C, D        | Secret-leak test green; grant revocation exercised on staging                                  |
| 4     | E           | Studio and CLI flows reviewed end to end; matrix row matches the code                          |

## 8. Risks & STOP conditions

- **STOP** if Phase 0 Q1 is no. WfP stays unsupported for services; ship A and the BYO path if wanted, and re-plan connectors on celld.
- **STOP** if a connector grant requires a platform-wide rebuild. The grant must be a per-project binding change, not a fleet operation.
- **Risk:** a connector becomes an unbounded egress path. A service call bypasses the dispatcher, but a connector's own `fetch()` does not, provided it runs in a namespace
  with an Outbound Worker. _Mitigate:_ a connector is placed only in a namespace with an Outbound Worker (plan 477 covers its `fetch()`); a connector with none is refused at grant time.
- **Risk:** the cycle check misses a cycle through a Durable Object or queue. _Mitigate:_ the docs state the check covers declared service bindings only.
- **Perf watch:** the cycle check runs at deploy only; measure on the largest declared graph in the test fixtures.

## 9. Open questions — decided

1. **Are connectors per org or platform-curated?** Decided: per org, owned by an org admin. Platform curation comes later as templates installed into an org (§5F).
2. **Should a connector's entrypoints be declared in the artifact or the grant?** Decided: the artifact, so a grant cannot widen what a connector exposes.
3. **Who may deploy a connector?** Decided: org admins only, matching catalog install.

## 10. Review points closed on PR #1126 (2026-10-12)

- **Unwired `findServiceCycle`.** Kept, not wired. Its module comment now names the `service` rows of `BINDING_SUPPORT` as the thing it waits for. The change that flips a target's `service` row to native must call it on the project's service graph before provisioning, and add the refusal test.
- **Stateful-class rule in one place.** `statefulClassesOf(manifest)` in `provision-contract.ts` is the only definition. The halt stub (`classesOf`), the rollback and resume guard (`droppedStatefulClasses`) and the deployment record (`release-core.ts`) all call it. A stateful binding with no class throws in every caller; it is never skipped, because an unnamed class cannot be seen to be kept.
- **Recorded field not renamed.** `deployments.durableObjectClasses` is persisted. Renaming it needs a migration, which is out of scope. The field is commented at `release-core.ts`.
- **Duplicate class refused at deploy.** `manifest-parse.ts` rejects one class bound by two stateful bindings, as a Durable Object, a Workflow, or both. It is checked within one manifest only.
- **Limitation, not closed.** A binding or class renamed between two deploys is not detected. One manifest cannot show the previous name. Closing it needs the stored previous manifest in the deploy check, a separate change.
- **Workflow name ignored by the box.** Documented as a platform limitation in the `BINDING_SUPPORT` comment and in `cloud/your-own-cloudflare-account.mdx`. Alchemy derives the name from script and class. Not changed.
- **Emergency stop and workflows.** The stub's `run()` still throws, so a running instance fails on its next wake and does not resume. The behaviour is in the `emergencyStop` limitation text, the docs, and the halt audit entry and alert, which list the workflow classes stubbed. The synchronous `POST /v1/halts` response cannot list them: the stub is converged later by the sweep, so the list lands on the halt record and in the studio's emergency-stop card (`halts.status`, `stubbedWorkflows`).

## 11. Unverified

- **Workflows API token permission.** The Workflows API may need a token permission that `CLOUDFLARE_TOKEN_PERMISSIONS` does not list. Not confirmed; no account access from here. The permissions table is deliberately unchanged. Verify on a token that lacks it before enabling the BYO path for a customer.
- **Live run.** The box has not run the stub or a renamed-class deploy end to end.
