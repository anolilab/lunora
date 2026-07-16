/**
 * Auto-elastic fan-out relay tier — promotion state machine + internal owner↔relay
 * frame protocol (plan 075 Phase 2).
 *
 * A hot fan-out key (a shard whose subscriber count makes one isolate's per-flush
 * fan-out the bottleneck — see the measured curve in
 * `plans/075-phase0-relay-protocol-design.md` § 7) is **promoted**: the runtime
 * routes _new_ connections to relay DOs, the owner computes each delta once and
 * forwards an opaque frame to its relays, and each relay re-broadcasts to its
 * attached sockets. This module is the pure, owner-side decision layer; the
 * transport that consumes it lives in `shard-do.ts` (relay mode) and the runtime
 * (endpoint selection at the WS upgrade hop).
 *
 * Everything here is internal: the {@link OwnerRelayFrame} types are NOT part of
 * the public client protocol (the app never sees them — the relay tier is
 * invisible runtime elasticity).
 */

import { LunoraError } from "@lunora/errors";

import { stableWireKey } from "./reactive-cache";
import type { ShapeRowOp } from "./shape-global-diff";

/**
 * The single canonical cohort routing key for a reactive shape `(name, args)`,
 * used everywhere the owner and its relays must agree on "the same shape": the
 * uniform-cache key, the owner registry key, and the relay-side delivery match.
 * Normalizing `args ?? {}` in ONE place is load-bearing — the owner registers
 * with already-defaulted args while a relay matches against the live attachment's
 * possibly-undefined `args`, so any per-site disagreement on the empty-args
 * default would silently break cohort matching (dropped or double-applied deltas).
 * `stableWireKey` (byte-identical to `stableStringify` for pure-JSON args) keeps
 * every site keying DECODED args, so a wire-typed arg (`bigint`, `Date`, bytes)
 * routes deterministically instead of throwing mid-flush.
 */
const shapeRoutingKey = (name: string, args?: Record<string, unknown>): string => stableWireKey({ args: args ?? {}, name });

/** Whether a fan-out key is owner-served (the default) or has been promoted to a relay set. */
type PromotionState = "owned" | "promoted";

/**
 * Subscriber-count thresholds governing promotion, with hysteresis. `tDown` must
 * be strictly below `tUp`: the band between them holds the current state so a key
 * hovering near the threshold can't flap between owner-served and promoted.
 */
interface PromotionThresholds {
    /** Collapse back to owner-served below this live-subscriber count (must be `< tUp`). */
    tDown: number;
    /** Promote to a relay set at or above this live-subscriber count. */
    tUp: number;
}

/**
 * Default promotion thresholds. `tUp = 8,000` is where the measured fan-out curve
 * (~10–15 µs/socket end-to-end in workerd, ~120 ms per flush at 8k) makes per-flush
 * fan-out the bottleneck well within a single DO's ~32k connection cap; `tDown` is
 * half that, the anti-flap band. Both are tunable per deployment against the
 * Phase-1 `getFanoutMetrics` readout — never silently hardcoded into the hot path.
 */
const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = { tDown: 4000, tUp: 8000 };

/**
 * Pure promotion reducer: the next {@link PromotionState} given the current state
 * and the live subscriber count, under the hysteresis band. `owned` promotes at
 * `>= tUp`; `promoted` collapses at `< tDown`; in between, the state is unchanged.
 * @throws if `tDown >= tUp` (the band would be empty or inverted — a config error).
 */
const nextPromotionState = (current: PromotionState, subscribers: number, thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS): PromotionState => {
    if (thresholds.tDown >= thresholds.tUp) {
        throw new LunoraError("INTERNAL", `invalid promotion thresholds: tDown (${String(thresholds.tDown)}) must be < tUp (${String(thresholds.tUp)})`);
    }

    if (current === "owned") {
        return subscribers >= thresholds.tUp ? "promoted" : "owned";
    }

    return subscribers < thresholds.tDown ? "owned" : "promoted";
};

/**
 * Sanitize a raw (typically env-configured) collapse threshold into a valid
 * hysteresis band for {@link nextPromotionState}, which throws when `tDown >= tUp`.
 * A `tDownRaw` already strictly below `tUp` is kept as-is; otherwise (a
 * misconfiguration) it degrades to half of `tUp`, hard-floored strictly below
 * `tUp` — so a bad `LUNORA_RELAY_COLLAPSE_THRESHOLD` never throws on the routing
 * hot path. For the degenerate `tUp = 1`, `tDown` lands at `0` (collapse simply
 * never triggers, which is the sensible behavior at that ceiling). Keeping this
 * next to the reducer means the `tDown < tUp` invariant is defended where it is
 * declared, not re-derived by every caller.
 */
const clampPromotionThresholds = (tUp: number, tDownRaw: number): PromotionThresholds => {
    if (tDownRaw < tUp) {
        return { tDown: tDownRaw, tUp };
    }

    return { tDown: Math.min(Math.max(1, Math.floor(tUp / 2)), tUp - 1), tUp };
};

/**
 * How many relays a promoted key needs to serve `subscribers` connections, given
 * each relay's capacity, capped at `maxRelays` (the cost ceiling — a viral key can
 * never silently spawn unbounded DOs; the runtime surfaces the cap in Studio when
 * approached). The owner keeps serving its own share, so this sizes the _relay_
 * set for the overflow above one DO's capacity.
 * @returns the relay count in `[0, maxRelays]`
 */
