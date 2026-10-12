# Plan 481 — Tenant Workflows on the targets that can run them, and an honest refusal everywhere else

**Baseline:** `origin/feat/cloud-platform-dx` @ `1d8f444fe` (2026-10-11)
**Status:** PARTIAL — BYO workflows verified positive on the Lunora account; workstream A (BYO native) is unblocked. WfP is blocked on account access; celld Q3 not run.

## 0. Headline finding

Durable background work is the feature most likely to block an app built with a coding assistant from moving to Lunora Cloud. Today it is refused on the two
Cloudflare-native targets and supported only on the customer-box target:

- **Workers for Platforms (managed, the default):** `workflow: unsupported` (`apps/cloud/src/provision-contract.ts:402`), with the reason "Workflows register per
  account script, and Workers for Platforms scripts have no such registration yet" (`:467`). `apps/cloud/GAPS.md:205` lists it as 🔨 unsupported.
- **Bring-your-own Cloudflare (`cloudflare-workers`):** `workflow: unsupported` (`provision-contract.ts:438`). The surprising one: the Worker is a plain Worker in the
  customer's own account, where a Workflow can be registered natively, so the refusal is probably stale. It must be probed, not assumed.
- **Customer box (`celld-vps`):** workflows are not refused, so they are supported. celld's matrix (`packages/platform/src/capabilities/celld.ts:227-229`) marks `workflows`
  supported, and `workflowRollback` (`:219`) and `workflowSchedules` (`:223`) unsupported.

Size: **M** for the BYO path, **L or blocked** for WfP.

## 1. Current state (audit)

- `apps/cloud/src/provision-contract.ts:402` — `workflow: "unsupported"` for `cloudflare-wfp`.
- `apps/cloud/src/provision-contract.ts:438` — `workflow: "unsupported"` for `cloudflare-workers`.
- `apps/cloud/src/provision-contract.ts:467` — the WfP refusal reason.
- `apps/cloud/GAPS.md:205` — `workflow | 🔨 unsupported | registered per account script; no dispatch-namespace variant yet`.
- `apps/cloud/src/deploy/worker-classes.ts` — records which Durable Object and workflow classes each alias's Worker runs. Type-agnostic.
- `apps/cloud/src/deploy/halt-stub.ts:45` and `:126` — a halt treats `durable_object` and `workflow` as class types; `provisionableClasses` drops any type the target refuses.
  On WfP a workflow class is silently not provisioned.
- `packages/platform/src/capabilities/celld.ts:219-229` — `workflows` supported on celld; `workflowRollback` and `workflowSchedules` unsupported.
- Framework: `packages/config/src/workflow-info.ts` discovers `defineWorkflow` declarations; `packages/config/src/cloudflare/binding-manifest.ts` derives workflow bindings.
- The dispatcher's `DISPATCHER.get` path is the only way a WfP tenant Worker is reached. A Workflow instance is not reached through a request.

## 2. Existing seams (do not reinvent)

- The per-target support matrix in `BINDING_SUPPORT` with reasons in `UNSUPPORTED_REASONS` (`provision-contract.ts`). A change here is the feature.
- `worker-classes.ts` for class bookkeeping; `halt-stub.ts`'s `provisionableClasses` for the refusal path. No second class registry.
- The Alchemy provision box (`apps/cloud/src/targets/provision-box/`) provisions account resources for the BYO path. A workflow belongs there.
- celld's own capability matrix, which already says what runs on the box.

## 3. The behavioural contract to preserve

- A deploy whose manifest declares a workflow on a target that cannot run it is refused with the reason before any provisioning. Never deployed with the workflow silently absent.
- A declared workflow reaches `ready` only when its class is in the Worker's `exports` (the framework's existing contract).
- A halt does not orphan a running Workflow instance without saying so.
- `workflowRollback` and `workflowSchedules` stay refused with their existing reasons on every target until supported.

## 4. Design decisions

1. **Probe before choosing.** Web documentation searched on 2026-10-11 did not settle whether a dispatch-namespace script can declare a Workflow. A real account answers it.
2. **If WfP cannot register workflows, do not build a workaround.** One workaround is a per-tenant account-level host Worker that runs the tenant's Workflow class. It moves tenant code out
   of the untrusted dispatch isolation: a security-model change, out of scope here.
