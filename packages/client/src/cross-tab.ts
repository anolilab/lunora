/**
 * Cross-tab WebSocket sharing via BroadcastChannel.
 *
 * One tab is elected the "leader" and owns all WebSocket connections to the
 * server. Follower tabs receive query/subscription deltas through the
 * BroadcastChannel instead of opening their own sockets — reducing connection
 * count, bandwidth, and cross-tab state drift.
 *
 * The coordinator is a no-op when `BroadcastChannel` is unavailable (SSR,
 * React Native, Node.js).
 */

import type { ConnectionStatus } from "./lunora-client";
import type { SubscriptionError } from "./subscription";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TabCoordinatorOptions {
    /**
     * BroadcastChannel name. Defaults to `"lunora-bridge"`.
     */
    channelName?: string;

    /**
     * Interval (ms) between leader heartbeats. Defaults to 1000.
     */
    heartbeatInterval?: number;

    /**
     * Milliseconds without a heartbeat to consider the leader dead. Must be
     * larger than `heartbeatInterval`. Defaults to 3000.
     */
    leaderTimeout?: number;

    /**
     * Called when this tab becomes the leader (should open WS connections).
     */
    onBecomeLeader?: () => void;

    /**
     * Called when the leader broadcasts its aggregate `ConnectionStatus`
     * (see `LunoraClient.emitConnectionStatus`) — a follower owns no socket
     * of its own, so this is its only truthful signal for a status indicator
     * or the offline-queue gate. Sent on every leader-side status change and
     * once more right after a new leader takes over, so a follower already
     * mid-mirroring isn't stuck on a stale value from the PREVIOUS leader.
     */
    onConnectionStatus?: (status: ConnectionStatus) => void;

    /**
     * Called when this tab loses leadership (should close WS connections).
     */
    onStopBeingLeader?: () => void;

    /**
     * Called when the leader broadcasts subscription data. `cursor`/`epoch`
     * ride along when the leader is CLIENT-01-aware, so the follower can drop
     * its own confirmed optimistic layers instead of just displaying the raw
     * value; both are absent on a mixed-version leader that hasn't shipped the
     * cursor yet (the follower falls back to its historical behavior — see
     * `lunora-client.ts`'s `onSubscriptionData` wiring).
     */
    onSubscriptionData?: (key: string, data: unknown, cursor?: number, epoch?: string) => void;

    /**
     * Called when the leader broadcasts a subscription error.
     */
    onSubscriptionError?: (key: string, error: SubscriptionError) => void;

    /**
     * Called when the leader broadcasts a `settled` frame's checkpoint advance
     * (no value change, but the resume cursor moved). A follower needs this
     * too — otherwise a `setQuery`/per-call optimistic overlay that a
     * byte-identical write just confirmed stays masked on follower tabs until
     * the next VISIBLE data frame arrives, even though the leader already
     * dropped it.
     *
     * `lastMutationId` is the LEADER's own per-client `__client_watermark` —
     * scoped server-side to the socket's announced `clientId` — so it only
     * means anything to a follower whose `clientId` matches the leader's
     * (`clientId` rides along for exactly that comparison; see
     * `LunoraClient`'s wiring). An **absent** `clientId` (a mixed-version
     * leader that hasn't shipped this field yet) also skips the
     * `mutationId` half — safe, because the follower's own gates still
     * resolve via its own RPC-ack watermark path and the `CheckpointRegistry`
     * bounded fallback. The checkpoint (cursor) half of this callback fires
     * unconditionally regardless of `clientId` — only the `mutationId` half
     * is scoped.
     */
    onSubscriptionSettled?: (key: string, cursor?: number, epoch?: string, lastMutationId?: number, clientId?: string) => void;
}

type WsFollowerMessage =
    { tabId: string; ts: number; type: "heartbeat" } | { tabId: string; ts: number; type: "claim-leadership" } | { tabId: string; type: "yield-leadership" };

