import Foundation

/// The cursor-gated, rebaseable optimistic-update engine — a port of
/// `packages/client/src/optimistic-layers.ts`.
///
/// An optimistic transform is recorded as a LAYER on its subscription rather than
/// written once and forgotten, so the displayed value is always
/// ``LunoraOptimisticState/serverBase`` folded through the active layers. Two
/// things follow, and both are the reason for the design:
///
/// 1. An incoming server frame re-folds the still-pending layers onto the new
///    authoritative base ("rebasing") instead of clobbering them, so a queued
///    offline write's predicted value survives an unrelated delta on the query.
/// 2. A layer is dropped the moment a frame whose `cursor` has reached the
///    write's committed `commitCursor` arrives (its effect is now in the base),
///    so the confirming frame cannot double-count it. The drop is keyed on the
///    SERVER-confirmed cursor, never on RPC-response timing, which races the
///    socket broadcast.
///
/// Both optimistic APIs route through this one engine: the single-query per-call
/// transform registers a TRANSFORM layer (re-derived from the new base on every
/// delta — true rebasing), and the multi-query ``LunoraOptimisticLocalStore``
/// registers a CONSTANT layer per `setQuery`. They compose on a shared
/// subscription by fold order, and a constant layer MASKS rather than merges —
/// while pending it re-clamps to its predicted value and hides a concurrent
/// server change to that query, which is the intended absolute-override
/// semantics.
///
/// **Callbacks are never invoked from here.** Every function that would notify
/// appends to a `deferred` array instead. The client mutates layer state under
/// the `NSLock` that guards its subscription registry, and `NSLock` is not
/// recursive — running a consumer's callback inside that critical section is how
/// a handler that subscribes deadlocks the socket reader. The caller drains
/// `deferred` once it has unlocked, the same discipline ``LunoraClient`` already
/// uses for server frames.
///
/// **Divergence from `@lunora/client`.** The TypeScript engine suppresses a
/// notification whose folded result is reference-identical to the value already
/// displayed. Reference identity has no portable meaning across the seven ports,
/// so they notify on every fold instead — a consumer sees at most a few redundant
/// callbacks carrying the same value, never a missing one.
public enum LunoraOptimistic {
    /// Derives the value to display from the value displayed now, or nil to be
    /// skipped for this fold.
    ///
    /// It is re-run on every rebase, so it must derive from its input rather than
    /// remember: a transform that closed over what it produced last time would
    /// compound its own effect on each server frame.
    ///
    /// It returns an optional rather than throwing for the same reason Rust's
    /// returns one: the sibling ports skip a layer whose transform THREW, and
    /// `rethrows` through a stored closure would put `try` on every fold. A
    /// transform that cannot produce a value says so by returning nil.
    public typealias Transform = (Any) -> Any?

    /// A thunk queued for the caller to run once it has released the lock.
    public typealias Deferred = [() -> Void]

    private static let idLock = NSLock()
    private static var nextLayerID = 0

    /// Mints a layer id. Removal compares ids, so two layers holding equivalent
    /// closures stay distinguishable.
    static func mintLayerID() -> Int {
        idLock.lock()
        defer { idLock.unlock() }

        nextLayerID += 1

        return nextLayerID
    }

    /// Folds `base` through `layers` in order, returning the displayed value.
    ///
    /// A layer whose transform declines (returns nil) is SKIPPED rather than
    /// aborting the fold: one optimistic update that cannot apply to the current
    /// value must not blank the whole query for every other layer.
    public static func fold(_ base: Any, _ layers: [LunoraOptimisticLayer]) -> Any {
        var value = base

        for layer in layers {
            if let next = layer.transform(value) { value = next }
        }

        return value
    }

    /// Sets the displayed value and queues the subscription's handlers.
    public static func notify(_ state: LunoraOptimisticState, _ value: Any, _ deferred: inout Deferred) {
        state.lastValue = value

        for callback in state.callbacks {
            deferred.append { callback(value) }
        }
    }

    /// Layers one transform onto `state`, returning its settle handle — or nil,
    /// leaving the state untouched, when the transform declines the value it is
    /// first handed: there is nothing to display and nothing to settle.
    public static func applyLayer(
        _ state: LunoraOptimisticState,
        _ transform: @escaping Transform,
        _ deferred: inout Deferred
    ) -> LunoraOptimisticHandle? {
        // Same input as the reference client: the current DISPLAYED value, i.e.
        // `serverBase` already folded through any prior layers.
        guard let predicted = transform(state.lastValue) else { return nil }

        return installLayer(state, transform, predicted, &deferred)
    }

