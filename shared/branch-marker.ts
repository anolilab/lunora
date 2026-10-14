/**
 * The reserved workflow-branch join-callback marker key, shared without a
 * runtime dependency edge.
 *
 * `@lunora/workflow`'s `ctx.parallel` injects `__lunoraBranch` into a spawned
 * child's params so the child can signal completion back to its parent
 * instance/binding/event (see `packages/workflow/src/fan-out.ts`). Every public
 * create surface that accepts caller-supplied params — in `@lunora/workflow`
 * itself, and in `@lunora/runtime`, `@lunora/agent`, and `@lunora/do`, which all
 * call a `Workflow` binding's `create()` with app- or user-derived params —
 * must reject a caller-supplied marker at that trust boundary, or a forged one
 * can reach a child's `event.payload` and spoof events into an arbitrary
 * workflow instance.
 *
 * It is deliberately **not** a package: `@lunora/runtime` keeps `@lunora/workflow`
 * as a type-only devDependency (see `packages/runtime/src/create-worker.ts`),
 * and `@lunora/do` has no dependency on `@lunora/workflow` at all. Each consumer
 * imports this file by relative path and the bundler inlines it — no runtime
 * dependency edge is created, and the literal/check exists in exactly one
 * source location.
 */

/** The reserved join-callback key `ctx.parallel` injects into a child's params. */
export const BRANCH_MARKER_KEY = "__lunoraBranch";

/** True when caller-supplied workflow params carry the reserved branch-marker key. */
export const hasBranchMarker = (params: unknown): boolean => typeof params === "object" && params !== null && Object.hasOwn(params, BRANCH_MARKER_KEY);

/**
 * The shared rejection-reason fragment every create surface must state when it
 * refuses a caller-supplied branch marker — kept in one place so the five call
 * sites (`@lunora/workflow`'s `create`/`createBatch`/`createSpawn`,
 * `@lunora/runtime`'s scheduler/cron dispatch, `@lunora/agent`'s inbound
 * email/channel/run handles, and `@lunora/do`'s admin-rpc) state the same
 * contract instead of independently-drifting prose. Each site composes it with
 * its own subject and package-prefix convention, e.g.
 * `` `@lunora/workflow: params ${BRANCH_MARKER_REJECTION}` `` or
 * `` `${label} params ${BRANCH_MARKER_REJECTION}` ``.
 */
export const BRANCH_MARKER_REJECTION: string = `may not contain the reserved workflow branch-marker key ("${BRANCH_MARKER_KEY}")`;
