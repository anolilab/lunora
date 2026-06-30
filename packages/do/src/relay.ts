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
        throw new Error(`invalid promotion thresholds: tDown (${String(thresholds.tDown)}) must be < tUp (${String(thresholds.tUp)})`);
    }

    if (current === "owned") {
        return subscribers >= thresholds.tUp ? "promoted" : "owned";
    }

    return subscribers < thresholds.tDown ? "owned" : "promoted";
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

/** Internal owner↔relay control messages (plan 075). NOT the public client protocol — the app never sees these. */
type OwnerRelayFrame = RelayAttach | RelayDetach | RelayFrame;

export { DEFAULT_PROMOTION_THRESHOLDS, nextPromotionState, relayCountFor };
export type { OwnerRelayFrame, PromotionState, PromotionThresholds, RelayAttach, RelayDetach, RelayFrame };
// The DO-name contract lives in `shared/` so `@lunora/runtime` (which mints relay
// names) and this package (which parses them) can't drift; re-exported so `./relay`
// stays the single import surface for the relay tier inside `@lunora/do`.
export { parseRelayName, RELAY_NAME_INFIX, relayName } from "../../../shared/relay-name";
