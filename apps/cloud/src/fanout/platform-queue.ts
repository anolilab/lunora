/**
 * The platform-owned queue consumer (§2.4). A target whose descriptor says
 * `fanout: "dispatcher"` cannot be a queue consumer (a Workers-for-Platforms
 * tenant), so the provision box attaches this Worker to every per-project queue
 * it creates. A batch comes from one queue, so it routes whole: queue name →
 * alias → the alias's live release (`./queue`), delivered over that target's
 * in-network `dispatch`. Per the tenant's reply (or a delivery failure) it
 * retries only the failed messages.
 */
import type { ControlPlaneEnv } from "../control-plane-env";
import { resolveAdminToken } from "../deploy/admin-token";
import type { TargetId } from "../provision-contract";
import { storedTarget } from "../provision-contract";
import readJson from "../read-json";
import type { TargetFleet } from "../targets/driver";
import { registeredFleets } from "../targets/registry";
import type { LiveDeploymentRow } from "./live";
import { readLiveDeployments, resourceRefOf } from "./live";
import type { QueueRouteCandidate } from "./queue";
import { routeQueue } from "./queue";

type TenantDispatch = NonNullable<TargetFleet["dispatch"]>;

/** A queue batch the platform consumer drains (Cloudflare `MessageBatch`, minimally typed). */
export interface QueueBatchLike {
    messages: ReadonlyArray<{ ack: () => void; body: unknown; id: string; retry: () => void }>;
    queue: string;
}

/**
 * Forward a batch to its tenant's `/_lunora/queue` endpoint, gated by its admin
 * token. Returns the message ids the tenant asked to retry; a delivery failure
 * throws and the caller retries the whole batch.
 *
 * ponytail: `queue` is the platform's per-project queue name, not the name the
 * tenant's wrangler config declared; map it back when a tenant needs to route
 * several queues by their own names.
 */
const dispatchQueueBatch = async (dispatch: TenantDispatch, target: { adminToken: string; resourceRef: string }, batch: QueueBatchLike): Promise<string[]> => {
    const response = await dispatch(target)(
        "/_lunora/queue",
        JSON.stringify({
            messages: batch.messages.map((message) => {
                return { body: message.body, id: message.id };
            }),
            queue: batch.queue,
        }),
        "application/json",
    );

    if (!response.ok) {
        throw new Error(`queue forward failed: ${String(response.status)}`);
    }

    const result = await readJson<{ retry?: unknown }>(response);
    const retry: unknown[] = Array.isArray(result.retry) ? result.retry : [];

    return retry.filter((id): id is string => typeof id === "string");
};

/** The live deployment that owns a per-project queue, with its admin token decrypted in-process. */
const readQueueTarget = async (
    environment: ControlPlaneEnv,
    queue: string,
    dispatches: ReadonlyMap<TargetId, TenantDispatch>,
): Promise<undefined | { adminToken: string; dispatch: TenantDispatch; resourceRef: string }> => {
    const live = await readLiveDeployments(environment);
    const target = routeQueue(
        queue,
        live.filter((row): row is LiveDeploymentRow & QueueRouteCandidate => row.alias !== undefined),
    );
    const rowTarget = target ? storedTarget(target.target) : undefined;
    const dispatch = rowTarget === undefined ? undefined : dispatches.get(rowTarget);

    if (!target || !dispatch) {
        return undefined;
    }

    const adminToken = await resolveAdminToken(target, environment.SECRET_ENCRYPTION_KEY);

    return adminToken ? { adminToken, dispatch, resourceRef: resourceRefOf(target) } : undefined;
};

/** Drain one batch: route it to its tenant, then ack or retry each message. */
export const handleQueueBatch = async (batch: QueueBatchLike, environment: ControlPlaneEnv): Promise<void> => {
    const dispatches = new Map(
        registeredFleets(environment, { fanout: "dispatcher" }).flatMap((fleet) => (fleet.dispatch ? [[fleet.id, fleet.dispatch] as const] : [])),
    );

    // No dispatcher target has an in-network path bound here: nothing can
    // deliver, so the whole batch waits for one.
    if (dispatches.size === 0) {
        batch.messages.forEach((message) => {
            message.retry();
        });

        return;
    }

    const target = await readQueueTarget(environment, batch.queue, dispatches);

    // No live release (or token) owns this queue: acked, since retrying an
    // undeliverable message would only loop until it hits the retry limit.
    let retry = new Set<string>();

    if (target) {
        try {
            retry = new Set(await dispatchQueueBatch(target.dispatch, target, batch));
        } catch {
            retry = new Set(batch.messages.map((message) => message.id));
        }
    }

    for (const message of batch.messages) {
        if (retry.has(message.id)) {
            message.retry();
        } else {
            message.ack();
        }
    }
};
