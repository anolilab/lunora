/**
 * The wire contract between the two Cloudflare drivers and the provision box
 * (`containers/provision/`, a trusted container running Alchemy 2): the job a
 * driver posts to `POST /__lunora/provision` and the NDJSON lines the box
 * answers.
 *
 * Cloudflare nouns live here and only here. The target-neutral
 * {@link TenantDeploymentSpec} the deploy core hands every driver carries none
 * of them; each driver adds its {@link ProvisionTarget} when it builds the job:
 *
 * - `cloudflare-wfp` → `dispatch-namespace`: the cell's own account (the box's
 *   env credentials), a Worker in the cell's dispatch namespace, crons and
 *   queue consumers fanned out by the control plane.
 * - `cloudflare-workers` → `account`: a customer's own account, reached with
 *   the token the organization connected (it travels in the job, like the
 *   tenant's secrets, and never into program source or a log line), a plain
 *   Worker on its `workers.dev` subdomain with native crons and consumers.
 *
 * Wherever the resources land, the Alchemy STATE stays in the platform's own
 * account (MULTIPLATFORM.md §5.3): a customer must never be able to corrupt the
 * record of what was converged for them. See `containers/provision/README.md`.
 */
import type { AssetsUpload, BindingRequirement, DeployManifest } from "../../provision-contract";

/**
 * A binding as the box receives it. Provisioned types carry the name the control
 * plane computed with `tenantResourceName`: the box is plain JavaScript and never
 * re-derives it, so the naming rule lives in exactly one place.
 */
export type ProvisionBinding = BindingRequirement & { resourceName?: string };

/** Which Cloudflare account a job converges in, and how the Worker is placed there. */
export type ProvisionTarget =
    /** A customer's own account: a plain Worker, its token carried in the job. */
    | { accountId: string; apiToken: string; kind: "account" }
    /** The cell's account (the box's own credentials): a Worker in a dispatch namespace. */
    | { cell: string; dispatchNamespace: string; kind: "dispatch-namespace" };

/** The release half of a deploy job, as the box reads it. */
export interface ProvisionDeploySpec {
    /** The project's stable label — the Worker's script name. */
    alias: string;
    assets?: AssetsUpload;
    /** Base64 of the prebuilt Worker module. */
    bundle: string;
    /** Cron triggers the Worker carries itself — only on an `account` target; a dispatch-namespace Worker cannot. */
    crons?: string[];
    manifest: Omit<DeployManifest, "bindings"> & { bindings: ProvisionBinding[] };
    /** Travel to the box as process env, never inside program source. */
    secrets: Record<string, string>;
    tags: string[];
    /** Tail-consumer services attached to the Worker (the platform log tail). */
    tailConsumers?: string[];
    target: ProvisionTarget;
    vars?: Record<string, string>;
}

/**
 * The job the control plane posts to the provision box at `POST /__lunora/provision`.
 *
 * Two Alchemy stacks per project, both keyed by the alias:
 * - `lunora-project-{alias}` owns the `provisioned` resources.
 * - `lunora-worker-{alias}` owns the project's one Worker (script name = alias),
 *   bound to the project stack's resources. Every deploy converges it in place,
 *   so its Durable Object storage outlives releases.
 *
 * Releases are not scripts: each one is a stored bundle the control plane keeps
 * (`src/deploy/release-store.ts`), and a rollback is a `deploy` job carrying an
 * older bundle. So `destroy` only ever means the project is gone — it removes the
 * Worker, then the project stack and its data.
 */
export type ProvisionJob = { action: "deploy"; spec: ProvisionDeploySpec } | { action: "destroy"; alias: string; target: ProvisionTarget };

/** One NDJSON line of the provision box's reply. Exactly one `result` or `error` ends the stream. */
export type ProvisionEvent = { line: string; type: "log" } | { message: string; type: "error" } | { type: "result"; url?: string };
