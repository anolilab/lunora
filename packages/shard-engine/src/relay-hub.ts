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

import { constantTimeEqual } from "../../../shared/constant-time-equal";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { SqlExec } from "./ctx-db";
import type { MaskPoliciesResult, RlsPoliciesResult } from "./introspect";
import { stableWireKey } from "./reactive-cache";
import type { OwnerRelayFrame, PromotionState, RelayFrame, RelayShapePoke, RelayShapeSeed, RelayShapeSubscribe } from "./relay";
import { clampPromotionThresholds, DEFAULT_PROMOTION_THRESHOLDS, nextPromotionState, parseRelayName, relayName, shapeRoutingKey } from "./relay";
import type { ShapeRowOp } from "./shape-global-diff";
import { buildPokeFrames, encodeRowsPatch } from "./shape-global-diff";
import { awaitWsDrain, trySendFrame } from "./subscription-delivery";
import type { ResolvedShape, ShapeSubscriptionQuery, ShardSocketLike, SocketAttachment, SubscriptionIdentity } from "./types";

/** Fixed relay-fan when a shard promotes (per-deployment via `LUNORA_RELAY_FAN`). */
const DEFAULT_RELAY_FAN = 2;

/** Hard ceiling on relays per shard (per-deployment via `LUNORA_MAX_RELAYS`) — the cost cap a viral shard can never exceed. */
const DEFAULT_MAX_RELAYS = 8;

/** Env var carrying the optional relay control-channel HMAC secret. */
const RELAY_SECRET_KEY = "LUNORA_RELAY_SECRET";

/** Header carrying the hex HMAC-SHA256 of the relay control-frame body. */
const RELAY_SIGNATURE_HEADER = "x-lunora-relay-sig";

/** The relay control-channel secret, or `undefined` when message authentication is not configured. */
const relaySecretOf = (env: unknown): string | undefined => {
    const value = (env as Record<string, unknown> | undefined)?.[RELAY_SECRET_KEY];

    return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * HMAC-SHA256 of `body` under `secret`, hex-encoded. Authenticates the internal
 * `/_lunora/relay` control channel (L6): without it, safety rests solely on DO
 * network isolation, so any DO in the namespace (or a future custom route that
 * forwarded a client path+body to a shard) could inject forged relay frames —
 * e.g. deliver an arbitrary `rowsPatch` to another subscriber's socket. Opt-in:
 * only enforced when `LUNORA_RELAY_SECRET` is set, so existing deployments are
 * unaffected until they provision the secret.
 */
const signRelayBody = async (secret: string, body: string): Promise<string> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));

    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Read a positive integer env var by `key`, falling back to `fallback` when unset/invalid. */
