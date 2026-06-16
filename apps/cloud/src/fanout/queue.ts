/**
 * Tenant queue fan-out (CLOUD-PLAN.md §2.4). A Workers-for-Platforms namespaced
 * Worker can hold queue *producer* bindings but cannot be a queue *consumer*, so
 * tenant apps (e.g. `@lunora/mail`'s queue-backed sends) have nothing to drain
 * their queue. The platform runs one account-level consumer (the control-plane
 * Worker's `queue()` handler) bound to a shared queue; each message is tagged
 * with the producing tenant's script id, and the consumer groups by tenant and
 * forwards each sub-batch to that tenant's `POST /_lunora/queue` endpoint through
 * the dispatcher. This module is the pure core; the I/O is injected.
 *
 * Wire envelope: every message body is `{ script, body }` — `script` is the
 * dispatch-namespace script id, `body` the tenant's actual payload.
 */

/** A raw message off the shared queue (its `body` is the `{ script, body }` envelope). */
export interface QueueMessage {
    body: unknown;
    id: string;
}

/** A per-tenant sub-batch ready to forward (payloads unwrapped from the envelope). */
export interface TenantQueueGroup {
    messages: { body: unknown; id: string }[];
    script: string;
}

const envelopeScript = (body: unknown): string | undefined => {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }

    const { script } = body as { script?: unknown };

    return typeof script === "string" && script !== "" ? script : undefined;
};

/**
 * Group messages by their tenant script. Messages whose body isn't a valid
 * `{ script, body }` envelope are returned as `unrouted` (the caller acks them —
 * retrying an unaddressable message would loop forever).
 */
export const groupByTenant = (messages: ReadonlyArray<QueueMessage>): { groups: TenantQueueGroup[]; unrouted: string[] } => {
    const byScript = new Map<string, TenantQueueGroup>();
    const unrouted: string[] = [];

    for (const message of messages) {
        const script = envelopeScript(message.body);

        if (script === undefined) {
            unrouted.push(message.id);
            continue;
        }

        const group = byScript.get(script) ?? { messages: [], script };

        group.messages.push({ body: (message.body as { body?: unknown }).body, id: message.id });
        byScript.set(script, group);
    }

    return { groups: [...byScript.values()], unrouted };
};

/**
 * Forward each tenant group through the injected `dispatch`, collecting the
 * message ids to retry. A group whose dispatch throws retries its whole batch
 * (transient delivery failure); per-message retries come from the tenant's
 * own `{ retry: [...] }` response.
 */
export const fanOutQueue = async (options: {
    dispatch: (group: TenantQueueGroup) => Promise<ReadonlyArray<string>>;
    groups: ReadonlyArray<TenantQueueGroup>;
}): Promise<{ retry: Set<string> }> => {
    const retry = new Set<string>();

    await Promise.all(
        options.groups.map(async (group) => {
            try {
                for (const id of await options.dispatch(group)) {
                    retry.add(id);
                }
            } catch {
                for (const message of group.messages) {
                    retry.add(message.id);
                }
            }
        }),
    );

    return { retry };
};
