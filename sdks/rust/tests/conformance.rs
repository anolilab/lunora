//! Protocol-conformance tests: drive the Rust SDK against the shared golden
//! fixtures in `protocol/fixtures/`, the same files the TypeScript client and
//! the Python, Go, Ruby and Swift ports are tested against.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use lunora::client::{
    build_connect_frame, build_rpc_body, build_shape_subscribe_frame, build_subscribe_frame, build_unsubscribe_frame, parse_rpc_response, Client, ClientError,
    StreamEvent, CODE_INVALID_FRAME, MAX_PENDING_POKES,
};
use lunora::key::{stable_stringify, stable_wire_key};
use lunora::submit::is_transient;
use lunora::wire::{decode_wire, encode_wire, from_json, from_model_json, WireValue, MAX_BIGINT_DIGITS, MAX_DEPTH, MAX_EXACT_INTEGER, TAG};
use serde_json::{json, Value};

// The optimistic-layer and offline-queue cases live in their own file, dispatched
// from the manifest arm below like every other case. A subdirectory module, not a
// second `tests/*.rs`, because cargo would compile that as its own test binary
// with no `#[test]` in it — the manifest must stay the only entry point.
mod offline_cases;

use offline_cases::{
    batch_entry_cap_matches_protocol, offline_flush_batch_splits_on_payload_too_large, offline_flush_batches_multiple_writes,
    offline_flush_replays_and_confirms_optimistic, offline_flush_unencodable_write_settles_terminal, offline_queue_drains_only_the_named_shard,
    offline_queue_fifo_replay_order, offline_queue_hydrate_overflow_settles_discarded, offline_queue_hydrates_persisted_writes,
    offline_queue_identity_gate_rejects_replay, offline_queue_overflow_evicts_oldest, offline_queue_precondition_drops_stale_write,
    optimistic_cursorless_frame_preserves_cursor, optimistic_layer_drops_on_commit_cursor, optimistic_layer_drops_on_settled_frame,
    optimistic_layer_rebases_onto_server_frame, optimistic_layer_rolls_back_on_failure,
};

/// Walks up from the crate directory to the repo's `protocol/fixtures`.
fn fixtures_dir() -> PathBuf {
    let mut directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    for _ in 0..8 {
        let candidate = directory.join("protocol/fixtures");

        if candidate.is_dir() {
            return candidate;
        }

        if !directory.pop() {
            break;
        }
    }

    panic!("could not locate protocol/fixtures");
}

fn fixture(name: &str) -> Value {
    let raw = fs::read_to_string(fixtures_dir().join(name)).expect("fixture readable");

    serde_json::from_str(&raw).expect("fixture parses")
}

/// Re-serialises so two structures compare as text with a canonical key order,
/// independent of the order the fixture file happens to use.
fn canonical(value: &Value) -> String {
    stable_stringify(value)
}