type WsLeaderMessage =
    | { cursor?: number; data: unknown; epoch?: string; key: string; tabId: string; type: "subscription-data" }
    | { error: SubscriptionError; key: string; tabId: string; type: "subscription-error" }
    | { clientId?: string; cursor?: number; epoch?: string; key: string; lastMutationId?: number; tabId: string; type: "subscription-settled" }
    | { status: ConnectionStatus; tabId: string; type: "connection-status" };

type TabCoordinatorMessage = WsFollowerMessage | WsLeaderMessage;

// ---------------------------------------------------------------------------
// TabCoordinator
// ---------------------------------------------------------------------------

let nextTabId = 0;

const DEFAULT_CHANNEL = "lunora-bridge";
const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_LEADER_TIMEOUT_MS = 3000;

class TabCoordinator {
    private readonly bc: BroadcastChannel | undefined;
    private readonly tabId: string;
    private readonly heartbeatInterval: number;
    private readonly leaderTimeout: number;

    /** The tab id of the current known leader, or `undefined` if no leader. */
    private knownLeader: string | undefined = undefined;

    /** `true` when this tab believes it is the leader. */
    private leader: boolean = false;

    /** `true` once `start()` has been called. */
    private running: boolean = false;

    /**
     * `true` while a `claimAndPromote()` claim window is open. Guards the yield
     * handler and `checkLeaderHealth`'s belt-and-braces else-branch so the two
     * promotion paths can't both arm a `becomeLeader` timeout for the same gap.
     */
    private promotionPending: boolean = false;

    /** Timestamp of the most recent leader heartbeat. */
    private lastHeartbeat: number = 0;

    private heartbeatTimer: ReturnType<typeof setInterval> | undefined = undefined;
    private leaderCheckTimer: ReturnType<typeof setInterval> | undefined = undefined;

    /** Callbacks set via constructor options. */
    private readonly onBecomeLeader: (() => void) | undefined;
    private readonly onStopBeingLeader: (() => void) | undefined;
    private readonly onConnectionStatus: ((status: ConnectionStatus) => void) | undefined;
    private readonly onSubscriptionData: ((key: string, data: unknown, cursor?: number, epoch?: string) => void) | undefined;
    private readonly onSubscriptionError: ((key: string, error: SubscriptionError) => void) | undefined;
    private readonly onSubscriptionSettled: ((key: string, cursor?: number, epoch?: string, lastMutationId?: number, clientId?: string) => void) | undefined;

    public constructor(options: TabCoordinatorOptions = {}) {
        // A random UUID suffix makes `tabId` globally unique across tabs/realms,
        // so the `message.tabId < this.tabId` leader-election tie-break is a
        // total order — two tabs opened in the same millisecond can't collide
        // into a split-brain (the `nextTabId` counter resets per realm, and a
        // millisecond timestamp alone doesn't disambiguate).
        nextTabId += 1;
        this.tabId = `tab_${String(nextTabId)}_${crypto.randomUUID()}`;
        this.heartbeatInterval = options.heartbeatInterval ?? DEFAULT_HEARTBEAT_MS;
        this.leaderTimeout = options.leaderTimeout ?? DEFAULT_LEADER_TIMEOUT_MS;
        this.onBecomeLeader = options.onBecomeLeader;
        this.onStopBeingLeader = options.onStopBeingLeader;
        this.onConnectionStatus = options.onConnectionStatus;
        this.onSubscriptionData = options.onSubscriptionData;
        this.onSubscriptionError = options.onSubscriptionError;
        this.onSubscriptionSettled = options.onSubscriptionSettled;

        // BroadcastChannel is browser-only — no-op in SSR/Node/React Native.
        if (typeof BroadcastChannel === "undefined") {
            this.bc = undefined;

            return;
        }

        this.bc = new BroadcastChannel(options.channelName ?? DEFAULT_CHANNEL);
        this.bc.addEventListener("message", (event: MessageEvent<TabCoordinatorMessage>): void => {
            this.handleMessage(event.data);
        });
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Start the coordinator: attempt to claim leadership and begin the
     * heartbeat/leader-check cycle. Safe to call multiple times.
     */
    public start(): void {
        if (this.running) {
            return;
        }

        this.running = true;

        if (this.bc === undefined) {
            // No BroadcastChannel (SSR/Node/React Native) — there are no other
            // tabs to coordinate with, so act as the sole tab and take
            // leadership immediately. Otherwise `isLeader()` would stay `false`
            // forever and every WS-gated caller (see `ensureSocket`) would never
            // open a socket, silently breaking all live subscriptions.
            this.becomeLeader();

            return;
        }

        // Broadcast a claim in case the previous leader is gone.
        this.broadcast({ type: "claim-leadership", tabId: this.tabId, ts: Date.now() });

        // If no response within a single leader-timeout window, assume
        // leadership. The claim message serves as a probe.
        setTimeout(() => {
            if (!this.running) {
                return;
            }

            if (this.knownLeader === undefined) {
                this.becomeLeader();
            }
        }, this.leaderTimeout);

        // Periodically re-check leader health.
        this.leaderCheckTimer = setInterval(() => {
            this.checkLeaderHealth();
        }, this.leaderTimeout);

        // Start the heartbeat loop. It only actually sends when we're the
        // leader, so it's safe to run continuously on every tab.
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, this.heartbeatInterval);
    }

