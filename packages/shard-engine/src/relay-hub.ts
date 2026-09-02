/**
 * Auto-elastic fan-out relay tier — the stateful transport, split by ROLE (plan
 * 075, review-hardened). A `ShardDO` is, for its whole life, EITHER the owner of
 * a shard or one of its relays — fixed by its DO name. So the relay state +
 * methods live on two role-typed collaborators chosen ONCE from the name:
 *
 * - {@link OwnerRelay} (the shard owner) owns the relay set, the relay-uniform shape
 * registry + proxy registry + uniform-cache, the RLS-uniform gate, the cohort
 * multicast and per-socket proxy, and the seed-frame builder.
 * - {@link RelayMember} (a relay DO) owns its per-socket cohort memos and its announce
 * latch; it seeds its sockets' shapes THROUGH the owner and delivers the owner's
 * multicast/proxy pokes.
 *
 * Both share {@link RelayLink} (sibling addressing + whisper local-delivery + the
 * `/_lunora/relay` control-channel dispatch). The owning DO reaches everything it
 * needs through the narrow {@link RelayHost} seam — so this whole subsystem is
 * decoupled from the 8k-line DO class, and owner-only state can never sit next to
 * relay-only state. Everything here is internal: the wire frames are NOT the
 * public client protocol (the relay tier is invisible runtime elasticity).
 */

/* eslint-disable max-classes-per-file -- the role-split is three cohesive collaborators by design: a shared RelayLink base plus the OwnerRelay and RelayMember role classes. */

import { LunoraError, toErrorBody } from "@lunora/errors";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { SqlExec } from "./ctx-db";
import {
    deleteAllRelayShapes,
    deleteRelayShapesForConnection,
    deleteRelayShapesForRelay,
    migrateRelayShapes,
    readRelayShapes,
    writeRelayShape,
    writeRelayShapeCursor,
} from "./ctx-db-relay-shapes";
import { envPositiveInt } from "./env-int";
import type { MaskPoliciesResult, RlsPoliciesResult } from "./introspect";
import { stableWireKey } from "./reactive-cache";
import type { OwnerRelayFrame, PromotionState, RelayFrame, RelayShapePoke, RelayShapeSeed, RelayShapeSubscribe, RelayShapeUnsubscribe } from "./relay";
import { clampPromotionThresholds, DEFAULT_PROMOTION_THRESHOLDS, nextPromotionState, parseRelayName, relayName, relayProxyKey, shapeRoutingKey } from "./relay";
import type { ShapeRowOp } from "./shape-global-diff";
import { buildPokeFrames, encodeRowsPatch } from "./shape-global-diff";
import type { SiblingStub } from "./sibling-channel";
import { RELAY_SIGNATURE_HEADER, siblingSecretOf, siblingStub, signSiblingBody, verifySiblingBody } from "./sibling-channel";
import { awaitWsDrain, trySendFrame } from "./subscription-delivery";
import type { ResolvedShape, ShapeSubscriptionQuery, ShardSocketLike, SocketAttachment, SubscriptionIdentity } from "./types";

/** Fixed relay-fan when a shard promotes (per-deployment via `LUNORA_RELAY_FAN`). */
const DEFAULT_RELAY_FAN = 2;

/** Hard ceiling on relays per shard (per-deployment via `LUNORA_MAX_RELAYS`) — the cost cap a viral shard can never exceed. */
const DEFAULT_MAX_RELAYS = 8;

/**
 * The identity the owner computes a relay-multicast shape delta under (plan 075
 * Phase 3). It is the empty (anonymous) identity, and it is **load-bearing for
 * RLS**: a shape may only be relay-multicast if the uniform gate has PROVEN its
 * resolved query is identical for this exact identity and every other — so the
 * one delta computed here is correct for every cohort subscriber. The gate probes
 * this same constant (see {@link OwnerRelay.probeShapeRelayUniform}), so the
 * validated identity and the multicast identity can never drift apart.
 */
const RELAY_MULTICAST_IDENTITY: SubscriptionIdentity = {};

/**
 * One registered relay-uniform shape: the cohort the owner multicasts a single
 * delta to. `cursor` is the frontier that delta has been computed up to, and
 * `key` is its row in `__lunora_relay_shapes` — every move of the cursor writes
 * through to it, so an evicted owner rehydrates the frontier instead of the
 * literal `0` a fresh `Map` would imply.
 */
interface CohortShapeEntry {
    args: Record<string, unknown>;
    cursor: number;
    key: string;
    name: string;
}

/**
 * One registered NON-uniform (identity-scoped) relay shape: a single relayed
 * socket, served by a poke computed under its OWN forwarded identity and
 * addressed to its connection. Carries the cohort fields so the shared poke
 * pipeline can take either.
 */
interface ProxyShapeEntry extends CohortShapeEntry {
    connectionId: string;
    identity: SubscriptionIdentity;
    relayIndex: number;
}

/** Exhaustiveness guard for the {@link OwnerRelayFrame} dispatch — an unhandled member is a compile error here, and an impossible runtime frame throws rather than silently mis-routing. */
const assertNeverFrame = (frame: never): never => {
    throw new LunoraError("INTERNAL", `unhandled relay frame: ${JSON.stringify(frame)}`);
};

/**
 * The narrow seam the relay tier reaches the owning DO through — shape resolution,
 * the op-log diff/seed primitives, the socket set + attachment reader, the namespace
 * binding, and the shared poke-id / fan-out counters. Keeps the relay collaborators
 * decoupled from the DO class and from each other.
 */
interface RelayHost {
    /** Resolve a shape's op-log diff over `(fromCursor, toCursor]` against this DO's SQLite (the owner's op-log). */
    buildShapeDiff: (resolved: ResolvedShape, fromCursor: number, toCursor: number) => ShapeRowOp[];
    /** Compute a shape's seed (cursor/epoch/resume base + membership patch) without sending — the shared core of the local seed and the relayed seed. */
    computeOpLogShapeSeed: (
        shape: ShapeSubscriptionQuery,
        resolved: ResolvedShape,
    ) => { baseCheckpoint: number | undefined; cursor: number; epoch: string | undefined; reset: boolean; rowsPatch: ShapeRowOp[] };
    /** The current CDC epoch (changelog timeline token); `undefined` when CDC is off. */
    currentCdcEpoch: () => string | undefined;
    /** Deliver an already-serialized whisper frame to the DO's local `topic` members (the base whisper fan-out, used whether or not the relay tier is active). */
    deliverWhisperLocal: (topic: string, frame: string, exclude: undefined | ShardSocketLike) => number;
    /** This DO's name (the shard key for an owner, the `…::relay::N` name for a relay), or `undefined` for an unnamed DO. */
    doName: () => string | undefined;
    /** This DO's env record (read for relay binding + threshold/fan/cap knobs). */
    env: () => unknown;
    /** This DO's live hibernatable sockets. */

    /**
     * The shard's live sockets, as the host's handles — the same identity the
     * relay's per-socket memos are keyed on. Raw provider sockets would key
     * differently and silently miss every memo lookup.
     */
    getWebSockets: () => ShardSocketLike[];
    /** The schema's masked columns (codegen-emitted), for the gate's mask check. */
    maskMetadata: () => MaskPoliciesResult;
    /** A fresh, process-unique poke id (shared monotonic counter with the owner-local poke path). */
    nextPokeId: () => string;
    /** Deserialize a socket's hibernation attachment. */
    readAttachment: (ws: ShardSocketLike) => SocketAttachment;
    /** Record a shape-poke fan-out pass into `getFanoutMetrics.shapePoke`. */
    recordShapePokeFanout: (iterated: number, delivered: number, elapsedMs: number) => void;
    /** Resolve a shape under a given identity (RLS-correct); the codegen subclass dispatches via its generated registry. */
    resolveShape: (name: string, args: Record<string, unknown>, identity?: SubscriptionIdentity) => ResolvedShape | undefined;
    /** The schema's RLS policies (codegen-emitted), for the gate's static read-policy guard. */
    rlsMetadata: () => RlsPoliciesResult;
    /** The namespace binding name this DO was reached through (learned from `x-lunora-shard-binding`), or `undefined` until known. */
    shardBinding: () => string | undefined;
    /** This DO's SQLite executor (for the owner's `__lunora_relays` set table). */
    sql: () => SqlExec;
}