/// Fails if this run did not exercise every case in the shared manifest.
///
/// libtest has no after-all hook and no cross-test state a final check could
/// read, so the manifest DRIVES the run rather than auditing it afterwards:
/// every name in `protocol/conformance-cases.json` is dispatched to the function
/// that asserts it, and a name with no arm fails here. The cases below are plain
/// functions rather than `#[test]`s for that reason — this is the only entry
/// point, so a case cannot be silently detached from its manifest name. The cost
/// is that the first failing case ends the run; the panic names the assertion.
#[test]
fn conformance_manifest_is_covered() {
    let manifest: Value = {
        let path = fixtures_dir().parent().expect("protocol dir").join("conformance-cases.json");
        let raw = fs::read_to_string(&path).unwrap_or_else(|error| panic!("{} unreadable: {error}", path.display()));

        serde_json::from_str(&raw).expect("manifest parses")
    };

    let required = manifest["required"].as_array().expect("required");

    assert!(!required.is_empty(), "the manifest must list at least one required case");

    for name in required {
        match name.as_str().expect("case name is a string") {
            "wire_codec_round_trip" => wire_codec_round_trip(),
            "undefined_is_distinct_from_null" => undefined_is_distinct_from_null(),
            "over_long_bigint_rejected" => over_long_bigint_rejected(),
            "malformed_values_rejected" => malformed_values_rejected(),
            "depth_cap_enforced" => depth_cap_enforced(),
            "exact_integer_range_enforced" => exact_integer_range_enforced(),
            "stable_wire_key_fixtures" => stable_wire_key_fixtures(),
            "format_number_matches_ecmascript" => format_number_matches_ecmascript(),
            "key_order_matches_utf16" => key_order_matches_utf16(),
            "string_escaping_matches_json_stringify" => string_escaping_matches_json_stringify(),
            "empty_shard_key_is_omitted" => empty_shard_key_is_omitted(),
            "rpc_request_bodies" => rpc_request_bodies(),
            "rpc_responses" => rpc_responses(),
            "non_2xx_without_error_envelope_fails" => non_2xx_without_error_envelope_fails(),
            "client_frame_builders" => client_frame_builders(),
            "server_frame_consumer" => server_frame_consumer(),
            "subscription_stream_yields_frame_values_in_order" => subscription_stream_yields_frame_values_in_order(),
            "shape_subscribe_frame" => shape_subscribe_frame(),
            "shape_subscriptions_resend_after_reconnect" => shape_subscriptions_resend_after_reconnect(),
            "poke_sequence_materialises_rows" => poke_sequence_materialises_rows(),
            "poke_parts_do_not_apply_before_poke_end" => poke_parts_do_not_apply_before_poke_end(),
            "shape_reset_poke_replaces_membership" => reset_poke_replaces_the_view(),
            "pending_poke_buffers_are_bounded" => pending_poke_buffers_are_bounded(),
            "optimistic_layer_rebases_onto_server_frame" => optimistic_layer_rebases_onto_server_frame(),
            "optimistic_layer_drops_on_commit_cursor" => optimistic_layer_drops_on_commit_cursor(),
            "optimistic_layer_drops_on_settled_frame" => optimistic_layer_drops_on_settled_frame(),
            "optimistic_layer_rolls_back_on_failure" => optimistic_layer_rolls_back_on_failure(),
            "offline_queue_fifo_replay_order" => offline_queue_fifo_replay_order(),
            "offline_queue_drains_only_the_named_shard" => offline_queue_drains_only_the_named_shard(),
            "offline_queue_overflow_evicts_oldest" => offline_queue_overflow_evicts_oldest(),
            "offline_queue_precondition_drops_stale_write" => offline_queue_precondition_drops_stale_write(),
            "offline_queue_hydrates_persisted_writes" => offline_queue_hydrates_persisted_writes(),
            "offline_queue_identity_gate_rejects_replay" => offline_queue_identity_gate_rejects_replay(),
            "offline_flush_replays_and_confirms_optimistic" => offline_flush_replays_and_confirms_optimistic(),
            "offline_flush_batches_multiple_writes" => offline_flush_batches_multiple_writes(),
            "offline_flush_batch_splits_on_payload_too_large" => offline_flush_batch_splits_on_payload_too_large(),
            "optimistic_cursorless_frame_preserves_cursor" => optimistic_cursorless_frame_preserves_cursor(),
            "offline_queue_hydrate_overflow_settles_discarded" => offline_queue_hydrate_overflow_settles_discarded(),
            "offline_flush_unencodable_write_settles_terminal" => offline_flush_unencodable_write_settles_terminal(),
            "batch_entry_cap_matches_protocol" => batch_entry_cap_matches_protocol(),
            other => panic!("protocol/conformance-cases.json requires case {other:?}, which this suite does not implement"),
        }
    }
}

fn wire_codec_round_trip() {
    let document = fixture("wire-codec.json");
    let cases = document["cases"].as_array().expect("cases");

    assert!(cases.len() > 10, "fixture should carry the full case set");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let encoded = &case["encoded"];
        let round_tripped = encode_wire(&decode_wire(encoded).expect("decode")).expect("encode");
        // A handful of shapes are legitimately not fixed points — a bare [TAG]
        // array is escaped on the way out, an `undefined` object field is
        // dropped — and carry the expected re-encoding.
        let expected = case.get("reencoded").unwrap_or(encoded);

        assert_eq!(canonical(&round_tripped), canonical(expected), "round-trip mismatch for {name}");
    }
}

fn undefined_is_distinct_from_null() {
    let encoded = encode_wire(&WireValue::Object(vec![
        ("dropped".into(), WireValue::Undefined),
        ("kept".into(), WireValue::Null),
    ]))
    .expect("encode");

    assert!(
        encoded.get("dropped").is_none(),
        "an undefined object field must be dropped, matching JSON.stringify"
    );
    assert_eq!(encoded.get("kept"), Some(&Value::Null), "a null object field must be kept");

    // In an array position the slot must survive, or every later element shifts.
    let in_array = encode_wire(&WireValue::Array(vec![WireValue::Undefined, WireValue::Number(1.0)])).expect("encode");

    assert_eq!(in_array[0], json!([TAG, "undefined"]));
}

fn over_long_bigint_rejected() {
    let over_long = "9".repeat(MAX_BIGINT_DIGITS + 1);

    assert!(decode_wire(&json!([TAG, "bigint", over_long])).is_err());
    assert!(decode_wire(&json!([TAG, "bigint", "12x4"])).is_err());
    assert_eq!(decode_wire(&json!([TAG, "bigint", "-42"])).expect("decode"), WireValue::BigInt("-42".into()));
}

