//! The cursor-gated, rebaseable optimistic-update engine — a port of
//! `packages/client/src/optimistic-layers.ts`.
//!
//! An optimistic transform is recorded as a LAYER on its subscription rather
//! than written once and forgotten, so the displayed value is always
//! [`OptimisticState::server_base`] folded through the active layers. Two things
//! follow, and both are the reason for the design:
//!
//! 1. An incoming server frame re-folds the still-pending layers onto the new
//!    authoritative base ("rebasing") instead of clobbering them, so a queued
//!    offline write's predicted value survives an unrelated delta on the query.
//! 2. A layer is dropped the moment a frame whose `cursor` has reached the
//!    write's committed `commit_cursor` arrives (its effect is now in the base),
//!    so the confirming frame cannot double-count it. The drop is keyed on the
//!    SERVER-confirmed cursor, never on RPC-response timing, which races the
//!    socket broadcast.
//!
//! Both optimistic APIs route through this one engine: the single-query per-call
//! transform registers a TRANSFORM layer (re-derived from the new base on every
//! delta — true rebasing), and the multi-query local store registers a CONSTANT
//! layer per `set_query`. They compose on a shared subscription by fold order,
//! and a constant layer MASKS rather than merges — while pending it re-clamps to
//! its predicted value and hides a concurrent server change to that query, which
//! is the intended absolute-override semantics.
//!
//! # Two divergences from the sibling ports, both forced by Rust
//!
//! A [`Transform`] returns `Option<WireValue>` rather than raising. The other
//! six skip a layer whose transform THREW; Rust has no exceptions, so a layer
//! that cannot produce a value says so by returning `None` and the fold skips it
//! — same semantics, expressed the way the language expresses it. (Catching a
//! panic would need `catch_unwind` and an `UnwindSafe` bound on every injected
//! closure, to model a condition Rust already has a value for.)
//!
//! A settle handle is a plain `(subscription id, layer id)` pair rather than an
//! object holding the state. Storing a `&mut` borrow of the subscription for
//! later use is exactly what the borrow checker exists to reject, so the client
//! keeps the ids and re-resolves the state when it settles. That is also why
//! nothing here defers its callbacks: the client carries no lock (see
//! [`crate::client::Client`]'s concurrency notes), so there is no critical
//! section to get out of before invoking one.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::wire::WireValue;

/// Derives the value to display from the value displayed now, or `None` to be
/// skipped for this fold.
///
/// It is re-run on every rebase, so it must derive from its input rather than
/// remember: a transform that closed over the value it produced last time would
/// compound its own effect on each server frame.
pub type Transform = Box<dyn Fn(&WireValue) -> Option<WireValue> + Send>;

/// A [`Transform`] a caller can hand to SEVERAL subscriptions at once.
///
/// One write's single-query `optimistic` may match more than one subscription —
/// this client does not de-duplicate them — and each needs its OWN layer so it
/// rebases independently. A `Box` cannot be split that way, hence the `Arc`; the
/// extra `Sync` bound is what sharing one closure across layers costs.
pub type SharedTransform = std::sync::Arc<dyn Fn(&WireValue) -> Option<WireValue> + Send + Sync>;

/// Boxes one layer's view of a shared transform.
pub fn shared(transform: &SharedTransform) -> Transform {
    let held = std::sync::Arc::clone(transform);

    Box::new(move |current| held(current))
}

static NEXT_LAYER_ID: AtomicU64 = AtomicU64::new(1);

/// One active optimistic transform layered onto a subscription.
pub struct OptimisticLayer {
    /// Identifies the layer for removal. Two layers can hold equivalent
    /// closures, so removal compares ids rather than anything about the
    /// transform.
    pub id: u64,
    transform: Transform,
    /// The CDC cursor the write committed at, from the mutation's response.
    /// `None` while the write is still queued or in flight, which is what keeps
    /// the overlay alive across unrelated deltas until it is confirmed.
    pub commit_cursor: Option<i64>,
}

impl OptimisticLayer {
    /// Builds a layer directly, minting its id.
    ///
    /// [`apply_layer`] is the normal path — it also computes and publishes the
    /// predicted value. This is for a caller assembling a state by hand, which in
    /// practice means the conformance suite constructing a layer that DECLINES,
    /// since `apply_layer` refuses one by design.
    pub fn new(transform: Transform) -> Self {
        Self {
            commit_cursor: None,
            id: NEXT_LAYER_ID.fetch_add(1, Ordering::Relaxed),
            transform,
        }
    }
}

