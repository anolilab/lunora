/**
 * The dev queue catcher's capture wiring: decide whether to record consumed
 * messages (`shouldCaptureQueue`) and build the sink that persists them
 * (`createQueueCaptureSink`). The sink POSTs each processed batch to the root
 * shard's reserved `__lunora_admin__:recordQueueMessage` admin RPC — the same
 * worker→root-shard path `@lunora/mail`'s capture transport and the runtime's
 * auth-event recorder use — so the studio's Queues panel shows one unified
 * consumed-message log.
 *
 * Runtime-agnostic and Node-safe: `env` is a plain record, the `SHARD` Durable
 * Object namespace is projected structurally, and the only I/O is `fetch` on the
 * shard stub. No `cloudflare:workers` import, so it stays unit-testable.
 */
import type { CapturedQueueMessage, QueueCaptureSink } from "./dispatch";

/** A Worker `env` projected as a plain record (vars, secrets, and bindings are `unknown`-valued). */
type QueueEnv = Record<string, unknown>;

/** Reserved admin RPC the capture sink records a batch of consumed messages through. */
const RECORD_QUEUE_MESSAGE_OP = "__lunora_admin__:recordQueueMessage";
/** Default shard the studio's Queues panel reads the consumed-message log from (the runtime's default shard). */
const DEFAULT_ROOT_SHARD = "__root__";
/** Env-name values that denote a development deployment (`lunora dev` sets `WORKER_ENV=development`). */
const DEV_ENVIRONMENT_PATTERN = /^(?:dev(?:elopment)?|local(?:host)?|test)$/iu;
const ENVIRONMENT_VARS = ["CF_ENV", "ENVIRONMENT", "NODE_ENV", "WORKER_ENV"] as const;

/**
 * Cap on the capture-sink POST to the root shard. The sink is best-effort but
 * `dispatchQueueBatch` awaits it inline, so an unresponsive root shard would stall
 * the whole `queue()` invocation (risking the consumer's execution limit) without
 * this abort. On timeout the fetch rejects and the dispatcher swallows it.
 */
const CAPTURE_FETCH_TIMEOUT_MS = 5000;

/** Minimal structural projection of a Durable Object stub (`namespace.get(id)`) — only `fetch`. */
interface DurableObjectStubLike {
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Minimal structural projection of the `SHARD` Durable Object namespace. Declared
 * structurally so `@lunora/queue` stays free of a Cloudflare / Durable Object
 * dependency. `jurisdiction` is optional so a data-residency-pinned deployment
 * records into the same jurisdictional DO the studio reads from.
 */
interface DurableObjectNamespaceLike {
    get: (id: unknown) => DurableObjectStubLike;
    idFromName: (name: string) => unknown;
    jurisdiction?: (jurisdiction: string) => DurableObjectNamespaceLike;
}

/** Options for {@link createQueueCaptureSink}. */
interface QueueCaptureOptions {
    /** Pin the consumed-message log to a Cloudflare data-residency jurisdiction (match the worker's `jurisdiction`). */
    jurisdiction?: string;
    /** Shard the consumed-message log lives on; override if the worker sets a custom `defaultShardKey`. */
    rootShard?: string;
}

/**
 * Whether consumed queue messages should be captured into the studio's log.
 * Explicit `LUNORA_QUEUE_CAPTURE` (`"1"`/`"true"` vs `"0"`/`"false"`) always wins;
 * unset, capture is on only in a development environment. Mirrors
 * `@lunora/mail`'s `shouldCaptureMail` so mail and queue dev capture toggle the
 * same way.
 */
const shouldCaptureQueue = (env: QueueEnv): boolean => {
    const flag = env["LUNORA_QUEUE_CAPTURE"];

    if (typeof flag === "string") {
        return flag === "1" || flag.toLowerCase() === "true";
    }

    return ENVIRONMENT_VARS.some((key) => {
        const value = env[key];

        return typeof value === "string" && DEV_ENVIRONMENT_PATTERN.test(value);
    });
};

/**
 * Build the {@link QueueCaptureSink} that records a processed batch into the
 * studio's root-shard consumed-message log via the reserved `recordQueueMessage`
 * admin RPC. Best-effort by contract: without the `SHARD` binding or
 * `LUNORA_ADMIN_TOKEN` it no-ops, and `dispatchQueueBatch` swallows a
 * rejection, so capture never changes delivery semantics.
 */
const createQueueCaptureSink = (env: QueueEnv, options: QueueCaptureOptions = {}): QueueCaptureSink => {
    const rootShard = options.rootShard ?? DEFAULT_ROOT_SHARD;

    return async (messages: CapturedQueueMessage[]): Promise<void> => {
        if (messages.length === 0) {
            return;
        }

        const binding = env["SHARD"] as DurableObjectNamespaceLike | undefined;
        const adminToken = typeof env["LUNORA_ADMIN_TOKEN"] === "string" ? env["LUNORA_ADMIN_TOKEN"] : undefined;

        if (binding === undefined || adminToken === undefined) {
            return;
        }

        // Fail closed on a configured-but-unsupported jurisdiction (mirrors
        // `@lunora/mail`'s `applyJurisdiction` and the runtime shard resolver): never
        // silently record message bodies outside a requested residency boundary, and
        // never split the write from the jurisdiction-scoped namespace the studio
        // reads through. `dispatchQueueBatch` swallows this throw, so capture no-ops.
        let namespace = binding;

        if (options.jurisdiction !== undefined) {
            if (typeof binding.jurisdiction !== "function") {
                throw new TypeError(
                    `@lunora/queue: Durable Object namespace does not support jurisdiction("${options.jurisdiction}") — update @cloudflare/workers-types or remove the jurisdiction option`,
                );
            }

            namespace = binding.jurisdiction(options.jurisdiction);
        }

        const stub = namespace.get(namespace.idFromName(rootShard));

        // Bound the inline capture write so a slow/unresponsive root shard can't hold
        // the consumer open indefinitely (see CAPTURE_FETCH_TIMEOUT_MS).
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, CAPTURE_FETCH_TIMEOUT_MS);

        try {
            await stub.fetch("https://shard.internal/rpc", {
                body: JSON.stringify({ args: { messages }, functionPath: RECORD_QUEUE_MESSAGE_OP }),
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
                method: "POST",
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
        }
    };
};

export { createQueueCaptureSink, shouldCaptureQueue };
export type { QueueCaptureOptions, QueueEnv };