/// Walks the shared rejection list.
///
/// The list is data (`protocol/fixtures/wire-codec.json`), not a per-suite
/// invention: a rejection each port hard-codes for itself is a rejection only
/// some ports have, which is exactly how THIS port's hand-rolled base64 decoder
/// went on accepting `"AQIDA"` and `"AQ=ID"` — handing short, valid-looking
/// bytes to application code — while seven ports rejected both.
fn malformed_values_rejected() {
    let document = fixture("wire-codec.json");
    let rejected = document["rejected"].as_array().expect("rejected");

    assert!(!rejected.is_empty(), "the fixture must carry a rejection list");

    for case in rejected {
        let name = case["name"].as_str().unwrap_or("?");

        assert!(decode_wire(&case["encoded"]).is_err(), "{name} must be rejected");
    }

    assert_eq!(decode_wire(&json!([TAG, "bytes", "AQID"])).expect("decode"), WireValue::Bytes(vec![1, 2, 3]));

    // Whitespace INSIDE a payload is not a rejection: the reference decodes via
    // `atob`, which strips ASCII whitespace before doing anything else.
    assert_eq!(decode_wire(&json!([TAG, "bytes", "AQ\nID"])).expect("decode"), WireValue::Bytes(vec![1, 2, 3]));

    // A bare [TAG] is NOT malformed: it is the forward-compat shape, and the
    // reference hands it back as an ordinary array.
    assert_eq!(
        decode_wire(&json!([TAG])).expect("decode"),
        WireValue::Array(vec![WireValue::String(TAG.into())])
    );
}

/// An integer a float64 cannot hold exactly must not silently become a
/// different integer on the wire.
///
/// `WireValue::Number` IS an `f64`, so this port cannot carry such an integer
/// through the codec at all — the exposure is `from_json`, where a generated
/// model's `i64` field arrives as a `serde_json` integer with every digit still
/// intact. Narrowing it there rounded it silently; it now keeps its digits as a
/// bigint, which a `v.number()` field rejects loudly at the server instead.
fn exact_integer_range_enforced() {
    // An integral number is written as a JSON integer, not `1.0` — that is what
    // `JSON.stringify` writes, and the conformance comparison normalises both
    // sides through `stable_stringify`, so it could not see the difference.
    assert_eq!(encode_wire(&WireValue::Number(1.0)).expect("encode"), json!(1));
    assert_eq!(
        encode_wire(&WireValue::Number(MAX_EXACT_INTEGER)).expect("encode"),
        json!(9_007_199_254_740_991_i64)
    );
    assert_eq!(encode_wire(&WireValue::Number(3.5)).expect("encode"), json!(3.5));

    assert_eq!(from_json(&json!(9_007_199_254_740_993_u64)), WireValue::BigInt("9007199254740993".into()));
    assert_eq!(from_json(&json!(-9_007_199_254_740_993_i64)), WireValue::BigInt("-9007199254740993".into()));

    // In range, and a float of any magnitude, stay plain numbers.
    assert_eq!(from_json(&json!(9_007_199_254_740_991_i64)), WireValue::Number(MAX_EXACT_INTEGER));
    assert_eq!(from_json(&json!(1e300)), WireValue::Number(1e300));
}

fn depth_cap_enforced() {
    let mut nested = json!("leaf");

    for _ in 0..(MAX_DEPTH + 2) {
        nested = json!([nested]);
    }

    assert!(decode_wire(&nested).is_err());

    // The ENCODE side too, as the Swift and JVM ports assert: a cap that only
    // guards the inbound direction lets this process build the payload that
    // crashes the peer.
    let mut deep = WireValue::String("leaf".to_string());

    for _ in 0..(MAX_DEPTH + 2) {
        deep = WireValue::Array(vec![deep]);
    }

    assert!(encode_wire(&deep).is_err());

    // And the boundary, or a cap that regressed to ANY smaller value still
    // passed the two assertions above: exactly MAX_DEPTH deep must round-trip.
    let mut deepest = json!("leaf");

    for _ in 0..MAX_DEPTH {
        deepest = json!([deepest]);
    }

    let decoded = decode_wire(&deepest).expect("a value nested exactly MAX_DEPTH deep must decode");

    assert_eq!(encode_wire(&decoded).expect("re-encode"), deepest);
}

fn stable_wire_key_fixtures() {
    let document = fixture("stable-wire-key.json");

    for case in document["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap_or("?");
        let decoded = decode_wire(&case["args"]).expect("decode");

        assert_eq!(stable_wire_key(&decoded).expect("key"), case["key"].as_str().unwrap(), "{name}");
    }

    for case in document["typed"].as_array().expect("typed") {
        let name = case["name"].as_str().unwrap_or("?");
        let decoded = decode_wire(&case["wireArgs"]).expect("decode");

        assert_eq!(stable_wire_key(&decoded).expect("key"), case["key"].as_str().unwrap(), "{name}");
    }
}