/**
 * Whether an owner-multicast poke may be applied to a relay socket sitting at
 * `memo` for that shape.
 *
 * The cursor test is a RANGE, not an equality. A socket at exactly `fromCursor`
 * is the normal case, but the owner rewinds a shape's frontier whenever a POST
 * to any relay in the cohort failed, so the next poke legitimately reopens a
 * range the sockets on the surviving relays have already applied. Admitting
 * those is what makes that repair land: a shape diff ships each changed key's
 * CURRENT membership and value, so a reopened range re-applies rows the socket
 * already holds and adds the ones it missed. An equality test dropped it
 * instead — and since the frontier never came back, dropped every future poke
 * too, leaving the socket frozen on stale rows for the rest of its life.
 *
 * The two refusals are real, though. BEHIND the poke's base (`memo.cursor <
 * fromCursor`, or no memo at all) means the socket missed the keys changed in
 * `(memo.cursor, fromCursor]`, so this patch would leave it wrong in a way it
 * could never detect. At or past `checkpoint` means it has already applied this
 * range, and rewinding its memo would only widen the next diff. A memo on a
 * different `epoch` is a different timeline entirely.
 */
const pokeAppliesToMemo = (memo: undefined | { cursor: number; epoch?: string }, poke: RelayShapePoke): boolean => {
    if (memo === undefined || memo.epoch !== poke.epoch) {
        return false;
    }

    return memo.cursor >= poke.fromCursor && memo.cursor < poke.checkpoint;
};

/** Build a JSON `Response` (the owner's seed reply on the control channel). */
const jsonRelayResponse = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" } });

// eslint-disable-next-line unicorn/no-null -- 204 No Content has no body; null is the standard "no body" value
const noContent = (): Response => new Response(null, { status: 204 });

/**
 * Shared owner↔relay link: sibling addressing, whisper local-delivery, and the
 * `/_lunora/relay` control-channel dispatch (a single exhaustive switch over the
 * frame union, with role-specific hooks the subclasses implement). The role
 * identity (`roleId`) is fixed at construction from the DO name.
 */
abstract class RelayLink {
    protected constructor(
        protected readonly host: RelayHost,
        /** This DO's fixed role addressing — an owner's own key (no index), or a relay's owner key + slot. */
        protected readonly roleId: { ownerKey: string; relayIndex?: number },
    ) {}

    /**
     * Serve the internal `/_lunora/relay` control channel: parse the frame, then
     * dispatch to the role hooks. One exhaustive switch means a new frame type added
     * to `relay.ts` without a case here is a COMPILE error, not a runtime mis-route.
     */
    public async handleControl(request: Request): Promise<Response> {
        // Read the raw body first so we can authenticate it before parsing (L6).
        let raw: string;

        try {
            raw = await request.text();
        } catch {
            return new Response("bad request", { status: 400 });
        }

        // When a relay secret is configured, require a valid HMAC over the raw
        // body. Fail closed on a missing/mismatched signature so a forged frame
        // can't reach the dispatch below. Unconfigured ⇒ legacy network-trust.
        if (!(await verifySiblingBody(this.host.env(), request.headers.get(RELAY_SIGNATURE_HEADER), raw))) {
            return new Response("forbidden", { status: 403 });
        }

        let message: OwnerRelayFrame;

        try {
            message = JSON.parse(raw) as OwnerRelayFrame;
        } catch {
            return new Response("bad request", { status: 400 });
        }

        switch (message.type) {
            case "relay_attach": {
                this.onAttach(message.relayIndex);

                return noContent();
            }
            case "relay_detach": {
                this.onDetach(message.relayIndex);

                return noContent();
            }
            case "relay_frame": {
                this.host.deliverWhisperLocal(message.topic, message.frame, undefined);
                await this.onWhisperFrame(message);

                return noContent();
            }
            case "relay_shape_poke": {
                // Deliver to this relay's cohort sockets, recording the fan-out so a
                // relay's metrics reflect the delivery work it actually does. Decode
                // ONLY the wire-encoded `args` (they cross the hub's JSON hop encoded
                // so a `bigint`/`Date`/bytes arg survives) — the routing match keys
                // decoded args on both sides. `rowsPatch` stays encoded on purpose:
                // the relay re-frames it verbatim (`preEncoded`).
                const iterated = this.host.getWebSockets().length;
                const startMs = Date.now();
                const delivered = this.onShapePoke({ ...message, args: decodeWire(message.args) as Record<string, unknown> });

                this.host.recordShapePokeFanout(iterated, delivered, Date.now() - startMs);

                return noContent();
            }
            case "relay_shape_subscribe": {
                // Decode the wire-encoded shape args (see `seedRelayShape`, the
                // sending side) so the owner resolves/registers under REAL values —
                // mirroring the shard's own `shape_subscribe` decode-at-entry.
                return jsonRelayResponse(this.onShapeSubscribe({ ...message, args: decodeWire(message.args) as Record<string, unknown> }));
            }
            case "relay_shape_unsubscribe": {
                this.onShapeUnsubscribe(message);

                return noContent();
            }
            default: {
                return assertNeverFrame(message);
            }
        }
    }

    /** The hard cap on relays per shard (`LUNORA_MAX_RELAYS`) — a deployment constant the runtime surfaces in Studio as the cost ceiling. */
    public maxRelays(): number {
        return envPositiveInt(this.host.env(), "LUNORA_MAX_RELAYS", DEFAULT_MAX_RELAYS);
    }

    /**
     * Whether this DO can currently address its siblings (a namespace binding
     * has been learned) — the relay tier is inert in single-DO mode. Probed
     * through the same resolution the sends use, so "can address" and "did
     * address" can never disagree.
     */
    protected canAddressSiblings(): boolean {
        return this.siblingStub(this.roleId.ownerKey) !== undefined;
    }

    /** Resolve a sibling owner/relay by name off this DO's namespace binding. */
    protected siblingStub(targetName: string): SiblingStub | undefined {
        return siblingStub(this.host.env(), this.bindingName(), targetName);
    }

    /**
     * The namespace binding this DO addresses siblings through. In-memory by
     * default — the runtime stamps it on every forwarded request, so any DO woken
     * BY a request knows it. {@link OwnerRelay} overrides this; see there for the
     * wake that carries no request.
     */
    protected bindingName(): string | undefined {
        return this.host.shardBinding();
    }

    /** POST a control frame to a sibling by name, fire-and-forget. Best-effort: a transient cross-DO failure drops the frame rather than throwing into the handler. */
    protected async postRelayMessage(targetName: string, message: OwnerRelayFrame): Promise<void> {
        await this.requestRelayMessage(targetName, message);
    }

    /**
     * POST a control frame to a sibling by name and return its response (the shape-seed
     * path needs the owner's frames back). Best-effort: a transient cross-DO failure
     * returns `undefined` rather than throwing.
     * @returns the sibling's response, or `undefined` when it can't be reached
     */
    protected async requestRelayMessage(targetName: string, message: OwnerRelayFrame): Promise<Response | undefined> {
        const stub = this.siblingStub(targetName);

        if (stub === undefined) {
            return undefined;
        }

        const body = JSON.stringify(message);
        const headers: Record<string, string> = { "content-type": "application/json", "x-lunora-shard-binding": this.host.shardBinding() ?? "" };

        // Sign the control-frame body when a relay secret is configured (L6), so
        // the receiver can authenticate it. Signed over the exact bytes we send.
        const secret = siblingSecretOf(this.host.env());

        if (secret !== undefined) {
            headers[RELAY_SIGNATURE_HEADER] = await signSiblingBody(secret, body);
        }

        try {
            return await stub.fetch("https://relay.internal/_lunora/relay", {
                body,
                headers,
                method: "POST",
            });
        } catch {
            // Best-effort hub forwarding — a dropped ephemeral frame is tolerable.
            return undefined;
        }
    }

    /** Forward an opaque whisper frame through the hub (owner → its relays, or relay → its owner). No-op in single-DO mode. */
    public abstract forwardWhisper(topic: string, frame: string): Promise<void>;

    /** Owner-side per-flush fan-out (cohort multicast + per-socket proxy); a no-op on a relay (relays never flush their own writes). */
    public abstract onFlush(changed: Set<string>, frameCursor: number): Promise<void>;