    /**
     * Stop the coordinator: yield leadership (if held), close the channel, and
     * clear all timers. Safe to call multiple times.
     */
    public stop(): void {
        this.running = false;

        if (this.leader) {
            this.broadcast({ type: "yield-leadership", tabId: this.tabId });
            this.leader = false;
            this.knownLeader = undefined;
            this.onStopBeingLeader?.();
        }

        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }

        if (this.leaderCheckTimer !== undefined) {
            clearInterval(this.leaderCheckTimer);
            this.leaderCheckTimer = undefined;
        }

        this.bc?.close();
    }

    /** `true` when this tab is the current WebSocket leader. */
    public isLeader(): boolean {
        return this.leader;
    }

    /** The tab id of the current leader, or `undefined` if unknown / no leader. */
    public get leaderTabId(): string | undefined {
        return this.knownLeader;
    }

    /** The id of this tab. */
    public get id(): string {
        return this.tabId;
    }

    /** `true` when the coordinator has been started and is not yet stopped. */
    public get isRunning(): boolean {
        return this.running;
    }

    // -----------------------------------------------------------------------
    // Broadcasting
    // -----------------------------------------------------------------------

    /**
     * Broadcast subscription data to all follower tabs. Only the leader should
     * call this. `cursor`/`epoch` are omitted from the wire frame when
     * `undefined` (e.g. a CDC-off shard) — a follower on ANY version treats a
     * missing `cursor` as "no confirmed-layer drop this frame", so omitting it
     * here is equivalent to sending it as `undefined`.
     */
    public broadcastSubscriptionData(key: string, data: unknown, cursor?: number, epoch?: string): void {
        if (!this.leader) {
            return;
        }

        this.broadcast({
            type: "subscription-data",
            tabId: this.tabId,
            key,
            data,
            ...(cursor === undefined ? {} : { cursor }),
            ...(epoch === undefined ? {} : { epoch }),
        });
    }

    /**
     * Broadcast a subscription error to all follower tabs. Only the leader
     * should call this.
     */
    public broadcastSubscriptionError(key: string, error: SubscriptionError): void {
        if (!this.leader) {
            return;
        }

        this.broadcast({ type: "subscription-error", tabId: this.tabId, key, error });
    }

    /**
     * Broadcast a `settled` frame's checkpoint advance to all follower tabs
     * (no value change, but the resume cursor/epoch moved — see
     * `LunoraClient.handleSettledMessage`). `clientId` is this (leader) tab's
     * own client id, stamped so a follower can tell whether the echoed
     * `lastMutationId` watermark is genuinely its own (see the
     * `onSubscriptionSettled` docblock). Only the leader should call this.
     */
    public broadcastSubscriptionSettled(key: string, cursor?: number, epoch?: string, lastMutationId?: number, clientId?: string): void {
        if (!this.leader) {
            return;
        }

        this.broadcast({
            type: "subscription-settled",
            tabId: this.tabId,
            key,
            ...(cursor === undefined ? {} : { cursor }),
            ...(epoch === undefined ? {} : { epoch }),
            ...(lastMutationId === undefined ? {} : { lastMutationId }),
            ...(clientId === undefined ? {} : { clientId }),
        });
    }

    /**
     * Broadcast this tab's aggregate `ConnectionStatus` to follower tabs, so
     * they can mirror a truthful status without a socket of their own (see
     * `LunoraClient.computeStatus`/`emitConnectionStatus`). Only the leader
     * should call this.
     */
    public broadcastConnectionStatus(status: ConnectionStatus): void {
        if (!this.leader) {
            return;
        }

        this.broadcast({ type: "connection-status", tabId: this.tabId, status });
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private broadcast(message: TabCoordinatorMessage): void {
        // bc.postMessage is synchronous in modern browsers.
        this.bc?.postMessage(message);
    }

    private handleMessage(message: TabCoordinatorMessage): void {
        switch (message.type) {
            case "claim-leadership": {
                this.handleClaimLeadership(message);

                break;
            }

            case "connection-status": {
                if (this.leader || message.tabId === this.tabId) {
                    break;
                }

                this.onConnectionStatus?.(message.status);

                break;
            }

            case "heartbeat": {
                this.handleHeartbeat(message);

                break;
            }

            case "subscription-data": {
                if (this.leader || message.tabId === this.tabId) {
                    break; // ignore our own broadcasts
                }

                this.onSubscriptionData?.(message.key, message.data, message.cursor, message.epoch);

                break;
            }

            case "subscription-error": {
                if (this.leader || message.tabId === this.tabId) {
                    break;
                }

                this.onSubscriptionError?.(message.key, message.error);

                break;
            }

            case "subscription-settled": {
                if (this.leader || message.tabId === this.tabId) {
                    break;
                }

                this.onSubscriptionSettled?.(message.key, message.cursor, message.epoch, message.lastMutationId, message.clientId);

                break;
            }

            case "yield-leadership": {
                // The leader is stepping down. If it's the one we know, clear
                // and immediately attempt to claim leadership ourselves —
                // waiting for the next health-check tick (up to
                // `leaderTimeout`) before even starting the claim window would
                // double the freeze every remaining tab experiences.
                if (this.knownLeader === message.tabId) {
                    this.knownLeader = undefined;

                    if (this.running && !this.leader) {
                        this.claimAndPromote();
                    }
                }

                break;
            }

            default: {
                // Exhaustive over the union — no other message types exist.
                break;
            }
        }
    }

    private handleClaimLeadership(message: Extract<WsFollowerMessage, { type: "claim-leadership" }>): void {
        if (message.tabId === this.tabId) {
            return;
        }

        // We're the current leader — assert our position with a heartbeat so
        // the claimant defers to us.
        if (this.leader) {
            this.broadcast({ type: "heartbeat", tabId: this.tabId, ts: Date.now() });

            return;
        }

        // A claim is NOT proof of an active leader — only a `heartbeat`
        // establishes `knownLeader` (see `handleHeartbeat`). When two tabs
        // start together and both claim with no leader yet, break the tie
        // deterministically: the lexicographically-smaller `tabId` wins.
        // Defer only if the *other* tab's id sorts first, so our own
        // promotion timeout stands down; the winner self-promotes and its
        // heartbeat then confirms leadership for everyone. If both adopted
        // each other here, neither would ever promote.
        if (this.knownLeader === undefined && message.tabId < this.tabId) {
            this.knownLeader = message.tabId;
            // Stamp `lastHeartbeat` at adoption time (using the claim's own
            // timestamp) — leaving it at its stale/zero default would make
            // `checkLeaderHealth` see an immediately-expired leader (elapsed
            // since epoch/last-known-heartbeat > leaderTimeout) and un-adopt
            // on its very next tick, re-claim, and re-adopt the same tab
            // again next round: permanent un-adopt/re-claim churn instead of
            // a settled deference to the smaller id.
            this.lastHeartbeat = message.ts;
        }
    }

    private handleHeartbeat(message: Extract<WsFollowerMessage, { type: "heartbeat" }>): void {
        if (message.tabId === this.tabId) {
            return;
        }

        if (this.leader) {
            this.resolveLeaderVsLeaderTieBreak(message);

            return;
        }

        // Record the leader's heartbeat to track liveness.
        this.lastHeartbeat = message.ts;
        this.knownLeader = message.tabId;
    }

    /**
     * Resolve two leaders existing at once — e.g. this tab was backgrounded
     * and its heartbeat/health timers were throttled while a foreground
     * follower's were not, so the follower's `checkLeaderHealth` timed out
     * the (still-alive) leader and self-promoted. `BroadcastChannel` message
     * delivery isn't subject to the same timer-throttling clamp, so even a
     * backgrounded leader eventually observes the pretender's heartbeat here
     * — resolve the split-brain deterministically with the same
     * lexicographically-smaller-tabId rule used at claim-adoption. If the
     * other tab wins, step down; if we win, reassert immediately so the
     * pretender demotes itself the moment it processes our heartbeat.
     */
    private resolveLeaderVsLeaderTieBreak(message: Extract<WsFollowerMessage, { type: "heartbeat" }>): void {
        if (message.tabId < this.tabId) {
            this.leader = false;
            this.knownLeader = message.tabId;
            this.lastHeartbeat = message.ts;
            this.onStopBeingLeader?.();
        } else {
            this.broadcast({ type: "heartbeat", tabId: this.tabId, ts: Date.now() });
        }
    }

    private becomeLeader(): void {
        if (this.leader) {
            return;
        }

        this.leader = true;
        this.knownLeader = this.tabId;
        this.lastHeartbeat = Date.now();
        this.onBecomeLeader?.();

        // Announce our leadership so other tabs can follow.
        this.broadcast({ type: "heartbeat", tabId: this.tabId, ts: Date.now() });
    }

    private sendHeartbeat(): void {
        if (!this.leader) {
            return;
        }

        this.broadcast({ type: "heartbeat", tabId: this.tabId, ts: Date.now() });
    }

    private checkLeaderHealth(): void {
        if (!this.running) {
            return;
        }

        // If we're the leader, no need to check.
        if (this.leader) {
            return;
        }

        // No known leader at all — belt-and-braces recovery for any path
        // (besides `yield-leadership`, which already claims immediately) that
        // strands `knownLeader`. `claimAndPromote` no-ops while a claim
        // window is already open, so this can't stack a second `becomeLeader`
        // timeout on top of one already in flight.
        if (this.knownLeader === undefined) {
            this.claimAndPromote();

            return;
        }

        // We have a known leader but haven't heard from them...
        const elapsed = Date.now() - this.lastHeartbeat;

        if (elapsed > this.leaderTimeout) {
            // Leader is gone — attempt to claim.
            this.knownLeader = undefined;
            this.claimAndPromote();
        }
    }

    /**
     * Broadcast a leadership claim and arm a `becomeLeader` fallback: if no
     * other tab has asserted itself as leader by the time the window elapses,
     * self-promote. Shared by `checkLeaderHealth`'s stale-leader path and the
     * `yield-leadership` handler so both promotion triggers use one claim
     * window instead of each arming its own timeout.
     */
    private claimAndPromote(): void {
        if (this.promotionPending) {
            return;
        }

        this.promotionPending = true;
        this.broadcast({ type: "claim-leadership", tabId: this.tabId, ts: Date.now() });

        // Become leader if no one responds within a short window.
        setTimeout(() => {
            this.promotionPending = false;

            if (this.running && this.knownLeader === undefined) {
                this.becomeLeader();
            }
        }, this.leaderTimeout);
    }
}

export type { TabCoordinatorOptions };
export { TabCoordinator };