/// Expected spellings captured from a real JS engine, not derived from the spec
/// — the two disagreed for the Go and Ruby ports before this test existed.
fn format_number_matches_ecmascript() {
    for (value, want) in [
        (0.0, "0"),
        (3.0, "3"),
        (1.5, "1.5"),
        (-2.5, "-2.5"),
        (1e-5, "0.00001"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (1.5e-7, "1.5e-7"),
        (1e-21, "1e-21"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        // An integral double past 2^53: ECMAScript prints the SHORTEST digits
        // that read back as the same double and zero-pads, so this is not the
        // exact expansion 1152921504606846976 that `{:.0}` writes.
        (1.152_921_504_606_847e18, "1152921504606847000"),
        // Negative zero keeps its sign in a key.
        (-0.0, "-0"),
    ] {
        assert_eq!(stable_stringify(&json!(value)), want, "formatting {value}");
    }
}

/// JavaScript sorts by UTF-16 code unit, so an astral character is its high
/// surrogate (0xD83D) and sorts after U+2028 but before U+FFFD. Rust's UTF-8
/// byte-wise `Ord` puts it last — a different dedup key for identical args.
fn key_order_matches_utf16() {
    let rendered = stable_stringify(&json!({ "A": 1, "\u{2028}": 2, "\u{1F600}": 3, "\u{FFFD}": 4 }));

    assert_eq!(rendered, "{\"A\":1,\"\u{2028}\":2,\"\u{1F600}\":3,\"\u{FFFD}\":4}");
}

fn string_escaping_matches_json_stringify() {
    // JSON.stringify leaves <, > and & raw and does not escape U+2028/U+2029.
    assert_eq!(stable_stringify(&json!("a<b>&c")), "\"a<b>&c\"");
    assert_eq!(stable_stringify(&json!("\u{2028}\u{2029}")), "\"\u{2028}\u{2029}\"");
    assert_eq!(stable_stringify(&json!("tab\there")), "\"tab\\there\"");
}

fn rpc_request_bodies() {
    let document = fixture("rpc.json");

    for case in document["request"]["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap_or("?");
        let args = if case.get("args").is_some() {
            decode_wire(&case["args"]).expect("decode")
        } else {
            decode_wire(&case["argsWire"]).expect("decode")
        };

        let body = build_rpc_body(
            case["functionPath"].as_str().expect("functionPath"),
            &args,
            case.get("shardKey").and_then(Value::as_str),
        )
        .expect("build");

        assert_eq!(canonical(&body), canonical(&case["body"]), "{name}");
    }
}

/// An EMPTY shard key is absent, not the shard named `""`.
///
/// A manifest case now, so every port is held to it — it used to be this suite's
/// own test on the grounds that only some ports ever sent it, which is precisely
/// the reason to make it required rather than local. It is the one place
/// where getting it wrong is worse than the bug it replaced: this client treats
/// `""` and `None` as one shard wherever it matches a subscription or drains the
/// queue, so a `""` that reached the wire would route the write to a DIFFERENT
/// Durable Object than the subscription it updated. Both builders that carry a
/// shard key are asserted, because normalising one and not the other is the same
/// split.
fn empty_shard_key_is_omitted() {
    let body = build_rpc_body("messages:send", &WireValue::Object(Vec::new()), Some("")).expect("build");

    assert!(body.get("shardKey").is_none(), "an empty shard key is omitted from the body");
    assert_eq!(
        canonical(&body),
        canonical(&build_rpc_body("messages:send", &WireValue::Object(Vec::new()), None).expect("build")),
        "and is byte-identical to sending none"
    );

    let client = Client::new("https://app.example", None);

    assert!(!client.ws_url(Some(""), None).contains("shard="), "nor does it name a shard on the socket");
    assert_eq!(client.ws_url(Some(""), None), client.ws_url(None, None));
    // A real key still rides both, or the normalisation would have eaten sharding.
    assert!(client.ws_url(Some("room-1"), None).contains("shard=room%2D1"));
    assert_eq!(
        build_rpc_body("messages:send", &WireValue::Object(Vec::new()), Some("room-1")).expect("build")["shardKey"],
        json!("room-1")
    );
}

fn rpc_responses() {
    let document = fixture("rpc.json");

    for case in document["responseOk"].as_array().expect("responseOk") {
        let name = case["name"].as_str().unwrap_or("?");
        let value = parse_rpc_response(&case["response"], 200).expect("parse");

        assert_eq!(
            canonical(&encode_wire(&value).expect("encode")),
            canonical(&case["response"]["result"]),
            "{name}"
        );
    }

    for case in document["responseError"].as_array().expect("responseError") {
        let name = case["name"].as_str().unwrap_or("?");

        match parse_rpc_response(&case["response"], 400) {
            Err(ClientError::Api(error)) => {
                assert_eq!(error.code, case["code"].as_str().unwrap(), "{name}");
                assert_eq!(error.message, case["message"].as_str().unwrap(), "{name}");
            }
            other => panic!("expected an ApiError for {name}, got {other:?}"),
        }
    }
}

fn non_2xx_without_error_envelope_fails() {
    // protocol/README.md §4.2. Without the status check this returned a null
    // result and no error — the caller believes its mutation committed.
    let Err(ClientError::Api(error)) = parse_rpc_response(&json!({ "message": "bad gateway" }), 502) else {
        panic!("a non-2xx with no error envelope must fail");
    };

    // The CODE is unchanged, per §4.2. What is new is the flag beside it: this
    // body never came from a Lunora function, so nothing reached the shard and a
    // lone queued write must not be dropped for being alone.
    assert_eq!(error.code, "INTERNAL");
    assert!(error.transient, "an envelope-less non-2xx reached no verdict");
    assert!(is_transient(&ClientError::Api(error)));

    // A coded 5xx is likewise the shard failing UNDER the call, while the same
    // envelope at 4xx is the function's own answer and terminal.
    let coded = |status| match parse_rpc_response(&json!({ "error": { "code": "BAD_REQUEST", "message": "no" } }), status) {
        Err(ClientError::Api(error)) => error.transient,
        other => panic!("expected an ApiError, got {other:?}"),
    };

    assert!(coded(503));
    assert!(!coded(400));
}

fn client_frame_builders() {
    let document = fixture("ws-frames.json");
    let frames = &document["clientFrames"];
    let args = WireValue::Object(vec![("channel".into(), WireValue::String("general".into()))]);

    assert_eq!(canonical(&build_connect_frame(Some("client-test"), None)), canonical(&frames["connect"]));
    assert_eq!(
        canonical(&build_connect_frame(Some("client-test"), Some(&json!({ "roomId": "general" })))),
        canonical(&frames["connect-with-context"])
    );
    assert_eq!(
        canonical(&build_subscribe_frame("sub_1", "messages:list", &args, None, None, None).expect("build")),
        canonical(&frames["subscribe-cold"])
    );
    assert_eq!(
        canonical(&build_subscribe_frame("sub_1", "messages:list", &args, None, Some(&json!(12)), Some(&json!("e1"))).expect("build")),
        canonical(&frames["subscribe-resume"])
    );
    assert_eq!(canonical(&build_unsubscribe_frame("sub_1")), canonical(&frames["unsubscribe"]));
}

fn server_frame_consumer() {
    let document = fixture("ws-frames.json");

    for case in document["serverFrames"].as_array().expect("serverFrames") {
        let name = case["name"].as_str().unwrap_or("?");
        let mut client = Client::new("https://app.example", None);

        client.attach_socket(Box::new(|_frame| {}));

        // `Arc<Mutex<_>>` rather than `Rc<RefCell<_>>`: the handler aliases are
        // `Send`, which is what makes `Client` itself `Send` and shareable — see
        // `concurrent_subscribe_and_handle_frame`.
        let seen: Arc<Mutex<Vec<WireValue>>> = Arc::new(Mutex::new(Vec::new()));
        let errors = Arc::new(Mutex::new(Vec::new()));
        let seen_handle = Arc::clone(&seen);
        let errors_handle = Arc::clone(&errors);

        client.subscribe(
            "messages:list",
            WireValue::Object(vec![("channel".into(), WireValue::String("general".into()))]),
            Some(Box::new(move |value| seen_handle.lock().expect("seen").push(value.clone()))),
            Some(Box::new(move |error| errors_handle.lock().expect("errors").push(error.clone()))),
        );

        let kind = client.handle_frame(&case["frame"].to_string()).expect("handle");
        let expect = &case["expect"];

        assert_eq!(kind.as_deref(), expect["kind"].as_str(), "{name}");

        if let Some(value_wire) = expect.get("valueWire") {
            let seen = seen.lock().expect("seen");

            assert_eq!(seen.len(), 1, "onData should fire once for {name}");
            assert_eq!(canonical(&encode_wire(&seen[0]).expect("encode")), canonical(value_wire), "{name}");
        }

        if expect["kind"] == json!("error") {
            let errors = errors.lock().expect("errors");

            assert_eq!(errors.len(), 1, "{name}");
            assert_eq!(errors[0].code.as_deref(), expect["code"].as_str(), "{name}");
        }
    }

    a_refused_payload_stays_on_its_own_subscription();
}

/// A `data` payload the codec refuses reaches THAT subscription's error callback
/// and nothing else.
///
/// Returning it out of `handle_frame` ended the caller's socket read loop — and
/// with it every OTHER subscription on the client — over one bad frame.
fn a_refused_payload_stays_on_its_own_subscription() {
    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}));

    let errors: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&errors);
    let seen: Arc<Mutex<Vec<WireValue>>> = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&seen);

    let first = client.subscribe(
        "messages:list",
        WireValue::Object(Vec::new()),
        None,
        Some(Box::new(move |error| recorder.lock().expect("errors").push(error.code.clone()))),
    );
    let second = client.subscribe(
        "messages:count",
        WireValue::Object(Vec::new()),
        Some(Box::new(move |value| observer.lock().expect("seen").push(value.clone()))),
        None,
    );

    // A bigint tag whose payload is not a number: inside the codec's vocabulary,
    // outside its grammar.
    let refused = format!(r#"{{"cursor":1,"data":["{TAG}","bigint","not-a-number"],"id":"{first}","type":"data"}}"#);
    let kind = client.handle_frame(&refused).expect("a refused payload must not fail handle_frame");

    assert_eq!(kind.as_deref(), Some("error"), "it is reported as an error frame");
    assert_eq!(
        *errors.lock().expect("errors"),
        vec![Some(CODE_INVALID_FRAME.to_string())],
        "on the addressed subscription's own error callback"
    );

    // The read loop survived, so every other subscription still delivers.
    client
        .handle_frame(&format!(r#"{{"cursor":2,"data":7,"id":"{second}","type":"data"}}"#))
        .expect("the next good frame still lands");

    assert_eq!(*seen.lock().expect("seen"), vec![WireValue::Number(7.0)]);
}

/// The channel form of a live query: same subscription, same decode, same order
/// as the callback form.
fn subscription_stream_yields_frame_values_in_order() {
    let document = fixture("ws-frames.json");
    let case = &document["stream"];
    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}));

    let (events, id) = client.stream(
        "messages:list",
        WireValue::Object(vec![("channel".into(), WireValue::String("general".into()))]),
        None,
    );
    let mut seen = Vec::new();

    for frame in case["frames"].as_array().expect("frames") {
        client.handle_frame(&frame.to_string()).expect("handle");

        match events.recv().expect("a streamed event") {
            StreamEvent::Value(value) => seen.push(encode_wire(&value).expect("encode")),
            StreamEvent::Error(error) => panic!("stream error: {}", error.message),
        }
    }

    // Unsubscribing drops the sender, which is what ends the iteration — a
    // consumer that only drops its receiver leaves the subscription open.
    client.unsubscribe(&id);

    assert_eq!(canonical(&json!(seen)), canonical(&case["yielded"]));
    assert!(events.recv().is_err(), "the stream ends once the subscription is dropped");
}

