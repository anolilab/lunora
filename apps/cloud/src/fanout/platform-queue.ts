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
import { bindingOfResourceName, storedTarget } from "../provision-contract";
import readJson from "../read-json";
import type { TargetFleet } from "../targets/driver";
import { registeredFleets } from "../targets/registry";
import type { LiveDeploymentRow } from "./live";
import { haltKey, readHalted, readLiveDeployments, resourceRefOf, servingDeployments } from "./live";
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
    messages: ReadonlyArray<{ ack: () => void; attempts?: number; body: unknown; id: string; retry: (options?: { delaySeconds?: number }) => void }>;
    queue: string;
}

/**
 * The body cap of a tenant's `POST /_lunora/queue` (`QUEUE_DISPATCH_MAX_BODY_BYTES`
 * in `@lunora/runtime`): a forward past it is refused before any handler runs.
 */
export const QUEUE_FORWARD_MAX_BODY_BYTES = 16 * 1_048_576;

const encoder = new TextEncoder();

/**
 * Split a batch into forward bodies of at most {@link QUEUE_FORWARD_MAX_BODY_BYTES}.
 * A full batch is 100 messages of up to 128 KiB, but JSON escaping grows a body
 * up to sixfold (a control character becomes `\u00XX`), so a valid batch can
 * serialize past the cap; whole, the tenant would refuse it every time until
 * the queue drops it. One message alone always fits.
 */
const forwardBodies = (batch: QueueBatchLike, queue: string): { body: string; ids: string[] }[] => {
    const prefix = '{"messages":[';
    const suffix = `],"queue":${JSON.stringify(queue)}}`;
    const envelopeBytes = encoder.encode(prefix + suffix).byteLength;
    const chunks: { bytes: number; ids: string[]; parts: string[] }[] = [];

    for (const message of batch.messages) {
        // `attempts` lets the tenant's retry policy see a message's last delivery.
        const part = JSON.stringify({ attempts: message.attempts, body: message.body, id: message.id });
        // +1 for the separating comma.
        const bytes = encoder.encode(part).byteLength + 1;
        const last = chunks.at(-1);

        if (last !== undefined && last.bytes + bytes <= QUEUE_FORWARD_MAX_BODY_BYTES) {
            last.bytes += bytes;
            last.ids.push(message.id);
            last.parts.push(part);
        } else {
            chunks.push({ bytes: envelopeBytes + bytes, ids: [message.id], parts: [part] });
        }
    }

    return chunks.map(({ ids, parts }) => {
        return { body: prefix + parts.join(",") + suffix, ids };
    });
};

/**
 * The delay a tenant asked a retry to wait, in whole seconds within Cloudflare's
 * ceiling, or `undefined` for none: the reply is tenant-written, and a delay the
 * broker refuses would throw out of the whole batch.
 */
const retryDelayOf = (delays: unknown, id: string): number | undefined => {
    const delay = typeof delays === "object" && delays !== null && Object.hasOwn(delays, id) ? (delays as Record<string, unknown>)[id] : undefined;

    return typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? Math.min(Math.ceil(delay), HELD_RETRY_DELAY_SECONDS) : undefined;
};

/**
 * Forward a batch to its tenant's `/_lunora/queue` endpoint, gated by its admin
 * token, in as many requests as its size needs ({@link forwardBodies}). Returns
 * the message ids to retry, each with the delay it asked for: those the tenant
 * asked to retry, and every message of a request that failed (with none).
 *
 * The tenant knows its queues by declared name and binding, never by this
 * platform's per-project queue name, so the alias prefix is stripped and the
 * binding (in its resource form) is what the tenant's registry resolves.
 */
const dispatchQueueBatch = async (
    dispatch: TenantDispatch,
    target: { adminToken: string; resourceRef: string },
    batch: QueueBatchLike,
): Promise<Map<string, number | undefined>> => {
    const retry = new Map<string, number | undefined>();

    for (const { body, ids } of forwardBodies(batch, bindingOfResourceName(batch.queue) ?? batch.queue)) {
        try {
            // eslint-disable-next-line no-await-in-loop -- in order, one request at a time: each body may be up to the tenant's 16 MiB cap
            const response = await dispatch(target)("/_lunora/queue", body, "application/json");

            if (!response.ok) {
                throw new Error(`queue forward failed: ${String(response.status)}`);
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            const result = await readJson<{ retry?: unknown; retryDelays?: unknown }>(response);

            for (const id of Array.isArray(result.retry) ? result.retry : []) {
                if (typeof id === "string") {
                    retry.set(id, retryDelayOf(result.retryDelays, id));
                }
            }
        } catch {
            for (const id of ids) {
                retry.set(id, undefined);
            }
        }
    }

    return retry;
};

/** What {@link deliverQueueBatch} needs: the in-network paths, the live deployments, and the store their organizations are read from. */
export interface QueueDeliveryPorts {
    dispatches: ReadonlyMap<TargetId, TenantDispatch>;
    /** What an emergency stop holds, by `haltKey` (alias and project): their Worker runs the halt stub. */
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

    if (ports.halted?.has(haltKey(target)) === true) {
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
    const retry = target ? await dispatchQueueBatch(target.dispatch, target, batch) : new Map<string, number | undefined>();

    for (const message of batch.messages) {
        if (retry.has(message.id)) {
            const delaySeconds = retry.get(message.id);

            if (delaySeconds === undefined) {
                message.retry();
            } else {
                message.retry({ delaySeconds });
            }
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
        halted: await readHalted(environment),
        live: await readLiveDeployments(environment),
        now: Date.now(),
        secretEncryptionKey: environment.SECRET_ENCRYPTION_KEY,
        ...(environment.DB ? { store: controlPlaneDatabase(environment.DB as D1DatabaseLike) } : {}),
    });
};
