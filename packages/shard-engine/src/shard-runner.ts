/**
 * `ShardRunner` — the host-neutral orchestrator that mounts the Lunora reactive
 * engine on any `@lunora/platform` host.
 *
 * This first slice establishes the seam: the runner owns the `ShardHost` and
 * `SocketHost` contracts and exposes `handleFetch` / `handleAlarm` as the
 * platform-neutral entry points. Platform-specific logic still lives in the
 * host's wrapper (e.g. `ShardDO`) for now; it is injected via the `handlers`
 * option so the public API stays stable while the engine is progressively
 * extracted into this package.
 *
 * Future slices will move the request router, reactive subscription refresh,
 * and poke protocol into this class, consuming the helpers already extracted
 * in `@lunora/shard-engine` (`runSocketPool`, `subscriptionListDeltas`,
 * `ReactiveCache`, etc.).
 */

import type { ShardHost, SocketHost } from "@lunora/platform";

/** Options accepted by {@link ShardRunner}. */
export interface ShardRunnerOptions {
    /**
     * Host-specific handlers that implement `handleFetch` / `handleAlarm` for
     * this slice. As the engine is extracted, these hooks will shrink and
     * eventually disappear.
     */
    handlers?: {
        /** Platform-specific alarm implementation. */
        handleAlarm?: () => Promise<void>;
        /** Platform-specific fetch implementation. */
        handleFetch?: (request: Request) => Promise<Response>;
    };
}

/**
 * Host-neutral shard engine runner.
 *
 * One instance per shard. It is intentionally cheap to construct so the
 * host can create it eagerly in its constructor.
 */
export class ShardRunner {
    /** The shard execution slot this runner operates on. */
    public readonly shardHost: ShardHost;

    /** The socket subscription host this runner operates on. */
    public readonly socketHost: SocketHost;

    /** Construction-time options, including host-specific handler overrides. */
    public readonly options: ShardRunnerOptions;

    public constructor(shardHost: ShardHost, socketHost: SocketHost, options: ShardRunnerOptions = {}) {
        this.shardHost = shardHost;
        this.socketHost = socketHost;
        this.options = options;
    }

    /**
     * Handle an HTTP request routed to this shard.
     *
     * First-slice behavior: delegates to the host-specific `handlers.handleFetch`
     * when supplied, otherwise returns a 501 placeholder. This keeps the seam
     * stable while `ShardDO` continues to own the Cloudflare-specific request
     * lifecycle.
     */
    public async handleFetch(request: Request): Promise<Response> {
        if (this.options.handlers?.handleFetch) {
            return this.options.handlers.handleFetch(request);
        }

        return new Response("Not implemented", { status: 501 });
    }

    /**
     * Handle a scheduled alarm wake-up for this shard.
     *
     * First-slice behavior: delegates to the host-specific `handlers.handleAlarm`
     * when supplied, otherwise no-ops.
     */
    public async handleAlarm(): Promise<void> {
        if (this.options.handlers?.handleAlarm) {
            await this.options.handlers.handleAlarm();
        }
    }
}
