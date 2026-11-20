/**
 * Durable Object instances on this host, one per shard for the life of the host, as the runtime keeps one per object: an
 * instance built per request loses its in-memory subscribers between a subscribe and the write that should reach them.
 *
 * Shared by `createNodeAppHost` and the server `lunora deploy --target node` generates, so both treat a constructor the way
 * workerd does: work the constructor gates behind `blockConcurrencyWhile` finishes before the instance takes its first event,
 * and if it fails, the instance is broken. Each event waiting on it fails with that error, the instance is dropped, and the
 * next event constructs a fresh one.
 */

import type { NodeShard } from "./node-shard-registry";
import { bindShardSockets, createNodeShardState } from "./node-shard-state";

/** What a Durable Object instance must answer on this host. The socket and alarm hooks are optional, as on Cloudflare. */
interface NodeDurableObjectInstance {
    alarm?: () => Promise<void> | void;
    fetch: (request: Request) => Promise<Response> | Response;
    webSocketClose?: (socket: unknown, code: number, reason: string, wasClean: boolean) => Promise<void> | void;
    webSocketMessage?: (socket: unknown, data: ArrayBuffer | string) => Promise<void> | void;
}

type NodeDurableObjectClass = new (state: never, env: Record<string, unknown>) => NodeDurableObjectInstance;

interface Constructed {
    instance: NodeDurableObjectInstance;
    /** Settles once every `blockConcurrencyWhile` the constructor started has; rejects with the first failure. */
    ready: Promise<void>;
}

/** The instance of `DurableObject` for a shard, constructed on first use and once it is ready. */
const createNodeDurableObjectFactory = (
    DurableObject: NodeDurableObjectClass,
    env: Record<string, unknown>,
): ((shard: NodeShard) => Promise<NodeDurableObjectInstance>) => {
    const instances = new WeakMap<NodeShard, Constructed>();
    const socketsBound = new WeakSet<NodeShard>();

    const construct = (shard: NodeShard): Constructed => {
        const startup: Promise<unknown>[] = [];
        let constructing = true;
        const state = createNodeShardState(shard, (work) => {
            if (constructing) {
                startup.push(work);
            }
        });
        const instance = new DurableObject(state as never, env);

        constructing = false;

        // Observed at once, so a rejection is never unhandled, whether or not an event ever waits on it.
        const ready = Promise.all(startup).then(() => undefined);

        ready.catch(() => undefined);

        return { instance, ready };
    };

    const instanceFor = async (shard: NodeShard): Promise<NodeDurableObjectInstance> => {
        let constructed = instances.get(shard);

        if (constructed === undefined) {
            constructed = construct(shard);
            instances.set(shard, constructed);

            // Bound once per shard, to whichever instance is current: a dropped instance must not keep the shard's sockets.
            // Either hook alone is a valid Durable Object, as on Cloudflare; the missing one is a no-op.
            if (!socketsBound.has(shard) && (constructed.instance.webSocketClose !== undefined || constructed.instance.webSocketMessage !== undefined)) {
                socketsBound.add(shard);
                bindShardSockets(
                    {
                        webSocketClose: async (socket, code, reason, wasClean) => {
                            const current = await instanceFor(shard);

                            await current.webSocketClose?.(socket, code, reason, wasClean);
                        },
                        webSocketMessage: async (socket, data) => {
                            const current = await instanceFor(shard);

                            await current.webSocketMessage?.(socket, data);
                        },
                    },
                    shard.inbound,
                );
            }
        }

        try {
            await constructed.ready;
        } catch (error: unknown) {
            // Broken, as workerd treats it: this event fails, and the next one constructs a fresh instance.
            if (instances.get(shard) === constructed) {
                instances.delete(shard);
            }

            throw error;
        }

        return constructed.instance;
    };

    return instanceFor;
};

export type { NodeDurableObjectClass, NodeDurableObjectInstance };
export { createNodeDurableObjectFactory };