const relayCountFor = (subscribers: number, perRelayCapacity: number, maxRelays: number): number => {
    if (subscribers <= perRelayCapacity || perRelayCapacity <= 0) {
        return 0;
    }

    const overflow = subscribers - perRelayCapacity;
    const needed = Math.ceil(overflow / perRelayCapacity);

    return Math.min(needed, Math.max(0, maxRelays));
};

/** A relay announces (on its first attached subscriber) that it is serving a fan-out key, so the owner adds it to the relay set it forwards to. */
interface RelayAttach {
    relayIndex: number;
    type: "relay_attach";
}

/** A relay announces it has drained to zero sockets and is detaching, so the owner stops forwarding to it. */
interface RelayDetach {
    relayIndex: number;
    type: "relay_detach";
}

/**
 * One **opaque, already-serialized** frame to re-broadcast verbatim to a fan-out
 * key's local subscribers. `frame` is the exact wire string the owner would have
 * sent its own sockets (a whisper frame in Phase 2); the receiver never parses or
 * re-derives it. `topic` names the fan-out key so the receiver delivers only to
 * that key's members. `originRelay` is set when a relay forwarded a socket's
 * whisper up to the owner, so the owner skips re-forwarding it back to that relay
 * (no echo). `cursor`/`epoch` accompany reactive-shape frames (Phase 3); absent
 * for ephemeral whisper.
 */
interface RelayFrame {
    cursor?: number;
    epoch?: string;
    frame: string;
    originRelay?: number;
    topic: string;
    type: "relay_frame";
}

/**
 * A relay forwards a reactive `shape_subscribe` up to the owner so the owner —
 * the only DO with the SQLite op-log — computes the seed under the socket's
 * VERIFIED identity (RLS-correct) and returns the serialized poke frames for the
 * relay to deliver (plan 075 Phase 3). Carries the socket's identity verbatim;
 * `sinceSeq`/`sinceEpoch` enable the owner's resume fast-path.
 */
interface RelayShapeSubscribe {
    args: Record<string, unknown>;
    /** The relay socket's stable connection id — lets the owner address per-socket proxy pokes back to exactly this socket (non-uniform shapes). */
    connectionId?: string;
    identity?: Record<string, unknown>;
    name: string;
    /** The forwarding relay's index, so the owner knows which relay to send this socket's proxy pokes to. */
    relayIndex?: number;
    sinceEpoch?: string;
    sinceSeq?: number;
    subId: string;
    type: "relay_shape_subscribe";
    userId?: string;
}

/**
 * The owner's response to a {@link RelayShapeSubscribe}: the serialized poke
 * frames (pokeStart/pokePart…/pokeEnd) to send to the subscribing socket, plus
 * the **cohort frontier** the relay must stamp the socket's memo at. `cursor` is
 * deliberately NOT the global CDC cursor the frames were computed at — it is the
 * registry's cohort cursor (the point the owner has multicast this shape's deltas
 * up to). A joiner enters the cohort there so the next `relay_shape_poke`'s
 * `fromCursor` matches it; seeding the full current membership is still correct
 * because a shape's membership is invariant between multicast pokes. `epoch` pairs
 * with the cursor so a memo can't match a `fromCursor` from a different CDC epoch.
 * `error` is set instead when the shape can't be resolved (unknown / RLS-denied),
 * which the relay surfaces as a `shape_subscribe` error.
 */
interface RelayShapeSeed {
    cursor?: number;
    epoch?: string;
    error?: { code: string; message: string };
    frames?: string[];
}

/**
 * The owner multicasts ONE shape delta per flush to its relays (plan 075 Phase 3
 * slice B.2): it computes the membership `rowsPatch` once (over plan 072's shared
 * op-range) and ships it with the cursor window `(fromCursor, checkpoint]`. A relay
 * delivers it ONLY to its sockets whose memo for this shape is `fromCursor` —
 * advancing them to `checkpoint` — so a socket that seeded at a different cursor
 * (mid-flush) is skipped and never double-applies a delta. The relay wraps the
 * `rowsPatch` in per-socket poke frames (each socket's own `subId`); `name`/`args`
 * identify the shape so the relay can match its subscribers.
 */
interface RelayShapePoke {
    args: Record<string, unknown>;
    checkpoint: number;
    epoch?: string;
    fromCursor: number;
    name: string;
    rowsPatch: ShapeRowOp[];

    /**
     * When set, this is a PER-SOCKET proxy poke for a non-uniform (identity-scoped)
     * shape, computed under that one socket's identity — the relay delivers it ONLY
     * to the socket with this connection id, never the whole cohort. Absent for a
     * uniform cohort multicast (delivered to every matching socket).
     */
    targetConnectionId?: string;
    type: "relay_shape_poke";
}

/** Internal owner↔relay control messages (plan 075). NOT the public client protocol — the app never sees these. */
type OwnerRelayFrame = RelayAttach | RelayDetach | RelayFrame | RelayShapePoke | RelayShapeSubscribe;

export { clampPromotionThresholds, DEFAULT_PROMOTION_THRESHOLDS, nextPromotionState, relayCountFor, shapeRoutingKey };
export type { OwnerRelayFrame, PromotionState, PromotionThresholds, RelayAttach, RelayDetach, RelayFrame, RelayShapePoke, RelayShapeSeed, RelayShapeSubscribe };
// The DO-name contract lives in `shared/` so `@lunora/runtime` (which mints relay
// names) and this package (which parses them) can't drift; re-exported so `./relay`
// stays the single import surface for the relay tier inside `@lunora/do`.
export { parseRelayName, RELAY_NAME_INFIX, relayName } from "../../../shared/relay-name";