    /// Installs a layer whose first result was ALREADY derived.
    ///
    /// The split exists for the write path: a consumer's transform must be run
    /// against a snapshot with the client UNLOCKED, and the lock taken only to
    /// install what came back.
    static func installLayer(
        _ state: LunoraOptimisticState,
        _ transform: @escaping Transform,
        _ predicted: Any,
        _ deferred: inout Deferred
    ) -> LunoraOptimisticHandle {
        let layer = LunoraOptimisticLayer(transform: transform)

        state.layers.append(layer)
        notify(state, predicted, &deferred)

        return LunoraOptimisticHandle(state: state, layer: layer)
    }

    /// Drops every layer whose write has committed at or before `cursor`,
    /// reporting whether anything was removed.
    ///
    /// Called on each `data`/`delta` frame: a layer confirmed at a cursor the
    /// frame has reached is now reflected in `serverBase`, so keeping it would
    /// double-count. Layers with no commit cursor yet (still queued or in flight)
    /// are kept, so their overlay survives the frame.
    @discardableResult
    public static func dropConfirmedLayers(_ state: LunoraOptimisticState, _ cursor: Int?) -> Bool {
        guard let cursor, !state.layers.isEmpty else { return false }

        let before = state.layers.count

        state.layers.removeAll { layer in
            guard let committed = layer.commitCursor else { return false }

            return committed <= cursor
        }

        return state.layers.count != before
    }

    /// Confirms every layer a write registered, against its committed cursor.
    public static func confirmAll(_ handles: [LunoraOptimisticHandle], _ commitCursor: Int?, _ deferred: inout Deferred) {
        for handle in handles {
            handle.confirm(commitCursor, &deferred)
        }
    }

    /// Unwinds a write's layers, most-recent-first.
    ///
    /// LIFO, not FIFO: layers compose by fold order, so removing an earlier one
    /// first would re-fold the later ones onto a base they never saw.
    public static func rollbackAll(_ handles: [LunoraOptimisticHandle], _ deferred: inout Deferred) {
        for handle in handles.reversed() {
            handle.rollback(&deferred)
        }
    }

    /// A constant-value transform — what the local store registers per `setQuery`.
    public static func constant(_ value: Any) -> Transform {
        { _ in value }
    }
}

/// One active optimistic transform layered onto a subscription.
public final class LunoraOptimisticLayer {
    public let id: Int
    let transform: LunoraOptimistic.Transform

    /// The CDC cursor the write committed at, from the mutation's response. Nil
    /// while the write is still queued or in flight, which is what keeps the
    /// overlay alive across unrelated deltas until it is confirmed.
    public var commitCursor: Int?

    init(transform: @escaping LunoraOptimistic.Transform) {
        self.id = LunoraOptimistic.mintLayerID()
        self.transform = transform
    }
}

/// The layered value a subscription displays.
public final class LunoraOptimisticState {
    /// The authoritative value with NO overlay. It tracks ``lastValue`` exactly
    /// while no layer is active, and is what the layers fold onto when one is.
    public var serverBase: Any

    /// The CDC high-watermark ``lastValue`` reflects, from the last cursor-stamped
    /// frame.
    public var serverCursor: Int?

    /// The DISPLAYED value: ``serverBase`` folded through ``layers``.
    public var lastValue: Any

    /// The active overlays, in application order. Empty for the common case — no
    /// pending optimistic write — where this behaves exactly as a plain
    /// server-value assignment.
    public var layers: [LunoraOptimisticLayer] = []

    /// Receive the displayed value.
    public var callbacks: [(Any) -> Void] = []

    public init(base: Any = NSNull()) {
        self.serverBase = base
        self.lastValue = base
    }
}

/// Settles one layer: ``confirm(_:_:)`` on success, ``rollback(_:)`` on failure.
public final class LunoraOptimisticHandle {
    private let state: LunoraOptimisticState
    private let layer: LunoraOptimisticLayer

    init(state: LunoraOptimisticState, layer: LunoraOptimisticLayer) {
        self.state = state
        self.layer = layer
    }

    /// Gates the layer's removal on the server-confirmed cursor.
    ///
    /// A nil cursor (CDC off on this shard, so nothing was echoed) drops the layer
    /// immediately but does NOT re-fold: confirm runs on SUCCESS, so the displayed
    /// value reflects a write that just committed, and re-folding here would
    /// visibly revert it to the pre-write base until the authoritative frame
    /// supersedes it. ``rollback(_:)`` is the path that re-folds.
    public func confirm(_ commitCursor: Int?, _ deferred: inout LunoraOptimistic.Deferred) {
        guard let commitCursor else {
            remove()

            return
        }

        layer.commitCursor = commitCursor

        // A confirming (or later) frame already advanced past the commit cursor,
        // so the write is in `serverBase` — drop the overlay now rather than
        // leaving it until the next frame.
        if let reached = state.serverCursor, reached >= commitCursor, remove() {
            refold(&deferred)
        }
    }