fn shape_subscribe_frame() {
    let document = fixture("ws-frames.json");
    let args = WireValue::Object(vec![("room".into(), WireValue::String("general".into()))]);
    let frame = build_shape_subscribe_frame("shape_1", "roomMessages", Some(&args), None, None).expect("build");

    assert_eq!(canonical(&frame), canonical(&document["shape"]["shape-subscribe-cold"]));
}

/// A reconnect re-subscribes BOTH registries.
///
/// A resend that walked only the queries left every `subscribe_shape` view
/// subscribed to a socket that no longer exists — silently, and for the rest of
/// the process's life.
fn shape_subscriptions_resend_after_reconnect() {
    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}));
    client.subscribe(
        "messages:list",
        WireValue::Object(vec![("channel".into(), WireValue::String("general".into()))]),
        None,
        None,
    );
    client.subscribe_shape(
        "roomMessages",
        Some(WireValue::Object(vec![("room".into(), WireValue::String("general".into()))])),
        None,
        None,
    );

    // The cursors a resume carries are written by the frame handler, so they have
    // to exist before the resend is built.
    client
        .handle_frame(r#"{"cursor":9,"data":[],"epoch":"e1","id":"sub_1","type":"data"}"#)
        .expect("data frame");
    client
        .handle_frame(r#"{"epoch":"e1","pokeId":"poke-1","type":"pokeStart"}"#)
        .expect("poke start");
    client
        .handle_frame(r#"{"pokeId":"poke-1","reset":true,"rowsPatch":[],"shapeId":"shape_1","type":"pokePart"}"#)
        .expect("poke part");
    client
        .handle_frame(r#"{"checkpoint":5,"epoch":"e1","pokeId":"poke-1","type":"pokeEnd"}"#)
        .expect("poke end");

    let resent: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&resent);

    client.attach_socket(Box::new(move |frame| recorder.lock().expect("resent").push(frame.clone())));
    client.resend_subscriptions().expect("resend");

    let frames = resent.lock().expect("resent");
    let kinds: Vec<&str> = frames.iter().map(|frame| frame["type"].as_str().unwrap_or_default()).collect();

    assert_eq!(kinds, vec!["subscribe", "shape_subscribe"], "both registries, queries first");
    assert_eq!(frames[0]["query"]["sinceSeq"], json!(9), "the query resumes from its tracked cursor");
    assert_eq!(frames[1]["id"], json!("shape_1"));
    assert_eq!(frames[1]["shape"]["name"], json!("roomMessages"));
    assert_eq!(frames[1]["shape"]["args"], json!({ "room": "general" }));
    assert_eq!(frames[1]["sinceCheckpoint"], json!(5), "and the shape from its tracked checkpoint");
    assert_eq!(frames[1]["sinceEpoch"], json!("e1"));
}

fn poke_sequence_materialises_rows() {
    let document = fixture("ws-frames.json");
    let sequence = document["shape"]["pokeSequence"].as_array().expect("pokeSequence");

    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}));

    let delivered: Arc<Mutex<Vec<Vec<WireValue>>>> = Arc::new(Mutex::new(Vec::new()));
    let handle = Arc::clone(&delivered);

    client.subscribe_shape(
        "roomMessages",
        Some(WireValue::Object(vec![("room".into(), WireValue::String("general".into()))])),
        Some(Box::new(move |rows| handle.lock().expect("delivered").push(rows.to_vec()))),
        None,
    );

    for frame in sequence {
        client.handle_frame(&frame.to_string()).expect("handle");
    }

    let delivered = delivered.lock().expect("delivered");

    assert_eq!(delivered.len(), 1, "a poke applies atomically at pokeEnd");

    let rows = WireValue::Array(delivered[0].clone());

    assert_eq!(canonical(&encode_wire(&rows).expect("encode")), canonical(&document["shape"]["expectedRows"]));
}

