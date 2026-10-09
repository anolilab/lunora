/**
 * The platform-owned queue consumer (§2.4). A target whose descriptor says
 * `fanout: "dispatcher"` cannot be a queue consumer (a Workers-for-Platforms
 * tenant), so the provision box attaches this Worker to every per-project queue
 * it creates. A batch comes from one queue, so it routes whole: queue name →
 * alias → the alias's live release (`./queue`), delivered over that target's
 * in-network `dispatch`. Per the tenant's reply (or a delivery failure) it
 * retries only the failed messages.
 */
import type { D1DatabaseLike } from "@lunora/d1";

import type { ControlPlaneEnv } from "../control-plane-env";
import type { ControlPlaneStore } from "../d1-store";
import { controlPlaneDatabase } from "../d1-store";
import { resolveAdminToken } from "../deploy/admin-token";
import type { TargetId } from "../provision-contract";
import { storedTarget } from "../provision-contract";
import readJson from "../read-json";
import type { TargetFleet } from "../targets/driver";
import { registeredFleets } from "../targets/registry";
import type { LiveDeploymentRow } from "./live";
import { readHaltedAliases, readLiveDeployments, resourceRefOf, servingDeployments } from "./live";
import type { QueueRouteCandidate } from "./queue";
import { routeQueue } from "./queue";

type TenantDispatch = NonNullable<TargetFleet["dispatch"]>;

/**
 * How long a held batch — its organization suspended, or its alias halted by
 * an emergency stop — waits before it is offered again: Cloudflare's longest
 * retry delay (12 h). Retried rather than acked so a hold loses nothing, and
 * delayed so it does not spin the queue — but every redelivery still counts
 * against the queue's `max_retries`, after which Cloudflare moves the message
 * to its dead-letter queue, or drops it if none.
 */
export const HELD_RETRY_DELAY_SECONDS = 43_200;

/** A queue batch the platform consumer drains (Cloudflare `MessageBatch`, minimally typed). */
export interface QueueBatchLike {
    messages: ReadonlyArray<{ ack: () => void; body: unknown; id: string; retry: (options?: { delaySeconds?: number }) => void }>;
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

/** What {@link deliverQueueBatch} needs: the in-network paths, the live deployments, and the store their organizations are read from. */
export interface QueueDeliveryPorts {
    dispatches: ReadonlyMap<TargetId, TenantDispatch>;
    /** Aliases an emergency stop holds: their Worker runs the halt stub. */
    halted?: ReadonlySet<string>;
    live: ReadonlyArray<LiveDeploymentRow>;
    now: number;
    secretEncryptionKey?: string;
    /** Absent without the control-plane D1 — then there are no live deployments to route to either. */
    store?: ControlPlaneStore;
}

type QueueTarget = { adminToken: string; dispatch: TenantDispatch; kind: "deliver"; resourceRef: string } | { kind: "held" } | undefined;

/**
 * The live deployment that owns a per-project queue, with its admin token
 * decrypted in-process — or `held` when an emergency stop holds its alias or
 * its organization may not run.
 */
const readQueueTarget = async (queue: string, ports: QueueDeliveryPorts): Promise<QueueTarget> => {
    const target = routeQueue(
        queue,
        ports.live.filter((row): row is LiveDeploymentRow & QueueRouteCandidate => row.alias !== undefined),
    );
    const rowTarget = target ? storedTarget(target.target) : undefined;
    const dispatch = rowTarget === undefined ? undefined : ports.dispatches.get(rowTarget);

    if (!target || !dispatch) {
        return undefined;
    }

    if (ports.halted?.has(target.alias) === true) {
        return { kind: "held" };
    }

    // This path dispatches to the tenant directly, past the dispatcher's
    // admission check, so suspension has to be enforced here as well.
    const serving = ports.store === undefined ? [] : await servingDeployments(ports.store, [target], ports.now);

    if (serving.length === 0) {
        return { kind: "held" };
    }

    const adminToken = await resolveAdminToken(target, ports.secretEncryptionKey);

    return adminToken ? { adminToken, dispatch, kind: "deliver", resourceRef: resourceRefOf(target) } : undefined;
};

/** Route one batch to its tenant, then ack or retry each message. */
export const deliverQueueBatch = async (batch: QueueBatchLike, ports: QueueDeliveryPorts): Promise<void> => {
    // No dispatcher target has an in-network path bound here: nothing can
    // deliver, so the whole batch waits for one.
    if (ports.dispatches.size === 0) {
        batch.messages.forEach((message) => {
            message.retry();
        });

        return;
    }

    const target = await readQueueTarget(batch.queue, ports);

    if (target?.kind === "held") {
        batch.messages.forEach((message) => {
            message.retry({ delaySeconds: HELD_RETRY_DELAY_SECONDS });
        });

        return;
    }

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

/** Drain one batch: route it to its tenant, then ack or retry each message. */
export const handleQueueBatch = async (batch: QueueBatchLike, environment: ControlPlaneEnv): Promise<void> => {
    const dispatches = new Map(
        registeredFleets(environment, { fanout: "dispatcher" }).flatMap((fleet) => (fleet.dispatch ? [[fleet.id, fleet.dispatch] as const] : [])),
    );

    await deliverQueueBatch(batch, {
        dispatches,
        halted: await readHaltedAliases(environment),
        live: await readLiveDeployments(environment),
        now: Date.now(),
        secretEncryptionKey: environment.SECRET_ENCRYPTION_KEY,
        ...(environment.DB ? { store: controlPlaneDatabase(environment.DB as D1DatabaseLike) } : {}),
    });
};
