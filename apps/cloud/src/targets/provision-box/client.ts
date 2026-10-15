/**
 * The Cloudflare drivers' converge half (`cloudflare-wfp`, `cloudflare-workers`):
 * posts a {@link ProvisionJob} to the provision box (`lunora/containers.ts`),
 * which runs Alchemy 2 against the job's account, and reads its
 * {@link ProvisionEvent} NDJSON back.
 *
 * The box is reached through a container handle, so the orchestration is
 * unit-testable with a fake `fetch` and no Cloudflare credentials.
 */
import type { ContainerAccessor, ContainerHandle } from "@lunora/container";
import { containerBindingName, createContainerContext } from "@lunora/container";
import { LunoraError } from "@lunora/server";

import { provisionBox } from "../../../lunora/containers";
import readNdjson from "../../lib/read-ndjson";
import type { BindingSupportTable, TenantDeploymentSpec } from "../../provision-contract";
import { tenantResourceName } from "../../provision-contract";
import type { ProvisionDeploySpec, ProvisionEvent, ProvisionJob, ProvisionTarget } from "./contract";

/** The provision box: one instance per project (`.get(alias)`) serializes a project's jobs. */
export interface ProvisionBox {
    get: (name: string) => Pick<ContainerHandle, "fetch">;
}

/** The provision box accessor off a Worker env that carries its `CONTAINER_PROVISION_BOX` binding. */
export const provisionBoxFrom = (env: Record<string, unknown>): ContainerAccessor =>
    createContainerContext(env, [{ binding: containerBindingName("provisionBox"), exportName: "provisionBox", maxInstances: provisionBox.maxInstances }])
        .provisionBox;

/** Base64 for the job body — chunked, since spreading a whole bundle into `fromCharCode` overflows the stack. */
const toBase64 = (data: ArrayBuffer): string => {
    const bytes = new Uint8Array(data);
    let binary = "";

    for (let offset = 0; offset < bytes.length; offset += 0x80_00) {
        binary += String.fromCodePoint(...bytes.subarray(offset, offset + 0x80_00));
    }

    return btoa(binary);
};

/** What a driver adds to the neutral spec: where the job lands, and the platform wiring that target takes. */
export interface ProvisionPlacement {
    /** Fire the spec's crons from the Worker itself — a target with `fanout: "native"`. */
    nativeCrons: boolean;
    /** The tail-consumer service attached when the spec asks for logs; absent where none is wired. */
    tailConsumer?: string;
    target: ProvisionTarget;
}

/**
 * The box's deploy spec for a release: the neutral spec, every provisioned
 * binding's resource name attached (the box never derives names itself), and
 * the target and wiring the driver chose.
 */
export const deployJobSpec = (spec: TenantDeploymentSpec, support: BindingSupportTable, placement: ProvisionPlacement): ProvisionDeploySpec => {
    return {
        alias: spec.alias,
        ...(spec.assets ? { assets: spec.assets } : {}),
        bundle: toBase64(spec.bundle),
        ...(placement.nativeCrons && spec.crons !== undefined && spec.crons.length > 0 ? { crons: spec.crons } : {}),
        manifest: {
            ...spec.manifest,
            bindings: spec.manifest.bindings.map((requirement) =>
                support[requirement.type] === "provisioned" ? { ...requirement, resourceName: tenantResourceName(spec.alias, requirement) } : requirement,
            ),
        },
        secrets: spec.secrets,
        tags: spec.tags,
        ...(spec.collectLogs && placement.tailConsumer !== undefined ? { tailConsumers: [placement.tailConsumer] } : {}),
        target: placement.target,
        ...(spec.vars ? { vars: spec.vars } : {}),
    };
};

/**
 * Post one job and read the box's NDJSON to its single terminal event.
 *
 * A 409 is the box saying a job for this project is already running: retryable,
 * surfaced as `SERVICE_UNAVAILABLE` so the caller can tell it from a failure.
 */
export const runProvisionJob = async (
    handle: Pick<ContainerHandle, "fetch">,
    job: ProvisionJob,
    onLog: ((line: string) => Promise<void> | void) | undefined,
): Promise<{ url?: string }> => {
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