fn poke_parts_do_not_apply_before_poke_end() {
    let document = fixture("ws-frames.json");
    let sequence = document["shape"]["pokeSequence"].as_array().expect("pokeSequence");

    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}));

    let fired = Arc::new(Mutex::new(0));
    let handle = Arc::clone(&fired);

    client.subscribe_shape("roomMessages", None, Some(Box::new(move |_rows| *handle.lock().expect("fired") += 1)), None);

    for frame in &sequence[..sequence.len() - 1] {
        client.handle_frame(&frame.to_string()).expect("handle");
    }

    assert_eq!(*fired.lock().expect("fired"), 0, "the view would be torn if parts applied before pokeEnd");
}

/// Drives `shape.resetPokeSequence` on top of the cold-subscribe view: a part
/// flagged `reset: true` carries the shape's whole membership, so `m1` — present
/// in `expectedRows`, absent from the re-seed, and never deleted by an op — must
/// be gone. Merging the seed instead keeps it forever, which is what every
/// disconnect of a `.global()` shape (they full-reseed on every reconnect) used
/// to leave behind.
///
/// Dispatched from the shared manifest now that all eight ports assert it, so
/// a future port cannot go green without it.
fn reset_poke_replaces_the_view() {
    let document = fixture("ws-frames.json");
    let sequence = document["shape"]["pokeSequence"].as_array().expect("pokeSequence");
    let reset_sequence = document["shape"]["resetPokeSequence"].as_array().expect("resetPokeSequence");

    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}));

    let delivered: Arc<Mutex<Vec<Vec<WireValue>>>> = Arc::new(Mutex::new(Vec::new()));
    let handle = Arc::clone(&delivered);

    client.subscribe_shape(
        "roomMessages",
        Some(WireValue::Object(vec![("room".into(), WireValue::String("general".into()))])),
        Some(Box::new(move |rows| handle.lock().expect("delivered").push(rows.to_vec()))),
        None,
    );

    for frame in sequence.iter().chain(reset_sequence) {
        client.handle_frame(&frame.to_string()).expect("handle");
    }

    let delivered = delivered.lock().expect("delivered");

    assert_eq!(delivered.len(), 2, "one delivery per poke");

    // The re-seed applies to the view the first poke left behind, so this only
    // passes if it CLEARED that view rather than merging onto it.
    let seeded = WireValue::Array(delivered[0].clone());
    let after_reset = WireValue::Array(delivered[1].clone());

    assert_eq!(canonical(&encode_wire(&seeded).expect("encode")), canonical(&document["shape"]["expectedRows"]));
    assert_eq!(
        canonical(&encode_wire(&after_reset).expect("encode")),
        canonical(&document["shape"]["resetExpectedRows"])
    );
}

