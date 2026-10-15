/**
 * What a project's code IS — a Lunora app or a plain Cloudflare Worker — and
 * the one place every layer decides it from (`projects.runtime`).
 *
 * The rest of the platform assumes a Lunora app wherever it reaches inside the
 * tenant: the build box runs `lunora build`, the deploy core floors the
 * `ShardDO` binding every Lunora worker exports, the log tail keeps only
 * `ctx.log` events, backups and eject read `/_lunora/admin/*`. A `worker`
 * project is built with its own wrangler behind a fan-out shim
 * (`containers/build/worker.mjs`) and none of those assumptions hold, so each of
 * them reads the runtime — snapshotted on the build row and the deployment row,
 * so a later change of the setting never re-aims a queued build or a rollback.
 *
 * Zero imports: the tail worker (`src/tail/worker.ts`) and the studio bundle
 * read it too.
 */

/** Every runtime a project can have, the default first. */
export const PROJECT_RUNTIMES = ["lunora", "worker"] as const;

export type ProjectRuntime = (typeof PROJECT_RUNTIMES)[number];

/** Every project before the setting existed, and every project that never set it. */
export const DEFAULT_RUNTIME: ProjectRuntime = "lunora";

export const isProjectRuntime = (value: unknown): value is ProjectRuntime =>
    typeof value === "string" && (PROJECT_RUNTIMES as ReadonlyArray<string>).includes(value);

/**
 * A stored `runtime` column → its runtime. Only `worker` is ever stored; absent
 * (`undefined`, or SQL NULL off a `.global()` row) is {@link DEFAULT_RUNTIME},
 * and so is a value this build does not know.
 */
export const storedRuntime = (stored: null | string | undefined): ProjectRuntime => (stored === "worker" ? "worker" : DEFAULT_RUNTIME);

/** How a runtime is written to a row: only `worker` is stored, so every row that predates the setting already reads as Lunora. */
export const runtimeColumn = (runtime: ProjectRuntime | undefined): { runtime?: "worker" } => (runtime === "worker" ? { runtime: "worker" } : {});

/**
 * The script tag a `worker` deployment carries (`TenantDeploymentSpec.tags`).
 * The dispatch-namespace tail worker sees a script's tags on every event
 * (`TraceItem.scriptTags`) and nothing else about it, so this is how it knows to
 * keep a plain Worker's ordinary console lines (`src/tail/parse.ts`).
 */
export const WORKER_RUNTIME_TAG = "runtime:worker";

/**
 * Why a plain Cloudflare Worker's release has none of what reads a Lunora app's
 * admin API (`/_lunora/admin/*`): the studio proxy, backups and eject.
 */
export const PLAIN_WORKER_NO_ADMIN =
    "this release is a plain Cloudflare Worker, which has no Lunora admin API — data views, backups and eject need a Lunora app";

/** How the studio names each runtime. */
export const RUNTIME_LABELS: Readonly<Record<ProjectRuntime, string>> = { lunora: "Lunora app", worker: "Cloudflare Worker" };
