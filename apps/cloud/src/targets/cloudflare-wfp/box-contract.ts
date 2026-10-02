/**
 * The wire contract between the `cloudflare-wfp` driver and the provision box
 * (`containers/provision/`, a trusted container running Alchemy 2 with the
 * cell's Cloudflare token): the job the driver posts to `POST /__lunora/provision`
 * and the NDJSON lines the box answers.
 *
 * Cloudflare nouns live here and only here — the cell, the dispatch namespace,
 * the tail consumers. The target-neutral {@link TenantDeploymentSpec} the deploy
 * core hands every driver carries none of them; this driver adds them from its
 * own configuration when it builds the job.
 */
import type { AssetsUpload, BindingRequirement, DeployManifest } from "../../provision-contract";

/**
 * A binding as the box receives it. Provisioned types carry the name the control
 * plane computed with `tenantResourceName`: the box is plain JavaScript and never
 * re-derives it, so the naming rule lives in exactly one place.
 */
export type ProvisionBinding = BindingRequirement & { resourceName?: string };

/** The release half of a deploy job, as the box reads it. */
export interface ProvisionDeploySpec {
    /** The project's stable label — the dispatch-namespace script name. */
    alias: string;
    assets?: AssetsUpload;
    /** Base64 of the prebuilt Worker module. */
    bundle: string;
    /** Which cell (Cloudflare account) hosts this tenant. */
    cell: string;
    /** Dispatch namespace to deploy into (e.g. `lunora-production`). */
    dispatchNamespace: string;
    manifest: Omit<DeployManifest, "bindings"> & { bindings: ProvisionBinding[] };
    /** Travel to the box as process env, never inside program source. */
    secrets: Record<string, string>;
    tags: string[];
    /** Tail-consumer services attached to the Worker (the platform log tail). */
    tailConsumers?: string[];
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
export type ProvisionJob = { action: "deploy"; spec: ProvisionDeploySpec } | { action: "destroy"; alias: string; dispatchNamespace: string };

/** One NDJSON line of the provision box's reply. Exactly one `result` or `error` ends the stream. */
export type ProvisionEvent = { line: string; type: "log" } | { message: string; type: "error" } | { type: "result"; url?: string };