/// A buffer is only released at its `pokeEnd`. A socket that drops mid-poke never
/// sends one, so its buffer would be retained for the life of the client — one
/// leak per reconnect, and unbounded against a peer that opens pokes it never
/// closes. Asserted black-box: an evicted poke behaves exactly like one that was
/// never opened, which is the only form of this the eight ports can share.
fn pending_poke_buffers_are_bounded() {
    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}));

    let delivered: Arc<Mutex<Vec<Vec<WireValue>>>> = Arc::new(Mutex::new(Vec::new()));
    let handle = Arc::clone(&delivered);

    client.subscribe_shape(
        "roomMessages",
        Some(WireValue::Object(vec![("room".into(), WireValue::String("general".into()))])),
        Some(Box::new(move |rows| handle.lock().expect("delivered").push(rows.to_vec()))),
        None,
    );

    // A poke opened, part-filled, then abandoned when the socket dropped.
    client
        .handle_frame(&json!({ "type": "pokeStart", "pokeId": "stale" }).to_string())
        .expect("pokeStart");
    client
        .handle_frame(
            &json!({
                "type": "pokePart",
                "pokeId": "stale",
                "shapeId": "shape_1",
                "rowsPatch": [{ "op": "insert", "key": "ghost", "value": "ghost-row" }],
            })
            .to_string(),
        )
        .expect("pokePart");

    for index in 0..MAX_PENDING_POKES {
        client
            .handle_frame(&json!({ "type": "pokeStart", "pokeId": format!("filler-{index}") }).to_string())
            .expect("pokeStart");
    }

    // The abandoned buffer is gone, so its late pokeEnd is a no-op.
    client
        .handle_frame(&json!({ "type": "pokeEnd", "pokeId": "stale" }).to_string())
        .expect("pokeEnd");

    assert!(
        delivered.lock().expect("delivered").is_empty(),
        "the ghost row of an evicted poke must never reach the view"
    );

    // ...and eviction is oldest-first, not a blanket drop: a live poke still applies.
    let newest = format!("filler-{}", MAX_PENDING_POKES - 1);

    client
        .handle_frame(
            &json!({
                "type": "pokePart",
                "pokeId": newest,
                "shapeId": "shape_1",
                "rowsPatch": [{ "op": "insert", "key": "m1", "value": "kept" }],
            })
            .to_string(),
        )
        .expect("pokePart");
    client
        .handle_frame(&json!({ "type": "pokeEnd", "pokeId": newest }).to_string())
        .expect("pokeEnd");

    let delivered = delivered.lock().expect("delivered");

    assert_eq!(delivered.len(), 1, "the newest buffer must survive and apply");
    assert_eq!(delivered[0], vec![WireValue::String("kept".into())]);
}