3. **Enable the BYO path if the probe confirms native support.** The plain Worker in the customer's account registers the Workflow through the provision path it already uses for Durable Objects.
4. **Keep celld as the reference path.** Add tests that pin its supported and unsupported sub-features.
5. **UX on refusal.** Every refused workflow shows, at deploy time, the target it cannot run on, the reason, and the one thing the developer can do (move the project to a target
   that runs workflows, or remove the declaration). The refusal is never a generic "unsupported binding" error.

## 5. Workstreams

**Phase 0 — result (2026-10-11).**

- **Q2 (BYO): verified positive on the Lunora account.** A plain Worker deployed with a `workflows` binding (`class_name` exported, `WorkflowEntrypoint`). An instance ran to `Completed` with `step.do` and `step.sleep` (`Last Successful Step: finish-1`, output `"hi"`), in about one second. The `cloudflare-workers` refusal at `provision-contract.ts:438` is **stale**; workstream A is unblocked. The probe Worker and its workflow were deleted afterwards.
- **Q1 (WfP): blocked** by the account (no dispatch namespaces, error 10121).
- **Q3 (celld): not run.** No celld binary is installed here, and this base has no install script for it.

**Phase 0 — probe (S, two accounts), original questions.**

- Q1 (WfP): can a Worker uploaded into a dispatch namespace declare a `workflows` binding with a class export? Record the exact error if not.
- Q2 (BYO): can a plain Worker in a customer account declare a `workflows` binding, and does the provision box create the Workflow on deploy?
- Q3 (celld): does a workflow run to completion with `step.do`, `step.sleep` and `waitForEvent` on the box?

**A. BYO workflows (M, if Q2 yes).** Flip `workflow` to `native` for `cloudflare-workers` in `BINDING_SUPPORT`, with the provision-box job carrying the workflow. Test: the matrix
matches; a fake driver receives the workflow resource; teardown removes it with the Worker.

**B. Refusal wording and UX (S).** Replace the WfP reason with the actual constraint once Q1 is answered (§4.5 shape), and link the docs.

**C. Halt behaviour (S).** On targets that drop workflow classes, the halt response lists the workflow classes it could not stop.

**D. celld pins (S).** Tests that a workflow with `step.do`, `sleep` and `waitForEvent` deploys to a box, and that `rollbackOptions` and `schedules` are refused with the celld reasons.

**E. Docs (S).** One table in the cloud docs: workflow support per target, with the sub-feature rows.

## 6. Platform parity

| Feature                           | `cloudflare-wfp`            | `cloudflare-workers` (BYO)            | `celld-vps`    | Notes                                                               |
| --------------------------------- | --------------------------- | ------------------------------------- | -------------- | ------------------------------------------------------------------- |
| Durable workflow (`workflows[]`)  | unsupported until Q1 passes | native if Q2 passes, else unsupported | native (celld) | celld matrix: `packages/platform/src/capabilities/celld.ts:227-229` |
| Step rollback (`rollbackOptions`) | unsupported                 | unsupported                           | unsupported    | celld: "step rollbackOptions are not implemented"                   |
| Scheduled workflows (`schedules`) | unsupported                 | unsupported                           | unsupported    | not verified against celld                                          |

This plan touches a provider binding, so the table is mandatory. The framework's `ctx`-level workflow surface is unchanged.

## 7. Phasing & ordering

| Phase | Work                   | Gate                                                                                   |
| ----- | ---------------------- | -------------------------------------------------------------------------------------- |
| 0     | Q1–Q3 on real accounts | Answers recorded; §4 confirmed or revised                                              |
| 1     | A (if Q2) and B        | Provision-contract matrix test; fake-driver test that a workflow resource is requested |
| 2     | C and D                | Halt response test; celld pins green in `test:celld` (requires the `celld` binary)     |
| 3     | E                      | Docs table matches the matrix                                                          |

## 8. Risks & STOP conditions

- **STOP** if Q1 is no and the only route to WfP workflows is a host Worker running tenant code outside the dispatch isolation. That is a security decision; stop and ask.
- **STOP** if Q2 says the BYO Worker cannot register workflows either. Then managed workflows are customer-box-only, and the product copy must say so.
- **Risk:** flipping BYO to native while teardown cannot delete the Workflow leaves orphaned account resources. _Mitigate:_ the teardown test in A.
- **Risk:** a halt leaves Workflow instances running and charging the org. _Mitigate:_ workstream C reports them; metering is §9.1.

## 9. Open questions

1. Does a running Workflow instance count against the spend cap, and does a halt stop it? Needs a product answer; the meter is in the cloud's billing usage code.
2. If WfP cannot do workflows, is a customer-box or BYO-only feature acceptable for the managed tier? Product call; the matrix is the honest answer either way.
