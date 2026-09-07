//! Lunora Rust SDK — a protocol-conformant client for a Lunora deployment.
//!
//! See `protocol/README.md` for the language-independent wire protocol this
//! implements. The HTTP poster and the socket frame sender are injected, so the
//! conformance suite runs offline and a consumer keeps its own HTTP stack and
//! socket library rather than inheriting ours.

pub mod client;
pub mod key;
pub mod offline;
pub mod optimistic;
pub mod submit;
pub mod wire;

pub use client::{
    build_connect_frame, build_rpc_body, build_shape_subscribe_frame, build_shape_unsubscribe_frame, build_subscribe_frame, build_unsubscribe_frame,
    parse_rpc_response, ApiError, Client, ClientError, FrameSender, HttpPoster, StreamEvent, SubscriptionError, Verb, CODE_INVALID_FRAME, RPC_BATCH_PATH,
    RPC_PATH, WS_PATH,
};
pub use key::{stable_stringify, stable_wire_key};
pub use offline::{
    identity_allows_replay, is_stale_version, random_id, Discarded, Identity, OfflineQueue, PersistenceAdapter, QueuedMutation, CODE_CLIENT_CLOSED,
    CODE_OFFLINE_IDENTITY_CHANGED, CODE_OFFLINE_PRECONDITION_FAILED, CODE_OFFLINE_QUEUE_OVERFLOW, CODE_OFFLINE_WRITE_UNDECODABLE,
    CODE_OFFLINE_WRITE_UNENCODABLE, CODE_PAYLOAD_TOO_LARGE, DEFAULT_MAX_ITEMS, MAX_BATCH_BYTES, MAX_RETRY_AFTER_MS, RATE_LIMIT_ERROR_CODES,
    TRANSIENT_ERROR_CODES,
};
pub use optimistic::{
    apply_layer, confirm_layer, constant, drop_confirmed_layers, fold, rollback_layer, shared, OptimisticLayer, OptimisticState, SharedTransform, Transform,
};
pub use submit::{is_transient, retry_after_ms, FlushReport, MutationOutcome, MutationSettled, MutationStatus, OptimisticQuery, SubmitOptions};
pub use wire::{decode_wire, encode_wire, from_json, from_model_json, WireError, WireValue, MAX_BIGINT_DIGITS, MAX_DEPTH, TAG};