const envPositiveInt = (env: unknown, key: string, fallback: number): number => {
    const raw = (env as Record<string, unknown> | undefined)?.[key];
    let parsed = Number.NaN;

    if (typeof raw === "string") {
        parsed = Number.parseInt(raw, 10);
    } else if (typeof raw === "number") {
        parsed = raw;
    }

    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

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

/** Exhaustiveness guard for the {@link OwnerRelayFrame} dispatch — an unhandled member is a compile error here, and an impossible runtime frame throws rather than silently mis-routing. */
const assertNeverFrame = (frame: never): never => {
    throw new LunoraError("INTERNAL", `unhandled relay frame: ${JSON.stringify(frame)}`);
};

/** Minimal Durable Object stub surface the relay tier needs to POST a control frame to a sibling. */
interface RelayStub {
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Minimal Durable Object namespace surface for addressing sibling owners/relays by name. */
interface RelayNamespaceLike {
    get: (id: unknown) => RelayStub;
    getByName?: (name: string) => RelayStub;
    idFromName: (name: string) => unknown;
}

/** Duck-type a value as a DO namespace, or `undefined` when it isn't one (single-DO mode / unbound). */
const asRelayNamespace = (value: unknown): RelayNamespaceLike | undefined => {
    if (value === null || typeof value !== "object") {
        return undefined;
    }

    const candidate = value as Partial<RelayNamespaceLike>;

    return typeof candidate.idFromName === "function" && typeof candidate.get === "function" ? (candidate as RelayNamespaceLike) : undefined;
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
    ) => { baseCheckpoint: number | undefined; cursor: number; epoch: string | undefined; rowsPatch: ShapeRowOp[] };
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
        const secret = relaySecretOf(this.host.env());

        if (secret !== undefined) {
            const supplied = request.headers.get(RELAY_SIGNATURE_HEADER);
            const expected = await signRelayBody(secret, raw);

            if (supplied === null || !constantTimeEqual(supplied, expected)) {
                return new Response("forbidden", { status: 403 });
            }
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
            default: {
                return assertNeverFrame(message);
            }
        }
    }

    /** The hard cap on relays per shard (`LUNORA_MAX_RELAYS`) — a deployment constant the runtime surfaces in Studio as the cost ceiling. */
    public maxRelays(): number {
        return envPositiveInt(this.host.env(), "LUNORA_MAX_RELAYS", DEFAULT_MAX_RELAYS);
    }

    /** Whether this DO can currently address its siblings (a namespace binding has been learned) — the relay tier is inert in single-DO mode. */
    protected canAddressSiblings(): boolean {
        return this.relayNamespace() !== undefined;
    }

    /** Resolve this DO's own namespace binding so it can address sibling owners/relays, or `undefined` when unknown. */
    protected relayNamespace(): RelayNamespaceLike | undefined {
        const binding = this.host.shardBinding();

        if (binding === undefined) {
            return undefined;
        }

        return asRelayNamespace((this.host.env() as Record<string, unknown> | undefined)?.[binding]);
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
        const namespace = this.relayNamespace();

        if (namespace === undefined) {
            return undefined;
        }

        const stub = typeof namespace.getByName === "function" ? namespace.getByName(targetName) : namespace.get(namespace.idFromName(targetName));
        const body = JSON.stringify(message);
        const headers: Record<string, string> = { "content-type": "application/json", "x-lunora-shard-binding": this.host.shardBinding() ?? "" };

        // Sign the control-frame body when a relay secret is configured (L6), so
        // the receiver can authenticate it. Signed over the exact bytes we send.
        const secret = relaySecretOf(this.host.env());

        if (secret !== undefined) {
            headers[RELAY_SIGNATURE_HEADER] = await signRelayBody(secret, body);
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

    /** How many relays the runtime should spread new connections across for this shard (owner decides; a relay returns 0). */
    public abstract relayCount(): number;

    /** Whether a reactive shape may be relay-multicast (the RLS-uniform gate); `false` on a relay (the gate is an owner concern). */
    public abstract isShapeRelayUniform(name: string, args: Record<string, unknown>): boolean;

    /** Control-channel hook: an owner adds a relay to its set; a relay no-ops. */
    protected abstract onAttach(index: number): void;

    /** Control-channel hook: an owner drops a relay from its set; a relay no-ops. */
    protected abstract onDetach(index: number): void;

    /** Control-channel hook: an owner re-distributes a relay-forwarded whisper to its OTHER relays; a relay no-ops. */
    protected abstract onWhisperFrame(message: RelayFrame): Promise<void>;

    /** Control-channel hook: an owner builds the seed frames for a relay subscriber; a relay errors (it can't seed). */
    protected abstract onShapeSubscribe(message: RelayShapeSubscribe): RelayShapeSeed;

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

    /** Relay-uniform shapes a relay has subscribers for, keyed by `(name, args)`. `cursor` is the cohort frontier the owner has multicast deltas up to. */
    private readonly relayShapeRegistry = new Map<string, { args: Record<string, unknown>; cursor: number; name: string }>();

    /** NON-uniform (identity-scoped) relay shapes, one entry per relay socket, keyed `relayIndex:connectionId:subId`. Each is served live by a per-socket proxy poke. */
    private readonly relayShapeProxies = new Map<
        string,
        {
            args: Record<string, unknown>;
            connectionId: string;
            cursor: number;
            epoch?: string;
            identity: SubscriptionIdentity;
            name: string;
            relayIndex: number;
            subId: string;
        }
    >();

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

        const maxRelays = envPositiveInt(this.host.env(), "LUNORA_MAX_RELAYS", DEFAULT_MAX_RELAYS);
        const fan = envPositiveInt(this.host.env(), "LUNORA_RELAY_FAN", DEFAULT_RELAY_FAN);

        return Math.min(maxRelays, Math.max(1, fan));
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
     * Owner side (slice B.2): for every registered relay-uniform shape whose table
     * changed this flush, compute the membership diff ONCE over `(cohort cursor,
     * frameCursor]` and multicast the `rowsPatch` to every relay. Advances the cohort
     * cursor synchronously (before any await) so a seed interleaving during the
     * multicast registers at `frameCursor` and is skipped by this in-flight poke.
     */
    private async multicastShapePokes(changed: Set<string>, frameCursor: number): Promise<void> {
        if (this.relayShapeRegistry.size === 0) {
            return;
        }

        const relays = this.ownerRelaySet();

        if (relays.size === 0) {
            return;
        }

        const epoch = this.host.currentCdcEpoch();
        const sends: Promise<void>[] = [];

        for (const entry of this.relayShapeRegistry.values()) {
            let resolved: ResolvedShape | undefined;

            try {
                resolved = this.host.resolveShape(entry.name, entry.args, RELAY_MULTICAST_IDENTITY);
            } catch {
                continue;
            }

            if (resolved === undefined || resolved.global === true || !changed.has(resolved.table)) {
                continue;
            }

            const fromCursor = entry.cursor;
            const rowsPatch = this.host.buildShapeDiff(resolved, fromCursor, frameCursor);

            if (rowsPatch.length === 0) {
                continue; // the shape's membership didn't change — leave the cohort cursor put
            }

            entry.cursor = frameCursor;
            const poke: RelayShapePoke = {
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

            for (const index of relays) {
                sends.push(this.postRelayMessage(relayName(this.roleId.ownerKey, index), poke));
            }
        }

        await Promise.all(sends);
    }

    /**
     * Owner side (review MEDIUM-3): for every NON-uniform relay-shape proxy whose
     * table changed this flush, compute that one subscriber's diff over `(entry.cursor,
     * frameCursor]` UNDER ITS OWN forwarded identity (RLS-correct) and deliver a
     * `targetConnectionId`-addressed poke to just that socket's relay. Each entry
     * tracks its own cursor — the diffs are identity-specific, no cohort sharing.
     */
    private async proxyShapePokes(changed: Set<string>, frameCursor: number): Promise<void> {
        if (this.relayShapeProxies.size === 0) {
            return;
        }

        const epoch = this.host.currentCdcEpoch();
        const sends: Promise<void>[] = [];

        for (const entry of this.relayShapeProxies.values()) {
            let resolved: ResolvedShape | undefined;

            try {
                resolved = this.host.resolveShape(entry.name, entry.args, entry.identity);
            } catch {
                continue;
            }

            if (resolved === undefined || resolved.global === true || !changed.has(resolved.table)) {
                continue;
            }

            const fromCursor = entry.cursor;
            const rowsPatch = this.host.buildShapeDiff(resolved, fromCursor, frameCursor);

            if (rowsPatch.length === 0) {
                continue; // this subscriber's membership didn't change — leave its cursor put
            }

            entry.cursor = frameCursor;
            const poke: RelayShapePoke = {
                // `args` wire-encoded like `rowsPatch`; decoded relay-side at
                // `handleControl` before the routing match.
                args: encodeWire(entry.args) as Record<string, unknown>,
                checkpoint: frameCursor,
                epoch,
                fromCursor,
                name: entry.name,
                // Wire-encode before the owner→relay `JSON.stringify` hop (see the
                // cohort-multicast path); the relay re-frames it with `preEncoded`.
                rowsPatch: encodeRowsPatch(rowsPatch),
                targetConnectionId: entry.connectionId,
                type: "relay_shape_poke",
            };

            sends.push(this.postRelayMessage(relayName(this.roleId.ownerKey, entry.relayIndex), poke));
        }

        await Promise.all(sends);
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

        const { baseCheckpoint, cursor, epoch, rowsPatch } = this.host.computeOpLogShapeSeed(
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

        if (this.isShapeRelayUniform(request.name, request.args)) {
            const routingKey = shapeRoutingKey(request.name, request.args);
            let entry = this.relayShapeRegistry.get(routingKey);

            if (entry === undefined) {
                entry = { args: request.args, cursor, name: request.name };
                this.relayShapeRegistry.set(routingKey, entry);
            }

            cohortCursor = entry.cursor;
        } else if (request.relayIndex !== undefined && request.connectionId !== undefined) {
            this.relayShapeProxies.set(`${String(request.relayIndex)}:${request.connectionId}:${request.subId}`, {
                args: request.args,
                connectionId: request.connectionId,
                cursor,
                epoch,
                identity,
                name: request.name,
                relayIndex: request.relayIndex,
                subId: request.subId,
            });
        }

        const frames = buildPokeFrames([{ rowsPatch, shapeId: request.subId }], {
            baseCheckpoint,
            checkpoint: cursor,
            epoch,
            lastMutationId: undefined,
            pokeId: this.host.nextPokeId(),
        });

        return { cursor: cohortCursor, epoch, frames };
    }

    /** Ensure the reserved owner-side relay-set table exists (auto-hidden from the data browser by the `__lunora` prefix). */
    private ensureRelayTable(): void {
        this.host.sql().exec("CREATE TABLE IF NOT EXISTS __lunora_relays (idx INTEGER PRIMARY KEY)");
    }

    /** The owner's active relay indices, hydrated once from `__lunora_relays` and cached for the synchronous forward path. */
    private ownerRelaySet(): Set<number> {
        if (this.relaySetCache === undefined) {
            this.ensureRelayTable();
            const rows = this.host.sql().exec<{ idx: bigint | number }>("SELECT idx FROM __lunora_relays").toArray();

            this.relaySetCache = new Set(rows.map((row) => Number(row.idx)));
        }

        return this.relaySetCache;
    }

    /** Record a relay as active (idempotent), persisting it so the set survives the owner's hibernation. */
    private addRelayToSet(index: number): void {
        this.ensureRelayTable();
        this.host.sql().exec("INSERT OR IGNORE INTO __lunora_relays (idx) VALUES (?)", index);
        this.ownerRelaySet().add(index);
    }

    /** Drop a drained relay from the set and prune its dead per-socket proxy entries; on full drain, clear the (now dead) registry + uniform cache to bound growth. */
    private removeRelayFromSet(index: number): void {
        this.ensureRelayTable();
        this.host.sql().exec("DELETE FROM __lunora_relays WHERE idx = ?", index);
        const set = this.ownerRelaySet();
        set.delete(index);

        for (const [key, entry] of this.relayShapeProxies) {
            if (entry.relayIndex === index) {
                this.relayShapeProxies.delete(key);
            }
        }

        if (set.size === 0) {
            this.relayShapeRegistry.clear();
            this.shapeUniformCache.clear();
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

        const response = await this.requestRelayMessage(this.roleId.ownerKey, request);

        if (response === undefined) {
            return { code: "RELAY_SEED_FAILED", message: "owner did not answer the shape seed" };
        }

        let seed: RelayShapeSeed;

        try {
            seed = await response.json();
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

    // eslint-disable-next-line class-methods-use-this -- role hook: a relay never spreads connections (flat single tier)
    public override relayCount(): number {
        return 0;
    }

    // eslint-disable-next-line class-methods-use-this -- role hook: the RLS-uniform gate is an owner concern
    public override isShapeRelayUniform(): boolean {
        return false;
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

    protected override onShapePoke(poke: RelayShapePoke): number {
        return this.deliverShapePoke(poke);
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
     * Deliver an owner-multicast shape delta to this relay's cohort sockets. A socket
     * receives it only while its memo matches the poke's `fromCursor` AND `epoch` (so a
     * socket that seeded at a different cursor/epoch never double-applies), then
     * advances to `checkpoint`. A targeted (per-socket proxy) poke goes ONLY to its one
     * connection; a cohort multicast goes to every matching socket.
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

                if (memo?.cursor !== poke.fromCursor || memo.epoch !== poke.epoch || shapeRoutingKey(sub.name, sub.args) !== routingKey) {
                    continue;
                }

                const frames = buildPokeFrames(
                    [{ rowsPatch: poke.rowsPatch, shapeId: subId }],
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
