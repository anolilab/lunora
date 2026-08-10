//! Protocol-conformance tests: drive the Rust SDK against the shared golden
//! fixtures in `protocol/fixtures/`, the same files the TypeScript client and
//! the Python, Go, Ruby and Swift ports are tested against.

use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;

use lunora::client::{
    build_connect_frame, build_rpc_body, build_shape_subscribe_frame, build_subscribe_frame, build_unsubscribe_frame, parse_rpc_response, Client, ClientError,
};
use lunora::key::{stable_stringify, stable_wire_key};
use lunora::wire::{decode_wire, encode_wire, WireValue, MAX_BIGINT_DIGITS, MAX_DEPTH, TAG};
use serde_json::{json, Value};

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

#[test]
fn wire_codec_round_trip() {
    let document = fixture("wire-codec.json");
    let cases = document["cases"].as_array().expect("cases");

    assert!(cases.len() > 10, "fixture should carry the full case set");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let encoded = &case["encoded"];
        let round_tripped = encode_wire(&decode_wire(encoded).expect("decode")).expect("encode");

        assert_eq!(canonical(&round_tripped), canonical(encoded), "round-trip mismatch for {name}");
    }
}

#[test]
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

#[test]
fn over_long_bigint_rejected() {
    let over_long = "9".repeat(MAX_BIGINT_DIGITS + 1);

    assert!(decode_wire(&json!([TAG, "bigint", over_long])).is_err());
    assert!(decode_wire(&json!([TAG, "bigint", "12x4"])).is_err());
    assert_eq!(decode_wire(&json!([TAG, "bigint", "-42"])).expect("decode"), WireValue::BigInt("-42".into()));
}

#[test]
fn depth_cap_enforced() {
    let mut nested = json!("leaf");

    for _ in 0..(MAX_DEPTH + 2) {
        nested = json!([nested]);
    }

    assert!(decode_wire(&nested).is_err());
}

#[test]
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
#[test]
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
    ] {
        assert_eq!(stable_stringify(&json!(value)), want, "formatting {value}");
    }
}

/// JavaScript sorts by UTF-16 code unit, so an astral character is its high
/// surrogate (0xD83D) and sorts after U+2028 but before U+FFFD. Rust's UTF-8
/// byte-wise `Ord` puts it last — a different dedup key for identical args.
#[test]
fn key_order_matches_utf16() {
    let rendered = stable_stringify(&json!({ "A": 1, "\u{2028}": 2, "\u{1F600}": 3, "\u{FFFD}": 4 }));

    assert_eq!(rendered, "{\"A\":1,\"\u{2028}\":2,\"\u{1F600}\":3,\"\u{FFFD}\":4}");
}

#[test]
fn string_escaping_matches_json_stringify() {
    // JSON.stringify leaves <, > and & raw and does not escape U+2028/U+2029.
    assert_eq!(stable_stringify(&json!("a<b>&c")), "\"a<b>&c\"");
    assert_eq!(stable_stringify(&json!("\u{2028}\u{2029}")), "\"\u{2028}\u{2029}\"");
    assert_eq!(stable_stringify(&json!("tab\there")), "\"tab\\there\"");
}

#[test]
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

#[test]
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

#[test]
fn non_2xx_without_error_envelope_fails() {
    // protocol/README.md §4.2. Without the status check this returned a null
    // result and no error — the caller believes its mutation committed.
    assert!(parse_rpc_response(&json!({ "message": "bad gateway" }), 502).is_err());
}

#[test]
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

#[test]
fn server_frame_consumer() {
    let document = fixture("ws-frames.json");

    for case in document["serverFrames"].as_array().expect("serverFrames") {
        let name = case["name"].as_str().unwrap_or("?");
        let mut client = Client::new("https://app.example", None);

        client.attach_socket(Box::new(|_frame| {}));

        let seen: Rc<RefCell<Vec<WireValue>>> = Rc::new(RefCell::new(Vec::new()));
        let errors = Rc::new(RefCell::new(Vec::new()));
        let seen_handle = Rc::clone(&seen);
        let errors_handle = Rc::clone(&errors);

        client.subscribe(
            "messages:list",
            WireValue::Object(vec![("channel".into(), WireValue::String("general".into()))]),
            Some(Box::new(move |value| seen_handle.borrow_mut().push(value.clone()))),
            Some(Box::new(move |error| errors_handle.borrow_mut().push(error.clone()))),
        );

        let kind = client.handle_frame(&case["frame"].to_string()).expect("handle");
        let expect = &case["expect"];

        assert_eq!(kind.as_deref(), expect["kind"].as_str(), "{name}");

        if let Some(value_wire) = expect.get("valueWire") {
            assert_eq!(seen.borrow().len(), 1, "onData should fire once for {name}");
            assert_eq!(canonical(&encode_wire(&seen.borrow()[0]).expect("encode")), canonical(value_wire), "{name}");
        }

        if expect["kind"] == json!("error") {
            assert_eq!(errors.borrow().len(), 1, "{name}");
            assert_eq!(errors.borrow()[0].code.as_deref(), expect["code"].as_str(), "{name}");
        }
    }
}

#[test]
fn shape_subscribe_frame() {
    let document = fixture("ws-frames.json");
    let args = WireValue::Object(vec![("room".into(), WireValue::String("general".into()))]);
    let frame = build_shape_subscribe_frame("shape_1", "roomMessages", Some(&args), None, None).expect("build");

    assert_eq!(canonical(&frame), canonical(&document["shape"]["shape-subscribe-cold"]));
}

#[test]
fn poke_sequence_materialises_rows() {
    let document = fixture("ws-frames.json");
    let sequence = document["shape"]["pokeSequence"].as_array().expect("pokeSequence");

    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}));

    let delivered: Rc<RefCell<Vec<Vec<WireValue>>>> = Rc::new(RefCell::new(Vec::new()));
    let handle = Rc::clone(&delivered);

    client.subscribe_shape(
        "roomMessages",
        Some(WireValue::Object(vec![("room".into(), WireValue::String("general".into()))])),
        Some(Box::new(move |rows| handle.borrow_mut().push(rows.to_vec()))),
        None,
    );

    for frame in sequence {
        client.handle_frame(&frame.to_string()).expect("handle");
    }

    assert_eq!(delivered.borrow().len(), 1, "a poke applies atomically at pokeEnd");

    let rows = WireValue::Array(delivered.borrow()[0].clone());

    assert_eq!(canonical(&encode_wire(&rows).expect("encode")), canonical(&document["shape"]["expectedRows"]));
}

#[test]
fn poke_parts_do_not_apply_before_poke_end() {
    let document = fixture("ws-frames.json");
    let sequence = document["shape"]["pokeSequence"].as_array().expect("pokeSequence");

    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}));

    let fired = Rc::new(RefCell::new(0));
    let handle = Rc::clone(&fired);

    client.subscribe_shape("roomMessages", None, Some(Box::new(move |_rows| *handle.borrow_mut() += 1)), None);

    for frame in &sequence[..sequence.len() - 1] {
        client.handle_frame(&frame.to_string()).expect("handle");
    }

    assert_eq!(*fired.borrow(), 0, "the view would be torn if parts applied before pokeEnd");
}