    /** Seed a shape held by a socket on a relay through the owner; `undefined` on an owner (the caller falls through to its local seed path). */
    public abstract seedRelayShape(
        ws: ShardSocketLike,
        subId: string,
        shape: ShapeSubscriptionQuery,
        identity: SubscriptionIdentity,
    ): Promise<"ok" | undefined | { code: string; message: string }>;

    /** A relay announces itself to its owner on its first subscriber (so the owner forwards to it); a no-op on an owner. */
    public abstract announce(): Promise<void>;

    /** A relay detaches from its owner once its last socket closes; a no-op on an owner. */
    public abstract announceDrain(closing: ShardSocketLike): Promise<void>;

    /**
     * A relay tells its owner that `ws` has given up a relayed shape — one
     * subscription (`subId`) or, on close, all of them — so the owner can drop
     * the per-socket proxy registrations it would otherwise hold for the life of
     * the relay. A no-op on an owner (its own sockets register nothing relayed)
     * and on a socket that carries no connection id (nothing was ever
     * registered for it — {@link OwnerRelay.buildShapeSeedFrames} refuses that
     * seed outright).
     */
    public abstract releaseRelayShapes(ws: ShardSocketLike, subId?: string): Promise<void>;

    /** How many relays the runtime should spread new connections across for this shard (owner decides; a relay returns 0). */
    public abstract relayCount(): number;

    /** Whether a reactive shape may be relay-multicast (the RLS-uniform gate); `false` on a relay (the gate is an owner concern). */
    public abstract isShapeRelayUniform(name: string, args: Record<string, unknown>): boolean;

    /**
     * The lowest op-log cursor any relayed shape still has to be diffed from, or
     * `undefined` when this tier holds none.
     *
     * A relayed subscriber's resume position lives here and nowhere else — unlike
     * a local socket, it records no `__shape_poke_cursor` row. So a changelog
     * retention sweep that reads only that table sees a relayed cohort as having
     * no cursor at all and is free to delete the very rows the next
     * {@link RelayHost.buildShapeDiff} has to read. That produces no error: the
     * diff simply finds fewer changed keys than there were, and every relayed
     * client silently keeps rows that moved. (The owner's registry is itself
     * durable — `__lunora_relay_shapes` — so this answer survives the eviction
     * that used to zero it, which is precisely the moment the floor mattered.)
     *
     * Exposing the frontier is what lets `ShardDO.retentionFloor` pull the floor
     * down to cover them. It is a pure read — deliberately, since a retention
     * sweep must not advance a promotion latch or any other state.
     */
    public abstract minShapeCursor(): number | undefined;

    /** Control-channel hook: an owner adds a relay to its set; a relay no-ops. */
    protected abstract onAttach(index: number): void;

    /** Control-channel hook: an owner drops a relay from its set; a relay no-ops. */
    protected abstract onDetach(index: number): void;

    /** Control-channel hook: an owner re-distributes a relay-forwarded whisper to its OTHER relays; a relay no-ops. */
    protected abstract onWhisperFrame(message: RelayFrame): Promise<void>;

    /** Control-channel hook: an owner builds the seed frames for a relay subscriber; a relay errors (it can't seed). */
    protected abstract onShapeSubscribe(message: RelayShapeSubscribe): RelayShapeSeed;

    /** Control-channel hook: an owner drops a relay socket's proxy registrations; a relay no-ops. */
    protected abstract onShapeUnsubscribe(message: RelayShapeUnsubscribe): void;

    /** Control-channel hook: a relay delivers an owner-multicast poke to its cohort sockets and returns the delivered count; an owner returns 0. */
    protected abstract onShapePoke(poke: RelayShapePoke): number;
}

/**
 * The shard OWNER's relay collaborator (plan 075). It holds the only op-log, so it
 * computes every relayed shape delta — the cohort multicast for relay-uniform
 * shapes and a per-socket proxy for non-uniform ones — and decides promotion. Its
 * state (relay set + registries + uniform cache) is owner-only by construction.
 */
class OwnerRelay extends RelayLink {
    /** Memoized RLS-uniform verdict per `(name, args)` shape — uniformity is stable, so the gate probe runs at most once per distinct shape. */
    private readonly shapeUniformCache = new Map<string, boolean>();

    /** Active relay indices, hydrated once from `__lunora_relays` and cached for the synchronous forward path. */
    private relaySetCache: Set<number> | undefined;

    /**
     * The shape registry, hydrated once per wake from `__lunora_relay_shapes` —
     * see {@link OwnerRelay.relayShapes} for why it is read back from SQLite
     * rather than started empty. `cohort` holds the relay-uniform shapes keyed
     * by `(name, args)`, whose one delta is multicast to the whole relay set;
     * `proxies` holds the NON-uniform ones, one entry per relay socket keyed
     * `relayIndex:connectionId:subId`, each served by its own identity-scoped
     * poke.
     */
    private registryCache: { cohort: Map<string, CohortShapeEntry>; proxies: Map<string, ProxyShapeEntry> } | undefined;

    /** The binding this owner last saw or read back, memoized so a cold wake reads `__lunora_relay_binding` at most once. See {@link OwnerRelay.bindingName}. */
    private recordedBinding: string | undefined;

    /** The owner's current promotion state (plan 075 Phase 4), carried across `relayCount()` calls so hysteresis has memory — a shard hovering near the threshold can't flap. */
    private promotionState: PromotionState = "owned";

    public constructor(host: RelayHost, ownerKey: string) {
        super(host, { ownerKey });
    }

    public override async forwardWhisper(topic: string, frame: string): Promise<void> {
        if (!this.canAddressSiblings()) {
            return;
        }

        const relays = this.ownerRelaySet();

        if (relays.size === 0) {
            return;
        }

        await Promise.all([...relays].map((index) => this.postRelayMessage(relayName(this.roleId.ownerKey, index), { frame, topic, type: "relay_frame" })));
    }

