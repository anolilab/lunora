/**
 * The control plane's coupling to the deploy substrate. The provisioner
 * converges a tenant release into a Workers-for-Platforms dispatch namespace by
 * posting a {@link ProvisionJob} to the provision box (`lunora/containers.ts`),
 * which runs Alchemy 2 with the cell's Cloudflare token, and reading its
 * {@link ProvisionEvent} NDJSON back.
 *
 * The box is reached through a container handle, so the orchestration is
 * unit-testable with a fake `fetch` and no Cloudflare credentials.
 */
import type { ContainerAccessor, ContainerHandle } from "@lunora/container";
import { containerBindingName, createContainerContext } from "@lunora/container";
import { LunoraError } from "@lunora/server";

import { provisionBox } from "../lunora/containers";
import { sha256HexBytes } from "./deploy/keys";
import readNdjson from "./lib/read-ndjson";
import type { ProvisionEvent, ProvisionJob, TenantDeploymentSpec } from "./provision-contract";
import { BINDING_SUPPORT, tenantResourceName } from "./provision-contract";

export interface ProvisionResult {
    bundleHash: string;
    url: string;
}

/** A project to tear down (preview TTL cleanup, project deletion): its Worker, then its resources. */
export interface DestroyRef {
    /** The project label — names both the Worker and the project stack. */
    alias: string;
    dispatchNamespace: string;
}

export interface Provisioner {
    /** Converge the project's stable Worker onto a release (deploy or rollback). Safe to retry. */
    deploy: (spec: TenantDeploymentSpec) => Promise<ProvisionResult>;
    /** Destroy the project's Worker and its resources (D1, R2, KV, queues …) with their data. */
    destroy: (reference: DestroyRef) => Promise<void>;
}

export interface AlchemyProvisionerOptions {
    /** The provision box; one instance per project (`.get(alias)`) serializes a project's jobs. */
    box: { get: (name: string) => Pick<ContainerHandle, "fetch"> };
    /** Receives each `log` line the box emits, in order. */
    onLog?: (line: string) => Promise<void> | void;
    /** Maps an alias (the script name) to its public URL (routed via the dispatcher). */
    urlForScript: (alias: string) => string;
}

/** The provision box accessor off a Worker env that carries its `CONTAINER_PROVISION_BOX` binding. */
export const provisionBoxFrom = (env: Record<string, unknown>): ContainerAccessor =>
    createContainerContext(env, [{ binding: containerBindingName("provisionBox"), exportName: "provisionBox", maxInstances: provisionBox.maxInstances }])
        .provisionBox;

/** The manifest with every provisioned binding's resource name attached — the box never derives names itself. */
const withResourceNames = (spec: TenantDeploymentSpec): Extract<ProvisionJob, { action: "deploy" }>["spec"]["manifest"] => {
    return {
        ...spec.manifest,
        bindings: spec.manifest.bindings.map((requirement) =>
            BINDING_SUPPORT[requirement.type] === "provisioned" ? { ...requirement, resourceName: tenantResourceName(spec.alias, requirement) } : requirement,
        ),
    };
};

/** Base64 for the job body — chunked, since spreading a whole bundle into `fromCharCode` overflows the stack. */
const toBase64 = (data: ArrayBuffer): string => {
    const bytes = new Uint8Array(data);
    let binary = "";

    for (let offset = 0; offset < bytes.length; offset += 0x80_00) {
        binary += String.fromCodePoint(...bytes.subarray(offset, offset + 0x80_00));
    }

    return btoa(binary);
};

/**
 * Post one job and read the box's NDJSON to its single terminal event.
 *
 * A 409 is the box saying a job for this project is already running: retryable,
 * surfaced as `SERVICE_UNAVAILABLE` so the caller can tell it from a failure.
 */
const runJob = async (handle: Pick<ContainerHandle, "fetch">, job: ProvisionJob, onLog: AlchemyProvisionerOptions["onLog"]): Promise<{ url?: string }> => {
    const response = await handle.fetch("/__lunora/provision", { body: JSON.stringify(job), headers: { "content-type": "application/json" }, method: "POST" });

    if (response.status === 409) {
        throw new LunoraError("SERVICE_UNAVAILABLE", "the provision box is busy with another job for this project; retry shortly");
    }

    if (!response.ok || response.body === null) {
        throw new LunoraError("INTERNAL", `provision box answered ${String(response.status)}`);
    }

    let result: { url?: string } | undefined;
    let failure: string | undefined;

    await readNdjson(response.body, async (line) => {
        let event: ProvisionEvent;

        try {
            event = JSON.parse(line) as ProvisionEvent;
        } catch {
            await onLog?.(`provision box emitted a line that was not JSON: ${line.slice(0, 200)}`);

            return;
        }

        switch (event.type) {
            case "error": {
                failure = event.message;
                break;
            }
            case "log": {
                await onLog?.(event.line);
                break;
            }
            case "result": {
                result = event.url === undefined ? {} : { url: event.url };
                break;
            }
            default:
        }
    });

    if (failure !== undefined) {
        throw new LunoraError("INTERNAL", failure);
    }

    if (result === undefined) {
        // The box died mid-job (OOM, eviction): the stream closed with no verdict.
        throw new LunoraError("INTERNAL", "the provision box closed the stream without a result or an error");
    }

    return result;
};

/** Provisioner backed by the Alchemy provision box. */
export const createAlchemyProvisioner = (options: AlchemyProvisionerOptions): Provisioner => {
    return {
        deploy: async (spec) => {
            const { bundle, ...rest } = spec;
            const [bundleHash] = await Promise.all([
                sha256HexBytes(bundle),
                runJob(
                    options.box.get(spec.alias),
                    { action: "deploy", spec: { ...rest, bundle: toBase64(bundle), manifest: withResourceNames(spec) } },
                    options.onLog,
                ),
            ]);

            // The dispatcher's URL, not the box's: tenants are reached through the
            // dispatcher, so a box-reported `workers.dev` URL is not the public one.
            return { bundleHash, url: options.urlForScript(spec.alias) };
        },
        destroy: async (reference) => {
            await runJob(
                options.box.get(reference.alias),
                { action: "destroy", alias: reference.alias, dispatchNamespace: reference.dispatchNamespace },
                options.onLog,
            );
        },
    };
};
