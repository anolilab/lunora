/**
 * `ShardRunner` — the host-neutral orchestrator that mounts the Lunora reactive
 * engine on any `@lunora/platform` host.
 *
 * The runner owns the operations that are the same on every host: resolving a
 * socket to its stable identity, enumerating live sockets, deferring background
 * work, and composing the single-writer gate with the durable transaction. A
 * host wrapper (`ShardDO` on Cloudflare) keeps only what is genuinely
 * provider-specific.
 *
 * The request router, reactive subscription refresh, and poke protocol have not
 * moved yet; they are injected through the `handlers` option, so `handleFetch`
 * and `handleAlarm` remain a stable seam while that extraction continues.
 */

import type { ShardHost, SocketHandle, SocketHost } from "@lunora/platform";

import type { ShardSocketLike } from "./types";

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

    /** The shard key this runner serves, when the host names its shards. */
    public get shardKey(): string | undefined {
        return this.shardHost.shardKey;
    }

    /**
     * Resolve a socket the runtime handed to a message or close callback to the
     * identity the rest of the engine keys on.
     *
     * This is the engine's single most identity-sensitive rule, which is why it
     * lives here rather than being restated at each callback. Per-socket state
     * (subscription and shape memos, snapshots, stream cancellers, rate buckets,
     * relay cohort memos) is stored in `WeakMap`s keyed by the object the caller
     * passes. Enumeration yields the host's `SocketHandle`; a runtime callback
     * yields the provider's own socket. Keying those against each other would
     * silently miss every lookup — no error, just state that appears to vanish.
     *
     * Resolving through the host collapses both into one identity, because a
     * host returns the SAME cached handle for a given socket. The raw fallback
     * is not a compromise: a socket the host cannot map is one enumeration
     * cannot see either, so nothing else will ever key against it.
     */
    public socketFor(raw: unknown): ShardSocketLike {
        return this.socketHost.handleFor(raw) ?? (raw as ShardSocketLike);
    }

    /** Live sockets for this shard, optionally narrowed to one fan-out tag. */
    public sockets(tag?: string): SocketHandle[] {
        return this.socketHost.getSockets(tag);
    }

    /**
     * Let `work` outlive the current response where the host supports it.
     *
     * Returns whether the host took ownership, so a caller that must not drop
     * the work can await it instead of assuming it was scheduled.
     */
    public background(work: Promise<unknown>): boolean {
        if (this.shardHost.waitUntil === undefined) {
            return false;
        }

        this.shardHost.waitUntil(work);

        return true;
    }

    /**
     * Run `work` as a durable, serialized mutation: the single-writer gate wraps
     * the transaction, so the commit boundary cannot interleave with another
     * dispatch on this shard.
     *
     * Both halves are required and belong together — a transaction without the
     * gate could interleave with a concurrent handler, and the gate without a
     * transaction would not roll back. Composing them here means a host cannot
     * accidentally take one and not the other.
     */
    public async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
        return this.shardHost.runSerialized(async () => this.shardHost.transaction(work));
    }

    /**
     * Handle an HTTP request routed to this shard.
     *
     * Delegates to the host-specific `handlers.handleFetch` while the request
     * router still lives in the host wrapper; returns a 501 when a host mounts
     * the runner without one.
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
     * Delegates to the host-specific `handlers.handleAlarm` when supplied,
     * otherwise no-ops.
     */
    public async handleAlarm(): Promise<void> {
        if (this.options.handlers?.handleAlarm) {
            await this.options.handlers.handleAlarm();
        }
    }
}