    public override async onFlush(changed: Set<string>, frameCursor: number): Promise<void> {
        // An owner that cannot address a sibling has no relay to fan out to, and
        // every send below would resolve to `undefined` and drop. Checking here
        // keeps the whole tier — including the SQLite reads behind the relay set
        // and the shape registry — off the flush path of a single-DO shard,
        // which is the overwhelming majority of them.
        if (!this.canAddressSiblings()) {
            return;
        }

        await Promise.all([this.multicastShapePokes(changed, frameCursor), this.proxyShapePokes(changed, frameCursor)]);
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: an owner serves its own shape subscribers locally, never through a relay
    public override seedRelayShape(): Promise<"ok" | undefined | { code: string; message: string }> {
        return Promise.resolve(undefined);
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: only a relay announces
    public override announce(): Promise<void> {
        return Promise.resolve();
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: only a relay drains
    public override announceDrain(): Promise<void> {
        return Promise.resolve();
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: an owner's own sockets register no relayed shapes, so there is nothing to release
    public override releaseRelayShapes(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * How many relays the runtime should spread new connections across for this shard
     * (plan 075 Phase 2, hysteresis added in Phase 4). `0` keeps every connection on
     * the owner. The owner promotes once its live socket count reaches
     * `LUNORA_RELAY_THRESHOLD` (`tUp`), fanning to a fixed `LUNORA_RELAY_FAN` (capped
     * by `LUNORA_MAX_RELAYS`, the cost ceiling), and only collapses back to
     * owner-served once subscribers drain below `LUNORA_RELAY_COLLAPSE_THRESHOLD`
     * (`tDown`) — the band between the two holds the current state so a shard
     * hovering near the threshold can't flap. {@link clampPromotionThresholds}
     * guarantees a valid `tDown < tUp` band even under a misconfigured collapse
     * threshold. Advances the promotion latch, so it is not a pure read.
     */
    public override relayCount(): number {
        const subscribers = this.host.getWebSockets().length;
        const tUp = envPositiveInt(this.host.env(), "LUNORA_RELAY_THRESHOLD", DEFAULT_PROMOTION_THRESHOLDS.tUp);
        const tDownRaw = envPositiveInt(this.host.env(), "LUNORA_RELAY_COLLAPSE_THRESHOLD", DEFAULT_PROMOTION_THRESHOLDS.tDown);

        this.promotionState = nextPromotionState(this.promotionState, subscribers, clampPromotionThresholds(tUp, tDownRaw));

        if (this.promotionState === "owned") {
            return 0;
        }

        const fan = envPositiveInt(this.host.env(), "LUNORA_RELAY_FAN", DEFAULT_RELAY_FAN);

        return Math.min(this.maxRelays(), Math.max(1, fan));
    }

    /**
     * The owner's relayed-shape frontier: the minimum over the cohort registry and
     * the per-socket proxies. See {@link RelayLink.minShapeCursor} for why a
     * retention sweep must consult it.
     */
    public override minShapeCursor(): number | undefined {
        const { cohort, proxies } = this.relayShapes();
        let floor: number | undefined;

        for (const entry of [...cohort.values(), ...proxies.values()]) {
            floor = floor === undefined ? entry.cursor : Math.min(floor, entry.cursor);
        }

        return floor;
    }

    /**
     * The RLS-uniform gate (plan 075 Phase 3, review-hardened): whether a reactive
     * shape may be relay-multicast — i.e. one delta is correct for **every**
     * subscriber. Fail-closed on four grounds — a static RLS read-policy guard, the
     * anonymous multicast identity as the probe base, two `Proxy`-backed probes that
     * yield a distinct value for ANY accessed claim (so any claim a `where` reads —
     * even a custom one outside `rls()` — diverges), and a wholesale-copy backstop.
     * Cached per `(name, args)`, whose uniformity is stable.
     */
    public override isShapeRelayUniform(name: string, args: Record<string, unknown>): boolean {
        const cacheKey = shapeRoutingKey(name, args);
        const cached = this.shapeUniformCache.get(cacheKey);

        if (cached !== undefined) {
            return cached;
        }

        const uniform = this.probeShapeRelayUniform(name, args);

        this.shapeUniformCache.set(cacheKey, uniform);

        return uniform;
    }

    /**
     * Drop the proxy registrations a relay socket held, in memory and durably.
     * `subId` scopes it to one subscription; absent covers the whole connection
     * (its socket closed). Cohort entries are untouched — one serves the entire
     * relay set, so no single socket may retire it.
     */
    protected override onShapeUnsubscribe(message: RelayShapeUnsubscribe): void {
        const { proxies } = this.relayShapes();
        const scoped = message.subId === undefined ? undefined : relayProxyKey(message.relayIndex, message.connectionId, message.subId);

        for (const [key, entry] of proxies) {
            if (entry.relayIndex !== message.relayIndex || entry.connectionId !== message.connectionId) {
                continue;
            }

            if (scoped === undefined || key === scoped) {
                proxies.delete(key);
            }
        }

        deleteRelayShapesForConnection(this.host.sql(), message.relayIndex, message.connectionId, message.subId);
    }

    protected override onAttach(index: number): void {
        this.addRelayToSet(index);
    }

    protected override onDetach(index: number): void {
        this.removeRelayFromSet(index);
    }

    protected override async onWhisperFrame(message: RelayFrame): Promise<void> {
        // The owner re-distributes a relay-forwarded whisper to every OTHER relay, so
        // one whisper reaches the whole shard exactly once per socket.
        await Promise.all(
            [...this.ownerRelaySet()]
                .filter((index) => index !== message.originRelay)
                .map((index) =>
                    this.postRelayMessage(relayName(this.roleId.ownerKey, index), { frame: message.frame, topic: message.topic, type: "relay_frame" }),
                ),
        );
    }

    protected override onShapeSubscribe(message: RelayShapeSubscribe): RelayShapeSeed {
        return this.buildShapeSeedFrames(message);
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: an owner doesn't receive multicast pokes (it sends them)
    protected override onShapePoke(): number {
        return 0;
    }

    /**
     * The shared owner-side poke pipeline: resolve `entry`'s shape under
     * `identity`, skip (`undefined`) when resolution failed / the shape is
     * global / its table didn't change / its membership diff over
     * `(entry.cursor, frameCursor]` is empty, and otherwise advance the
     * entry's cursor **synchronously** (before any await — see the callers'
     * interleaving guarantees) and return the wire-encoded poke.
     */
    private buildShapePoke(
        entry: CohortShapeEntry,
        identity: SubscriptionIdentity,
        changed: Set<string>,
        frameCursor: number,
        epoch: string | undefined,
    ): RelayShapePoke | undefined {
        let resolved: ResolvedShape | undefined;

        try {
            resolved = this.host.resolveShape(entry.name, entry.args, identity);
        } catch {
            return undefined;
        }

        if (resolved === undefined || resolved.global === true || !changed.has(resolved.table)) {
            return undefined;
        }

        // Alias so the cursor advance mutates a local binding, not the
        // parameter (no-param-reassign) — same pattern as `createGeoBuilder`.
        const staged = entry;
        const fromCursor = staged.cursor;
        const rowsPatch = this.host.buildShapeDiff(resolved, fromCursor, frameCursor);

        if (rowsPatch.length === 0) {
            return undefined; // the shape's membership didn't change — leave the cursor put
        }

        staged.cursor = frameCursor;
        // Write the advance through to `__lunora_relay_shapes` on the same
        // synchronous step, so an owner evicted before the next flush rehydrates
        // this frontier rather than re-diffing from the bottom of the log. The
        // caller rewinds BOTH on a failed send ({@link OwnerRelay.rewindShapeCursor}).
        writeRelayShapeCursor(this.host.sql(), staged.key, frameCursor);

        return {
            // `args` wire-encoded for the same reason as `rowsPatch` below; the
            // relay decodes them at `handleControl` before the routing match.
            args: encodeWire(entry.args) as Record<string, unknown>,
            checkpoint: frameCursor,
            epoch,
            fromCursor,
            name: entry.name,
            // Wire-encode before the poke crosses the owner→relay `JSON.stringify`
            // hop (`requestRelayMessage`); the relay re-frames it with
            // `preEncoded` so a `bytes`/`bigint` shape column isn't dropped/truncated.
            rowsPatch: encodeRowsPatch(rowsPatch),
            type: "relay_shape_poke",
        };
    }

    /**
     * Owner side (slice B.2): for every registered relay-uniform shape whose table
     * changed this flush, compute the membership diff ONCE over `(cohort cursor,
     * frameCursor]` and multicast the `rowsPatch` to every relay. Advances the cohort
     * cursor synchronously (before any await) so a seed interleaving during the
     * multicast registers at `frameCursor` and is skipped by this in-flight poke.
     *
     * The cohort cursor is per SHAPE, not per relay, so a delivery that fails to
     * ONE relay leaves that relay's sockets memoing a cursor no future poke's
     * `fromCursor` would ever equal again — a permanent, silent freeze on stale
     * rows. {@link OwnerRelay.multicastToRelays} therefore rewinds the shared
     * frontier when any leg failed, and the next write to that table re-sends
     * the whole range to everyone. Both constraints hold: the advance is still
     * synchronous for the interleaving seed, and the frontier still never
     * outruns what was actually delivered.
     */
    private async multicastShapePokes(changed: Set<string>, frameCursor: number): Promise<void> {
        const relays = this.ownerRelaySet();

        if (relays.size === 0) {
            return;
        }

        const { cohort } = this.relayShapes();

        if (cohort.size === 0) {
            return;
        }

        const epoch = this.host.currentCdcEpoch();
        const sends: Promise<void>[] = [];

        for (const entry of cohort.values()) {
            const poke = this.buildShapePoke(entry, RELAY_MULTICAST_IDENTITY, changed, frameCursor, epoch);

            if (!poke) {
                continue;
            }

            sends.push(this.multicastToRelays(relays, poke, entry));
        }

        await Promise.all(sends);
    }

    /**
     * POST one cohort poke to every relay, and rewind the shape's frontier if
     * ANY leg failed.
     *
     * A cross-DO POST is best-effort by design — `requestRelayMessage` swallows
     * a transient failure — which is fine for a whisper (an ephemeral frame) and
     * fatal for a poke (a durable position advanced past it). Rewinding turns a
     * failed leg into a re-send on the next write to that table instead of a
     * subscriber that never hears anything again. A relay that DID receive the
     * poke re-applies the reopened range harmlessly; see
     * {@link OwnerRelay.rewindShapeCursor}.
     *
     * The trade is deliberate: a relay that stays unreachable holds this shape's
     * frontier — and so the op-log retention floor — where it is, instead of
     * running ahead and silently stranding it. Nothing here evicts a relay for
     * being unresponsive (nothing ever did — only the relay itself detaches), so
     * a permanently dead relay makes the log grow and each diff widen. That is
     * a visible, measurable cost; the alternative was an invisible one.
     */
    private async multicastToRelays(relays: Set<number>, poke: RelayShapePoke, entry: CohortShapeEntry): Promise<void> {
        const legs = await Promise.all(
            [...relays].map(async (index) => {
                const response = await this.requestRelayMessage(relayName(this.roleId.ownerKey, index), poke);

                return response?.ok === true;
            }),
        );

        if (legs.includes(false)) {
            this.rewindShapeCursor(entry, poke.fromCursor);
        }
    }

    /**
     * Owner side (review MEDIUM-3): for every NON-uniform relay-shape proxy whose
     * table changed this flush, compute that one subscriber's diff over `(entry.cursor,
     * frameCursor]` UNDER ITS OWN forwarded identity (RLS-correct) and deliver a
     * `targetConnectionId`-addressed poke to just that socket's relay. Each entry
     * tracks its own cursor — the diffs are identity-specific, no cohort sharing —
     * and, exactly as for the cohort multicast, a POST that never landed rewinds
     * that cursor so the next write re-sends the range rather than stranding the
     * socket one delta behind forever.
     */
    private async proxyShapePokes(changed: Set<string>, frameCursor: number): Promise<void> {
        if (this.ownerRelaySet().size === 0) {
            return;
        }

        const { proxies } = this.relayShapes();

        if (proxies.size === 0) {
            return;
        }

        const epoch = this.host.currentCdcEpoch();
        const sends: Promise<void>[] = [];

        for (const entry of proxies.values()) {
            const poke = this.buildShapePoke(entry, entry.identity, changed, frameCursor, epoch);

            if (!poke) {
                continue;
            }

            sends.push(this.proxyToRelay(poke, entry));
        }

        await Promise.all(sends);
    }

    /** POST one per-socket proxy poke to its relay, rewinding the entry's cursor when the POST never landed (same reasoning as {@link OwnerRelay.multicastToRelays}). */
    private async proxyToRelay(poke: RelayShapePoke, entry: ProxyShapeEntry): Promise<void> {
        const response = await this.requestRelayMessage(relayName(this.roleId.ownerKey, entry.relayIndex), {
            ...poke,
            targetConnectionId: entry.connectionId,
        });

        if (response?.ok !== true) {
            this.rewindShapeCursor(entry, poke.fromCursor);
        }
    }

    /**
     * Serialize a shape's seed poke frames for a relay to deliver verbatim. Resolves
     * under the forwarded socket identity (so RLS applies exactly as for a local
     * subscribe), self-heals the relay set, registers the shape for live updates
     * (cohort multicast when uniform, per-socket proxy when not), and stamps the
     * relay's cohort memo at the registry FRONTIER (not the global cursor) so a late
     * joiner is never stranded. `lastMutationId` is omitted (relayed sockets are
     * owner-served for custom mutators).
     * @returns the serialized frames + the cohort-memo cursor, or an error
     */
    private buildShapeSeedFrames(request: RelayShapeSubscribe): RelayShapeSeed {
        const identity: SubscriptionIdentity = { identity: request.identity, userId: request.userId };

        let resolved: ResolvedShape | undefined;

        try {
            resolved = this.host.resolveShape(request.name, request.args, identity);
        } catch (error) {
            // eslint-disable-next-line no-secrets/no-secrets -- mirrors ShardDO's seedShapeSubscription local-path catch, not a credential
            // Mirrors `ShardDO.seedShapeSubscription`'s local-path catch: preserve a
            // structured error's real `code`/`message` (e.g. a cross-shard-join
            // guard), but redact an internal-coded or unrecognized throw instead of
            // relaying raw error text to the subscribing socket.
            const { body } = toErrorBody(error, { fallbackCode: "SHAPE_RESOLVE_FAILED", redactedMessage: "shape resolution failed" });

            return { error: { code: body.code, message: body.message } };
        }

        if (resolved === undefined || resolved.global === true) {
            return { error: { code: "SHAPE_NOT_FOUND", message: `shape not relayable: ${request.name}` } };
        }

        // Self-heal the relay set from the seed itself: a relay that seeds a shape
        // provably has a subscriber, so register it (idempotent) — forwarding stays
        // robust to a dropped `relay_attach` (LOW-4).
        if (request.relayIndex !== undefined) {
            this.addRelayToSet(request.relayIndex);
        }

        const { baseCheckpoint, cursor, epoch, reset, rowsPatch } = this.host.computeOpLogShapeSeed(
            { args: request.args, name: request.name, sinceEpoch: request.sinceEpoch, sinceSeq: request.sinceSeq },
            resolved,
        );

        // A UNIFORM shape joins the cohort multicast: the relay stamps the socket's
        // memo at the registry FRONTIER (entry.cursor), not the global cursor the
        // frames were computed at — the frontier only advances on a multicast poke, so
        // an unrelated-table write bumping the global cursor would otherwise leave a
        // joiner's memo past every future fromCursor (silent freeze, HIGH-2). Seeding
        // the full membership while memoing at the older frontier is correct because a
        // shape's membership is invariant between pokes. A NON-uniform shape registers
        // a per-socket proxy instead (MEDIUM-3). Either way the memo baseline is cohortCursor.
        let cohortCursor = cursor;

        const { cohort, proxies } = this.relayShapes();

        if (this.isShapeRelayUniform(request.name, request.args)) {
            const routingKey = shapeRoutingKey(request.name, request.args);
            let entry = cohort.get(routingKey);

            if (entry === undefined) {
                entry = { args: request.args, cursor, key: routingKey, name: request.name };
                cohort.set(routingKey, entry);
                // Register durably on the SEED path — once per cohort, not per
                // write — so the registry survives the owner eviction a
                // socket-less relay-mode owner is always one idle moment away
                // from. See `ctx-db-relay-shapes.ts`.
                writeRelayShape(this.host.sql(), entry);
            }

            cohortCursor = entry.cursor;
        } else if (request.relayIndex !== undefined && request.connectionId !== undefined) {
            const key = relayProxyKey(request.relayIndex, request.connectionId, request.subId);
            const proxy: ProxyShapeEntry = {
                args: request.args,
                connectionId: request.connectionId,
                cursor,
                identity,
                key,
                name: request.name,
                relayIndex: request.relayIndex,
            };

            proxies.set(key, proxy);
            // The forwarded identity rides along: without it a rehydrated proxy
            // could not compute the RLS-scoped diff this socket is owed, and
            // resolving it anonymously would be a cross-tenant leak rather than
            // a missing poke.
            writeRelayShape(this.host.sql(), proxy);
        } else {
            // A non-uniform shape is routed per socket, and BOTH halves of that
            // route are needed: the relay slot to address, and the connection to
            // target inside it. `connectionId` is optional on the attachment, so
            // this is reachable. Falling through would register nothing while
            // still returning seed frames — the subscriber would render an
            // initial snapshot and then never be poked again, for the life of the
            // socket, with nothing logged. Refuse the seed instead so the
            // `shape_subscribe` reply carries the failure.
            return {
                error: {
                    code: "RELAY_SHAPE_UNROUTABLE",
                    message: `shape ${request.name} is per-socket on a relay, but the subscribe carries no ${request.relayIndex === undefined ? "relay index" : "connection id"}`,
                },
            };
        }

        // `reset` rides on the part, not the meta: this is the relay's copy of
        // the local op-log seed, and without the flag a re-seed that could not
        // resume would be spliced onto whatever rows the client still held —
        // a full seed emits only inserts, so nothing it kept would ever leave.
        // Stamped at `cohortCursor`, NOT at the `cursor` the frames were computed
        // at: the client records the seed's checkpoint as its base, the relay
        // records `cohortCursor` as the socket's memo, and the next multicast
        // poke stamps that memo as its `baseCheckpoint`. Reporting the two at
        // different points made every joiner to an already-lagging cohort fail
        // its own base check on the first poke and re-seed. Under-reporting is
        // the safe direction: the first poke then re-sends the ops in
        // `(cohortCursor, cursor]`, which the seed already carried, and row ops
        // are idempotent by id.
        const frames = buildPokeFrames([{ reset, rowsPatch, shapeId: request.subId }], {
            baseCheckpoint,
            checkpoint: cohortCursor,
            epoch,
            lastMutationId: undefined,
            pokeId: this.host.nextPokeId(),
        });

        return { cursor: cohortCursor, epoch, frames };
    }

    /** Ensure the reserved owner-side relay tables exist (both auto-hidden from the data browser by the `__lunora` prefix). Idempotent, and independent of `runShardMigrations` so the control channel never depends on migration ordering. */
    private ensureRelayTables(): void {
        this.host.sql().exec("CREATE TABLE IF NOT EXISTS __lunora_relays (idx INTEGER PRIMARY KEY)");
        this.host.sql().exec("CREATE TABLE IF NOT EXISTS __lunora_relay_binding (id INTEGER PRIMARY KEY, binding TEXT NOT NULL)");
        migrateRelayShapes(this.host.sql());
    }

    /**
     * The owner's binding, falling back to the one it durably recorded.
     *
     * An owner in relay mode holds no sockets of its own, so it is evicted
     * freely — and it can then be woken by an ALARM (the TTL sweep and the
     * external-source poll both end in `flushChangedTables`, which reaches
     * `onFlush`). An alarm carries no request, so the in-memory binding the
     * runtime stamps per request is gone, `canAddressSiblings()` is false, and
     * the multicast is skipped.
     *
     * That loses no rows — the cohort cursor never advances, so the next flush
     * that CAN address siblings covers the widened range and `buildShapeDiff`
     * ships current values. But a shard whose subscribers are all on relays and
     * whose data only changes on a timer sends no relay→owner traffic to
     * re-supply it, so "until the next request" can mean indefinitely.
     *
     * Recorded when learned and read back at most once per wake. Deliberately
     * NOT ensured before reading: the read sits behind the `canAddressSiblings`
     * guard that exists to keep a single-DO shard's flush off SQLite entirely,
     * so a missing table simply means "nothing recorded", exactly as before.
     */
    // eslint-disable-next-line @typescript-eslint/member-ordering -- co-located with `ensureRelayTables`, whose table it reads and writes; hoisting it to the protected block would separate the override from the storage it is entirely about
    protected override bindingName(): string | undefined {
        const live = this.host.shardBinding();

        if (live !== undefined && live !== "") {
            if (live !== this.recordedBinding) {
                this.recordedBinding = live;
                this.ensureRelayTables();
                this.host
                    .sql()
                    .exec("INSERT INTO __lunora_relay_binding (id, binding) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET binding = excluded.binding", live);
            }

            return live;
        }

        if (this.recordedBinding !== undefined) {
            return this.recordedBinding;
        }

        try {
            const rows = this.host.sql().exec<{ binding: string }>("SELECT binding FROM __lunora_relay_binding WHERE id = 1").toArray();

            this.recordedBinding = rows[0]?.binding;
        } catch {
            // No table yet (nothing has ever recorded one) — indistinguishable
            // from "not known", which is the answer either way.
            this.recordedBinding = undefined;
        }

        return this.recordedBinding;
    }

    /**
     * The owner's shape registry, hydrated once per wake from
     * `__lunora_relay_shapes`.
     *
     * It is read back from SQLite because an owner in relay mode holds NO
     * sockets of its own — every subscriber sits on a relay — so nothing keeps
     * it resident and it is evicted freely between writes. An in-memory-only
     * registry came back EMPTY from that eviction, which the multicast reads as
     * "nothing to fan out": every relayed subscriber then goes silent for every
     * subsequent write, with no error and no retry, until each client happens to
     * reconnect. Rehydrating restores the cohort frontiers and the per-socket
     * proxies (identity included) exactly as they stood.
     *
     * Costs one `SELECT` per owner wake, and only on a shard that has relays
     * attached — the flush-path callers check the (already cached) relay set
     * first.
     */
    private relayShapes(): { cohort: Map<string, CohortShapeEntry>; proxies: Map<string, ProxyShapeEntry> } {
        const cached = this.registryCache;

        if (cached !== undefined) {
            return cached;
        }

        this.ensureRelayTables();

        const hydrated = { cohort: new Map<string, CohortShapeEntry>(), proxies: new Map<string, ProxyShapeEntry>() };

        for (const row of readRelayShapes(this.host.sql())) {
            if (row.relayIndex === undefined || row.connectionId === undefined) {
                hydrated.cohort.set(row.key, { args: row.args, cursor: row.cursor, key: row.key, name: row.name });
            } else {
                hydrated.proxies.set(row.key, {
                    args: row.args,
                    connectionId: row.connectionId,
                    cursor: row.cursor,
                    identity: row.identity ?? {},
                    key: row.key,
                    name: row.name,
                    relayIndex: row.relayIndex,
                });
            }
        }

        this.registryCache = hydrated;

        return hydrated;
    }

    /**
     * Put an entry's cursor back to `fromCursor` after a delivery that never
     * landed — in memory and in the table together, the other half of the
     * synchronous advance in {@link OwnerRelay.buildShapePoke}.
     *
     * Re-opening that range is safe because a shape diff is not a log replay:
     * `buildShapeDiff` ships each changed key's CURRENT membership and CURRENT
     * value, so a wider `(fromCursor, toCursor]` is the same answer plus
     * redundant keys. That is what lets ONE relay's failure be repaired without
     * corrupting the relays that did receive the poke — they simply re-apply
     * rows they already hold (see the delivery gate in
     * {@link RelayMember.deliverShapePoke}, which admits a memo at or after
     * `fromCursor` for exactly this reason).
     *
     * `Math.min` semantics — a rewind may only ever pull the frontier DOWN. The
     * retention floor is derived from it, and a floor that moves up past an
     * undelivered range is how the log gets trimmed out from under the diff that
     * still has to read it.
     */
    private rewindShapeCursor(entry: CohortShapeEntry, fromCursor: number): void {
        // Alias so the rewind mutates a local binding, not the parameter
        // (no-param-reassign) — same pattern as `buildShapePoke`.
        const staged = entry;

        if (staged.cursor <= fromCursor) {
            return;
        }

        staged.cursor = fromCursor;
        writeRelayShapeCursor(this.host.sql(), staged.key, fromCursor);
    }

    /** The owner's active relay indices, hydrated once from `__lunora_relays` and cached for the synchronous forward path. */
    private ownerRelaySet(): Set<number> {
        if (this.relaySetCache === undefined) {
            this.ensureRelayTables();
            const rows = this.host.sql().exec<{ idx: bigint | number }>("SELECT idx FROM __lunora_relays").toArray();

            this.relaySetCache = new Set(rows.map((row) => Number(row.idx)));
        }

        return this.relaySetCache;
    }

    /** Record a relay as active (idempotent), persisting it so the set survives the owner's hibernation. */
    private addRelayToSet(index: number): void {
        this.ensureRelayTables();
        this.host.sql().exec("INSERT OR IGNORE INTO __lunora_relays (idx) VALUES (?)", index);
        this.ownerRelaySet().add(index);
    }

    /**
     * Drop a drained relay from the set and prune its dead per-socket proxy
     * entries; on full drain, clear the (now dead) registry + uniform cache to
     * bound growth. Every prune goes through to `__lunora_relay_shapes` as well
     * — this detach is the ONLY reclamation those rows get, and a row that
     * outlives its subscriber pins the op-log retention floor at its cursor for
     * as long as it survives.
     */
    private removeRelayFromSet(index: number): void {
        this.ensureRelayTables();
        this.host.sql().exec("DELETE FROM __lunora_relays WHERE idx = ?", index);
        const set = this.ownerRelaySet();
        set.delete(index);

        const { cohort, proxies } = this.relayShapes();

        for (const [key, entry] of proxies) {
            if (entry.relayIndex === index) {
                proxies.delete(key);
            }
        }

        deleteRelayShapesForRelay(this.host.sql(), index);

        if (set.size === 0) {
            cohort.clear();
            this.shapeUniformCache.clear();
            deleteAllRelayShapes(this.host.sql());
        }
    }

    /**
     * The one-shot computation behind {@link OwnerRelay.isShapeRelayUniform}, made
     * sound against the cross-identity row-leak (review). Resolves under the anonymous
     * multicast identity (the base) plus two `Proxy`-backed identities that return a
     * distinct value for ANY accessed claim, requires all to agree on table + where +
     * columns, rejects any table with an RLS read policy or ANY masked column
     * defined (even if unprojected — see {@link OwnerRelay.tableHasAnyMask}), and
     * fails closed if the claims are enumerated (a wholesale copy the proxy can't
     * differentiate).
     */
    private probeShapeRelayUniform(name: string, args: Record<string, unknown>): boolean {
        let base: ResolvedShape | undefined;

        try {
            base = this.host.resolveShape(name, args, RELAY_MULTICAST_IDENTITY);
        } catch {
            return false;
        }

        if (base === undefined || base.global === true) {
            return false;
        }

        if (this.host.rlsMetadata().policies.some((policy) => policy.on === "read" && policy.table === base.table)) {
            return false;
        }

        if (this.tableHasAnyMask(base.table)) {
            return false;
        }

        // `stableWireKey`, not `stableStringify`: a shape `where` predicate can
        // carry a wire-typed literal (a `bigint` arg folded into the predicate),
        // which must compare deterministically rather than throw mid-probe.
        const baseWhere = stableWireKey(base.effectiveWhere);
        const baseColumns = stableWireKey(base.columns);

        let enumerated = false;
        const populate = (side: string): SubscriptionIdentity => {
            // Type-correct values for common collection claims so an array op doesn't
            // throw and over-reject; a distinct string sentinel for every other key.
            const backing: Record<string, unknown> = { groups: [`grp_${side}`], roles: [side], sub: `__lunora_probe_${side}__` };
            const claims = new Proxy(backing, {
                get: (target, key) => {
                    if (typeof key === "symbol" || key in target) {
                        return Reflect.get(target, key) as unknown;
                    }

                    return `${side}:${key}`;
                },
                getOwnPropertyDescriptor: (target, key) => {
                    enumerated = true;

                    return Reflect.getOwnPropertyDescriptor(target, key);
                },
                has: (target, key) => (typeof key === "symbol" ? Reflect.has(target, key) : true),
                ownKeys: (target) => {
                    enumerated = true;

                    return Reflect.ownKeys(target);
                },
            });

            return { identity: claims, userId: `__lunora_probe_${side}__` };
        };

        const matches = [RELAY_MULTICAST_IDENTITY, populate("a"), populate("b")].every((probe) => {
            let resolved: ResolvedShape | undefined;

            try {
                resolved = this.host.resolveShape(name, args, probe);
            } catch {
                return false;
            }

            return (
                resolved !== undefined &&
                resolved.global !== true &&
                resolved.table === base.table &&
                stableWireKey(resolved.effectiveWhere) === baseWhere &&
                stableWireKey(resolved.columns) === baseColumns
            );
        });

        return matches && !enumerated;
    }

    /**
     * Whether `table` has ANY masked column defined (L7). Deliberately conservative:
     * we disqualify a shape from relay-multicast if its table declares any mask at
     * all, even when the current query doesn't project the masked column. A masked
     * value is identity-dependent, and keying uniformity off the *projected* set
     * meant a later column addition (or a `select` change) could silently widen a
     * cohort to include an identity-dependent value. Refusing on any table-level
     * mask removes that footgun; the cost is a few extra shapes falling back to the
     * per-identity path, which is always correct.
     */
    private tableHasAnyMask(table: string): boolean {
        return this.host.maskMetadata().columns.some((entry) => entry.table === table);
    }
}

/**
 * A RELAY DO's collaborator (plan 075). A relay holds no op-log, so it seeds its
 * sockets' shapes THROUGH the owner and delivers the owner's multicast/proxy
 * pokes. Its state (per-socket cohort memos + the announce latch) is relay-only.
 */
class RelayMember extends RelayLink {
    /** `true` once this relay has announced itself to its owner this wake, so a hot socket churn doesn't re-attach on every subscribe. */
    private relayAnnounced = false;

    /** Per-socket cohort memo `ws → subId → { cursor, epoch }`: the relay delivers a poke to a socket only while its memo matches the poke's `fromCursor`+`epoch`. */
    private readonly shapeRelayMemos = new WeakMap<ShardSocketLike, Map<string, { cursor: number; epoch?: string }>>();

    /**
     * Serialises this relay's shape control frames to the owner, so the owner
     * sees them in the order the client sent them.
     *
     * `releaseRelayShapes` runs under `waitUntil` (the unsubscribe handler must
     * not block on a cross-DO POST) while `seedRelayShape` is awaited by the
     * `shape_subscribe` handler — two independent posts, arriving in whichever
     * order the network settles on. Both address the same
     * `relayIndex:connectionId:subId` proxy key, and `onShapeUnsubscribe`
     * deletes by that key with no version check, so an unsubscribe that lands
     * AFTER the resubscribe it preceded removes the replacement registration.
     * The socket then keeps its subscription and simply stops being poked, for
     * the life of that subscription, with nothing logged on either side.
     *
     * A queue rather than a registration incarnation on the frames: the owner's
     * proxy entries are durable, so an incarnation has to be persisted, matched
     * and reclaimed on both planes to fix an ordering problem the sender can
     * just not create.
     */
    private shapeControl: Promise<unknown> = Promise.resolve();

    public constructor(host: RelayHost, ownerKey: string, relayIndex: number) {
        super(host, { ownerKey, relayIndex });
    }

    public override async forwardWhisper(topic: string, frame: string): Promise<void> {
        if (!this.canAddressSiblings()) {
            return;
        }

        // A relay sends the frame UP to its owner, stamped with its own index so the
        // owner won't echo it back.
        await this.postRelayMessage(this.roleId.ownerKey, { frame, originRelay: this.roleId.relayIndex, topic, type: "relay_frame" });
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: a relay receives no writes, so it never flushes its own CDC
    public override onFlush(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * Seed a shape held by a socket on this relay by forwarding the request to the
     * owner: the owner resolves under this socket's verified identity and computes the
     * seed frames, which the relay delivers verbatim. Returns a structured error
     * (surfaced as a `shape_subscribe` error) when the owner can't be reached.
     */
    public override async seedRelayShape(
        ws: ShardSocketLike,
        subId: string,
        shape: ShapeSubscriptionQuery,
        identity: SubscriptionIdentity,
    ): Promise<"ok" | { code: string; message: string }> {
        if (!this.canAddressSiblings()) {
            return { code: "RELAY_MISCONFIGURED", message: "relay cannot address its owner" };
        }

        // Announce so the owner adds this relay to the set it multicasts deltas to.
        await this.announce();

        const request: RelayShapeSubscribe = {
            // Wire-encode before the relay->owner `JSON.stringify` hop: the shard
            // decoded these args at its `shape_subscribe` entry point, so a
            // `bigint`/`Date`/bytes arg would otherwise throw (or corrupt) here.
            args: encodeWire(shape.args ?? {}) as Record<string, unknown>,
            connectionId: this.host.readAttachment(ws).connectionId,
            identity: identity.identity,
            name: shape.name,
            relayIndex: this.roleId.relayIndex,
            sinceEpoch: shape.sinceEpoch,
            sinceSeq: shape.sinceSeq,
            subId,
            type: "relay_shape_subscribe",
            userId: identity.userId,
        };

        const response = await this.queueShapeControl(async () => this.requestRelayMessage(this.roleId.ownerKey, request));

        if (response === undefined) {
            return { code: "RELAY_SEED_FAILED", message: "owner did not answer the shape seed" };
        }

        let seed: RelayShapeSeed;

        try {
            // `json()` is `any`; assert to the wire shape the same way
            // `handleControl` does for inbound frames. Safe to assert rather
            // than validate because every field of `RelayShapeSeed` is optional
            // and the checks below treat a missing one as a seed failure.
            seed = (await response.json()) as RelayShapeSeed;
        } catch {
            return { code: "RELAY_SEED_FAILED", message: "malformed shape seed from owner" };
        }

        if (seed.error !== undefined) {
            return seed.error;
        }

        if (seed.frames === undefined) {
            return { code: "RELAY_SEED_FAILED", message: "owner returned no shape frames" };
        }

        await awaitWsDrain(ws);

        for (const frame of seed.frames) {
            trySendFrame(ws, frame);
        }

        // Stamp this socket's cohort memo at the owner's returned frontier so the next
        // multicast poke lands exactly once (HIGH-2 / LOW-6).
        this.recordRelayShapeMemo(ws, subId, seed.cursor ?? 0, seed.epoch);

        return "ok";
    }

    /** A relay announces itself to its owner (once per wake) on its first subscriber, retrying on a failed attach so a dropped frame can't strand its sockets (LOW-4). */
    public override async announce(): Promise<void> {
        if (this.relayAnnounced || !this.canAddressSiblings()) {
            return;
        }

        // Latch optimistically so a burst of subscribes doesn't re-announce, but reset
        // on a failed attach so the next subscriber retries.
        this.relayAnnounced = true;
        const response = await this.requestRelayMessage(this.roleId.ownerKey, { relayIndex: this.roleId.relayIndex as number, type: "relay_attach" });

        if (!response?.ok) {
            this.relayAnnounced = false;
        }
    }

    /** Once this relay loses its last socket (the `closing` one excluded), detach from the owner and re-arm the announce latch for a future subscriber. */
    public override async announceDrain(closing: ShardSocketLike): Promise<void> {
        if (!this.canAddressSiblings()) {
            return;
        }

        if (this.host.getWebSockets().some((ws) => ws !== closing)) {
            return;
        }

        this.relayAnnounced = false;
        await this.postRelayMessage(this.roleId.ownerKey, { relayIndex: this.roleId.relayIndex as number, type: "relay_detach" });
    }

    /**
     * Tell the owner this socket has given up a relayed shape, so it drops the
     * per-socket proxy registration rather than holding it until this relay
     * detaches. Sent on an explicit `shape_unsubscribe` (`subId` set) and on
     * socket close (`subId` omitted — every shape the connection held).
     *
     * Fire-and-forget like every other control frame: a dropped one leaves the
     * registration to the coarser detach/full-drain reclamation, which is where
     * it lived before.
     */
    public override async releaseRelayShapes(ws: ShardSocketLike, subId?: string): Promise<void> {
        const { connectionId } = this.host.readAttachment(ws);

        // No connection id means nothing was ever registered: the owner refuses
        // to seed a per-socket shape without one (`RELAY_SHAPE_UNROUTABLE`).
        if (connectionId === undefined || !this.canAddressSiblings()) {
            return;
        }

        await this.queueShapeControl(async () =>
            this.postRelayMessage(this.roleId.ownerKey, {
                connectionId,
                relayIndex: this.roleId.relayIndex as number,
                ...(subId === undefined ? {} : { subId }),
                type: "relay_shape_unsubscribe",
            }),
        );
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: a relay never spreads connections (flat single tier)
    public override relayCount(): number {
        return 0;
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: the RLS-uniform gate is an owner concern
    public override isShapeRelayUniform(): boolean {
        return false;
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: a relay holds no op-log, so it runs no retention sweep and has no frontier to protect
    public override minShapeCursor(): number | undefined {
        return undefined;
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: only an owner tracks a relay set
    protected override onAttach(): void {
        /* a relay has no relay set */
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: only an owner tracks a relay set
    protected override onDetach(): void {
        /* a relay has no relay set */
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: only an owner re-distributes a forwarded whisper
    protected override onWhisperFrame(): Promise<void> {
        return Promise.resolve();
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: a relay can't seed (no op-log) — the owner does
    protected override onShapeSubscribe(): RelayShapeSeed {
        return { error: { code: "RELAY_CANNOT_SEED", message: "a relay has no op-log to seed from" } };
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: only an owner holds the shape registry
    protected override onShapeUnsubscribe(): void {
        /* a relay registers nothing to release */
    }

    protected override onShapePoke(poke: RelayShapePoke): number {
        return this.deliverShapePoke(poke);
    }

    /**
     * Run `send` after every shape control frame already queued on this relay,
     * whatever their outcome — a failed post must not stall the queue behind it,
     * and `requestRelayMessage` already swallows the transient cross-DO failure.
     */
    private async queueShapeControl<T>(send: () => Promise<T>): Promise<T> {
        const next = this.shapeControl.then(send, send);

        this.shapeControl = next.then(
            () => undefined,
            () => undefined,
        );

        return next;
    }

    /** Record a relay socket's cohort cursor + epoch for `subId` (creating the per-socket map lazily). */
    private recordRelayShapeMemo(ws: ShardSocketLike, subId: string, cursor: number, epoch: string | undefined): void {
        let memos = this.shapeRelayMemos.get(ws);

        if (memos === undefined) {
            memos = new Map<string, { cursor: number; epoch?: string }>();
            this.shapeRelayMemos.set(ws, memos);
        }

        memos.set(subId, { cursor, epoch });
    }

    /**
     * Deliver an owner-multicast shape delta to this relay's cohort sockets. A
     * socket receives it only while its memo sits on the poke's `epoch` and
     * inside the range the poke covers; it then advances to `checkpoint`. A
     * targeted (per-socket proxy) poke goes ONLY to its one connection; a cohort
     * multicast goes to every matching socket.
     *
     * {@link pokeAppliesToMemo} carries the cursor/epoch rule and why it is a
     * range rather than an equality.
     * @returns the number of sockets delivered to
     */
    private deliverShapePoke(poke: RelayShapePoke): number {
        const routingKey = shapeRoutingKey(poke.name, poke.args);
        let delivered = 0;

        for (const ws of this.host.getWebSockets()) {
            const attachment = this.host.readAttachment(ws);
            const { shapes } = attachment;
            const memos = this.shapeRelayMemos.get(ws);

            if (shapes === undefined || memos === undefined) {
                continue;
            }

            if (poke.targetConnectionId !== undefined && attachment.connectionId !== poke.targetConnectionId) {
                continue;
            }

            for (const [subId, sub] of Object.entries(shapes)) {
                const memo = memos.get(subId);

                if (shapeRoutingKey(sub.name, sub.args) !== routingKey || !pokeAppliesToMemo(memo, poke)) {
                    continue;
                }

                const frames = buildPokeFrames(
                    // The socket's OWN memo is the base, not `poke.fromCursor`:
                    // the memo is what this socket was last told its checkpoint
                    // was (the seed's `cohortCursor`, or the previous poke's
                    // checkpoint), and the admission rule is a RANGE — a memo
                    // ahead of `fromCursor` is admitted and would then be handed
                    // a base it is not at, failing the client's divergence check
                    // and forcing a re-seed. Left unstamped, the client's gap
                    // check stays disarmed on the one path where a cross-DO POST
                    // can actually drop a poke.
                    [{ baseCheckpoint: memo?.cursor, rowsPatch: poke.rowsPatch, shapeId: subId }],
                    {
                        baseCheckpoint: undefined,
                        checkpoint: poke.checkpoint,
                        epoch: poke.epoch,
                        lastMutationId: undefined,
                        pokeId: this.host.nextPokeId(),
                    },
                    // `poke.rowsPatch` was wire-encoded by the owner before it crossed
                    // the hub — don't double-encode it here.
                    { preEncoded: true },
                );

                for (const frame of frames) {
                    trySendFrame(ws, frame);
                }

                memos.set(subId, { cursor: poke.checkpoint, epoch: poke.epoch });
                delivered += 1;
            }
        }

        return delivered;
    }
}

/**
 * Build the role-typed relay collaborator for a DO, chosen ONCE from its name:
 * an un-suffixed name is the shard owner ({@link OwnerRelay}); a `…::relay::N`
 * name is a relay ({@link RelayMember}). An unnamed DO (single-DO mode) gets no
 * collaborator — the relay tier is inert.
 * @returns the collaborator, or `undefined` for an unnamed DO
 */
const createRelayLink = (host: RelayHost): OwnerRelay | RelayMember | undefined => {
    const name = host.doName();

    if (name === undefined) {
        return undefined;
    }

    const parsed = parseRelayName(name);

    return parsed === undefined ? new OwnerRelay(host, name) : new RelayMember(host, parsed.ownerKey, parsed.relayIndex);
};

export { createRelayLink, DEFAULT_MAX_RELAYS, OwnerRelay, RelayMember };
export type { RelayHost };