/// The topology every real consumer has: a socket read loop on one thread and
/// application code subscribing on others.
///
/// Rust reaches this differently from the sibling ports. They hold an internal
/// lock because nothing stops two threads entering the client at once; here every
/// mutating method takes `&mut self`, so that is a COMPILE error and sharing goes
/// through the caller's `Arc<Mutex<Client>>`. What this asserts is that the
/// arrangement is actually available — `Client` has to be `Send` for it, and it
/// was not until the injected callbacks gained that bound.
///
/// The assertion is the surviving subscription COUNT, as in the Go, Swift, Java
/// and Kotlin suites: a lost `next_id += 1` silently forgets a live subscription.
/// It cannot be lost here, and that is the point — the test is a standing witness
/// that nothing has been added to `Client` (an interior-mutability field, a
/// `static`, an `unsafe` cell) that would make the compiler stop enforcing it.
#[test]
fn concurrent_subscribe_and_handle_frame() {
    const THREADS: usize = 4;
    const PER_THREAD: usize = 250;

    let client = Arc::new(Mutex::new(Client::new("https://app.example", None)));

    client.lock().expect("client").attach_socket(Box::new(|_frame| {}));

    let workers: Vec<_> = (0..THREADS)
        .map(|_| {
            let shared = Arc::clone(&client);

            thread::spawn(move || {
                for _ in 0..PER_THREAD {
                    shared
                        .lock()
                        .expect("client")
                        .subscribe("messages:list", WireValue::Object(Vec::new()), Some(Box::new(|_value| {})), None);
                }
            })
        })
        .collect();

    let reader = {
        let shared = Arc::clone(&client);

        thread::spawn(move || {
            for cursor in 0..THREADS * PER_THREAD {
                let frame = format!(r#"{{"type":"data","id":"sub_1","data":1,"cursor":{cursor}}}"#);

                shared.lock().expect("client").handle_frame(&frame).expect("handle");
            }
        })
    };

    for worker in workers {
        worker.join().expect("worker");
    }

    reader.join().expect("reader");

    // Attached only now, so the count below sees resend frames alone.
    let resent = Arc::new(Mutex::new(0_usize));
    let counter = Arc::clone(&resent);
    let mut guard = client.lock().expect("client");

    guard.attach_socket(Box::new(move |_frame| *counter.lock().expect("resent") += 1));
    guard.resend_subscriptions().expect("resend");

    assert_eq!(
        *resent.lock().expect("resent"),
        THREADS * PER_THREAD,
        "every concurrent subscribe survived with a distinct id"
    );
}

/// `from_model_json` must drop a null ONLY where the generated call site says the
/// schema made the property optional.
///
/// Not in the shared manifest: it asserts how a GENERATED MODEL reaches the wire,
/// which is this port's own concern rather than a frame every SDK must agree on.
/// The pairing it protects is the one no blanket rule can get right — an unset
/// `v.optional()` must be an absent key, a required `v.nullable()` must be a
/// present null.
#[test]
fn from_model_json_prunes_only_optional_paths() {
    let model = json!({
        "id": "r1",
        "limit": Value::Null,
        "nickname": Value::Null,
        "tags": { "a": Value::Null },
        "rows": [{ "note": Value::Null, "tag": Value::Null }],
    });

    let wire = from_model_json(&model, &[&["limit"][..], &["rows", "*", "tag"][..]]);
    let encoded = encode_wire(&wire).expect("encode");

    // The optional field is gone; the required nullable is present holding null.
    assert_eq!(encoded["nickname"], Value::Null);
    assert!(encoded.get("limit").is_none(), "an unset optional must be an absent key");

    // A null inside a RECORD is a value the caller chose, and no path lists it.
    assert_eq!(encoded["tags"]["a"], Value::Null);

    // Inside an array element, the starred path prunes and the sibling survives.
    assert!(encoded["rows"][0].get("tag").is_none(), "a starred optional path prunes inside an array");
    assert_eq!(encoded["rows"][0]["note"], Value::Null);
}

/// An empty path list must change nothing — the shape a function with no optional
/// arguments generates.
#[test]
fn from_model_json_with_no_paths_keeps_every_null() {
    let model = json!({ "id": "r1", "nickname": Value::Null });
    let encoded = encode_wire(&from_model_json(&model, &[])).expect("encode");

    assert_eq!(encoded["nickname"], Value::Null);
    assert_eq!(encoded["id"], json!("r1"));
}

/// A path must match a run of keys, not a key anywhere: `["a"]` is not `["b","a"]`.
#[test]
fn from_model_json_matches_whole_paths() {
    let model = json!({ "outer": { "limit": Value::Null }, "limit": Value::Null });
    let encoded = encode_wire(&from_model_json(&model, &[&["limit"][..]])).expect("encode");

    assert!(encoded.get("limit").is_none(), "the top-level path prunes");
    assert_eq!(encoded["outer"]["limit"], Value::Null, "the same key one level down is a different path");
}