/// The layered value a subscription displays.
pub struct OptimisticState {
    /// The authoritative value with NO overlay. It tracks `last_value` exactly
    /// while no layer is active, and is what the layers fold onto when one is.
    pub server_base: WireValue,
    /// The CDC high-watermark `last_value` reflects, from the most recent
    /// cursor-stamped frame.
    pub server_cursor: Option<i64>,
    /// The DISPLAYED value: `server_base` folded through `layers`.
    pub last_value: WireValue,
    /// The active overlays, in application order. Empty for the common case — no
    /// pending optimistic write — where this behaves exactly as a plain
    /// server-value assignment.
    pub layers: Vec<OptimisticLayer>,
}

impl OptimisticState {
    /// A state seeded with an authoritative value and no overlays.
    pub fn new(base: WireValue) -> Self {
        Self {
            last_value: base.clone(),
            layers: Vec::new(),
            server_base: base,
            server_cursor: None,
        }
    }
}

impl Default for OptimisticState {
    /// A subscription that has not yet received a frame displays null, which is
    /// what `WireValue` spells an absent value as — `Undefined` means "the key
    /// was omitted", a distinction the codec keeps and this is not.
    fn default() -> Self {
        Self::new(WireValue::Null)
    }
}

/// Folds `base` through `layers` in order, returning the displayed value.
///
/// A layer whose transform declines (returns `None`) is SKIPPED rather than
/// aborting the fold: one optimistic update that cannot apply to the current
/// value must not blank the whole query for every other layer.
pub fn fold(base: &WireValue, layers: &[OptimisticLayer]) -> WireValue {
    let mut value = base.clone();

    for layer in layers {
        if let Some(next) = (layer.transform)(&value) {
            value = next;
        }
    }

    value
}

/// Layers one transform onto `state` and returns its layer id, or `None` —
/// leaving the state untouched — when the transform declines the value it is
/// first handed: there is nothing to display and nothing to settle.
///
/// The caller notifies; this returns the value to publish through
/// `state.last_value`.
pub fn apply_layer(state: &mut OptimisticState, transform: Transform) -> Option<u64> {
    // Same input as the reference client: the current DISPLAYED value, i.e.
    // `server_base` already folded through any prior layers.
    let predicted = transform(&state.last_value)?;
    let id = NEXT_LAYER_ID.fetch_add(1, Ordering::Relaxed);

    state.layers.push(OptimisticLayer {
        commit_cursor: None,
        id,
        transform,
    });
    state.last_value = predicted;

    Some(id)
}

/// Gates a layer's removal on the server-confirmed cursor, reporting whether the
/// displayed value changed.
///
/// A `None` cursor (CDC off on this shard, so nothing was echoed) drops the
/// layer immediately but does NOT re-fold: `confirm` runs on SUCCESS, so the
/// displayed value reflects a write that just committed, and re-folding here
/// would visibly revert it to the pre-write base until the authoritative frame
/// supersedes it. [`rollback_layer`] is the path that re-folds.
pub fn confirm_layer(state: &mut OptimisticState, layer_id: u64, commit_cursor: Option<i64>) -> bool {
    let Some(index) = state.layers.iter().position(|layer| layer.id == layer_id) else {
        return false;
    };

    let Some(cursor) = commit_cursor else {
        state.layers.remove(index);

        return false;
    };

    state.layers[index].commit_cursor = Some(cursor);

    // A confirming (or later) frame already advanced past the commit cursor, so
    // the write is in `server_base` — drop the overlay now rather than leaving
    // it until the next frame.
    if state.server_cursor.is_some_and(|reached| reached >= cursor) {
        state.layers.remove(index);
        state.last_value = fold(&state.server_base, &state.layers);

        return true;
    }

    false
}

/// Removes a layer and re-folds, so the bad value disappears. Reports whether
/// the displayed value changed.
pub fn rollback_layer(state: &mut OptimisticState, layer_id: u64) -> bool {
    let Some(index) = state.layers.iter().position(|layer| layer.id == layer_id) else {
        return false;
    };

    state.layers.remove(index);
    state.last_value = fold(&state.server_base, &state.layers);

    true
}

/// Drops every layer whose write has committed at or before `cursor`, reporting
/// whether anything was removed.
///
/// Called on each `data`/`delta` frame: a layer confirmed at a cursor the frame
/// has reached is now reflected in `server_base`, so keeping it would
/// double-count. Layers with no commit cursor yet (still queued or in flight)
/// are kept, so their overlay survives the frame.
pub fn drop_confirmed_layers(state: &mut OptimisticState, cursor: Option<i64>) -> bool {
    let Some(reached) = cursor else {
        return false;
    };

    if state.layers.is_empty() {
        return false;
    }

    let before = state.layers.len();

    state.layers.retain(|layer| layer.commit_cursor.is_none_or(|committed| committed > reached));

    state.layers.len() != before
}

/// A constant-value transform — what the multi-query local store registers per
/// `set_query`.
pub fn constant(value: WireValue) -> Transform {
    Box::new(move |_current| Some(value.clone()))
}