    /// Removes the layer and re-folds, so the bad value disappears.
    public func rollback(_ deferred: inout LunoraOptimistic.Deferred) {
        if remove() { refold(&deferred) }
    }

    @discardableResult
    private func remove() -> Bool {
        let before = state.layers.count

        state.layers.removeAll { $0.id == layer.id }

        return state.layers.count != before
    }

    private func refold(_ deferred: inout LunoraOptimistic.Deferred) {
        LunoraOptimistic.notify(state, LunoraOptimistic.fold(state.serverBase, state.layers), &deferred)
    }
}

/// A subscribed query's args paired with its displayed value.
public struct LunoraQueryEntry {
    public let args: Any?
    public let value: Any

    public init(args: Any?, value: Any) {
        self.args = args
        self.value = value
    }
}

/// A read/write handle over the client's live query cache, handed to a write's
/// `optimisticUpdate` so ONE mutation can patch MANY subscribed queries.
///
/// Each ``setQuery(_:args:value:)`` registers a constant layer through the same
/// engine the single-query path uses, so the whole batch rebases onto incoming
/// deltas and settles together — confirmed on the mutation's commit cursor, or
/// rolled back on failure.
///
/// The consumer's `optimisticUpdate` closure runs with the client UNLOCKED — it
/// is handed this store, so a closure that reads the client back would deadlock
/// under a non-recursive lock. ``setQuery(_:args:value:)`` therefore only RECORDS
/// its override; ``install()`` turns the recorded batch into layers, and the
/// client calls it with its lock held. Every transform installed there is a
/// constant, so no consumer code runs inside that critical section.
public final class LunoraOptimisticLocalStore {
    private let find: (String, Any?) -> [LunoraOptimisticState]
    private let matching: (String) -> [LunoraQueryEntry]

    /// The recorded overrides, in call order, with the states each resolved to.
    private var writes: [(states: [LunoraOptimisticState], value: Any)] = []

    /// The overrides by (path, args), so a read-back inside the same batch sees
    /// what this batch already wrote rather than the pre-write server value.
    private var overrides: [String: Any] = [:]

    /// The settle handles every ``setQuery(_:args:value:)`` produced, in
    /// application order, for the caller to settle when the mutation does.
    public private(set) var handles: [LunoraOptimisticHandle] = []

    /// Notifications queued by this batch, for the caller to drain once unlocked.
    public private(set) var deferred: LunoraOptimistic.Deferred = []

    init(
        find: @escaping (String, Any?) -> [LunoraOptimisticState],
        matching: @escaping (String) -> [LunoraQueryEntry]
    ) {
        self.find = find
        self.matching = matching
    }

    /// The current cached value for a subscribed query, or nil when nothing is
    /// subscribed for it. Reflects any override already written in this batch.
    public func getQuery(_ functionPath: String, args: Any? = nil) -> Any? {
        overrides[Self.key(functionPath, args)] ?? find(functionPath, args).first?.lastValue
    }

    /// Every loaded subscription on `functionPath` with the args it was subscribed
    /// under — for a write that must patch every variant of a list query without
    /// enumerating their args up front.
    public func getAllQueries(_ functionPath: String) -> [LunoraQueryEntry] {
        matching(functionPath).map { entry in
            guard let override = overrides[Self.key(functionPath, entry.args)] else { return entry }

            return LunoraQueryEntry(args: entry.args, value: override)
        }
    }

    /// Writes an optimistic override for a subscribed query. A no-op when nothing
    /// is subscribed for it: you only patch queries the consumer is watching.
    public func setQuery(_ functionPath: String, args: Any?, value: Any) {
        let states = find(functionPath, args)

        guard !states.isEmpty else { return }

        writes.append((states, value))
        overrides[Self.key(functionPath, args)] = value
    }

    /// Turns the recorded batch into constant layers. Run with the owning client's
    /// lock held; idempotent, so a second call installs nothing twice.
    func install() {
        for write in writes {
            for state in write.states {
                if let handle = LunoraOptimistic.applyLayer(state, LunoraOptimistic.constant(write.value), &deferred) {
                    handles.append(handle)
                }
            }
        }

        writes = []
    }

    /// An args-insensitive spelling of one subscribed query. Args that fall outside
    /// the wire codec key as the empty string, exactly as the client's subscription
    /// lookup does, so the two agree on what "the same query" means.
    private static func key(_ functionPath: String, _ args: Any?) -> String {
        functionPath + "\u{0}" + ((try? Wire.stableWireKey(args ?? [String: Any]())) ?? "")
    }
}
