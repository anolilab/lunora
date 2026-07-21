/**
 * `@lunora/provision` — the control plane's coupling to the deploy substrate
 * (CLOUD-PLAN.md §2.2). The provisioner converges a tenant deployment into a
 * Workers-for-Platforms dispatch namespace. It talks to Cloudflare only through
 * the injected {@link CloudflareApi} port, so the orchestration is unit-testable
 * with a fake and the live wire protocol lives in `src/cloudflare/api.ts`.
 *
 * (We provision via the documented Cloudflare REST API rather than the
 * unverified `alchemy@next` beta — see the note in §2.2. The port boundary means
 * an Alchemy-backed implementation can replace `createHttpCloudflareApi` later
 * with no change above this module.)
 */
import type { CloudflareApi, ScriptBinding } from "./cloudflare/api";
import { sha256HexBytes } from "./deploy/keys";

/** Per-tenant bindings to provision alongside a tenant Worker (§2.1). */
export interface TenantBindingSpec {
    /** Provision (or reuse) a per-tenant D1 database under this binding name. */
    d1?: { binding: string };
    /** Durable Object classes the tenant bundle exports (ShardDO / SessionDO …). */
    durableObjects?: { binding: string; className: string }[];
    /** Provision (or reuse) a per-tenant R2 bucket under this binding name. */
    r2?: { binding: string };
}

/** A single managed-tier deployment to converge into a dispatch namespace. */
export interface TenantDeploymentSpec {
    /**
     * The project's stable label (its public subdomain), shared by every
     * version of the project. Per-tenant D1/R2 are named from this — NOT from
     * the versioned {@link scriptName} — so a tenant's `.global()` data persists
     * across deploys and a rollback sees the same database.
     */
    alias: string;
    /** Bindings to attach in the script-upload metadata. */
    bindings: TenantBindingSpec;
    /** Prebuilt worker bundle (output of the app's Vite pipeline — never built here). */
    bundle: ArrayBuffer;
    /** Which cell (Cloudflare account) hosts this tenant (§2.5). */
    cell: string;
    /** Dispatch namespace to deploy into (e.g. `lunora-production`). */
    dispatchNamespace: string;
    /** Dispatch-namespace script id. */
    scriptName: string;
    /** Per-deployment secrets, applied via the WfP script-secrets API. */
    secrets: Record<string, string>;
    /** Lifecycle tags: `org:…`, `project:…`, `env:…`, `plan:…` (§2.1). */
    tags: string[];
}

export interface ProvisionResult {
    bundleHash: string;
    scriptName: string;
    url: string;
}

/**
 * Per-tenant resource names, derived from the (unique, versioned) script id.
 * The provisioner creates resources under these names and teardown deletes them
 * under the same names — the convention is the contract, so both sides call
 * these helpers rather than inlining the suffix (no drift).
 */
export const tenantD1Name = (scriptName: string): string => `${scriptName}-db`;
export const tenantR2Bucket = (scriptName: string): string => `${scriptName}-files`;

export interface DestroyRef {
    dispatchNamespace: string;
    scriptName: string;
}

export interface Provisioner {
    /** Converge a tenant deployment (create/update). Safe to retry. */
    deploy: (spec: TenantDeploymentSpec) => Promise<ProvisionResult>;
    /** Tear a deployment down (preview TTL cleanup, project deletion). */
    destroy: (reference: DestroyRef) => Promise<void>;
}

export interface CloudflareProvisionerOptions {
    /** The Cloudflare API port (HTTP impl in `src/cloudflare/api.ts`). */
    api: CloudflareApi;
    /** Entry module name inside the uploaded bundle. Defaults to `index.js`. */
    mainModule?: string;
    /** Maps a script id to its public URL (routed via the dispatcher). */
    urlForScript: (scriptName: string) => string;
}

/**
 * Provisioner backed by the Cloudflare REST API. `deploy` provisions the per-
 * tenant resources the bindings call for (D1, R2), uploads the user Worker into
 * the dispatch namespace with the binding + DO-migration metadata, applies
 * secrets, and returns the content hash + routed URL. `destroy` removes the
 * script.
 */
export const createCloudflareProvisioner = (options: CloudflareProvisionerOptions): Provisioner => {
    const { api, urlForScript } = options;
    const mainModule = options.mainModule ?? "index.js";

    return {
        deploy: async (spec) => {
            const bindings: ScriptBinding[] = [];

            if (spec.bindings.d1) {
                // Per-project (alias-keyed), find-or-create: a re-deploy of the
                // same project reuses its existing database so tenant `.global()`
                // data persists across versions.
                const databaseName = tenantD1Name(spec.alias);
                const existing = await api.findD1DatabaseByName(databaseName);
                const uuid = existing?.uuid ?? (await api.createD1Database(databaseName)).uuid;

                bindings.push({ id: uuid, name: spec.bindings.d1.binding, type: "d1" });
            }

            if (spec.bindings.r2) {
                // Per-project (alias-keyed); createR2Bucket tolerates "already
                // exists" so a re-deploy reuses the project's bucket.
                const bucketName = tenantR2Bucket(spec.alias);

                await api.createR2Bucket(bucketName);
                bindings.push({ bucket_name: bucketName, name: spec.bindings.r2.binding, type: "r2_bucket" });
            }

            const durableObjects = spec.bindings.durableObjects ?? [];

            for (const durableObject of durableObjects) {
                bindings.push({ class_name: durableObject.className, name: durableObject.binding, type: "durable_object_namespace" });
            }

            await api.putDispatchScript({
                bindings,
                bundle: spec.bundle,
                mainModule,
                namespace: spec.dispatchNamespace,
                newSqliteClasses: durableObjects.map((durableObject) => durableObject.className),
                scriptName: spec.scriptName,
                tags: spec.tags,
            });

            for (const [name, text] of Object.entries(spec.secrets)) {
                // eslint-disable-next-line no-await-in-loop -- secrets applied sequentially; the set is small
                await api.putSecret({ name, namespace: spec.dispatchNamespace, scriptName: spec.scriptName, text });
            }

            return { bundleHash: await sha256HexBytes(spec.bundle), scriptName: spec.scriptName, url: urlForScript(spec.scriptName) };
        },
        destroy: (reference) => api.deleteDispatchScript({ namespace: reference.dispatchNamespace, scriptName: reference.scriptName }),
    };
};
