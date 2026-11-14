//! Runs a generated call, rather than only compiling one.
//!
//! `cargo build` proves the shapes line up. It does not prove a call reaches the
//! wire: Java shipped a surface that compiled and threw on the first invocation,
//! and Ruby one whose every method raised NoMethodError, both with the
//! compile-or-parse gate green. A third — Rust — sent `"limit": null` for an unset
//! optional, which `v.optional()` rejects, and only a call could see it.
//!
//! `sdks/generated-check.sh rust` copies this into `tests/` of a throwaway
//! consumer crate that depends on the generated SDK by path, the way a real
//! consumer does. The crate is `lunora_api` — the generated one — and `lunora` is
//! the transport vendored beneath it, not this repo's.

use std::sync::{Arc, Mutex};

use lunora::client::{Client, WatchEvent};
use lunora::key::stable_stringify;
use lunora::wire::encode_wire;
use lunora_api::api::Api;
use lunora_api::models::MessagesListArgs;
use serde_json::json;

#[test]
fn generated_call_reaches_the_wire() {
    let captured: Arc<Mutex<Option<Vec<u8>>>> = Arc::new(Mutex::new(None));
    let sink = Arc::clone(&captured);

    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, _headers, body: &[u8]| {
            *sink.lock().expect("captured") = Some(body.to_vec());

            Ok((200, br#"{"result":{"ok":true}}"#.to_vec()))
        })),
    );

    Api::new(&mut client)
        .messages()
        .list(
            &MessagesListArgs {
                channel_id: "chan_1".to_owned(),
                limit: None,
            },
            None,
        )
        .expect("generated call");

    let body = captured.lock().expect("captured").clone().expect("the poster was never called");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("captured body is not JSON");

    assert_eq!(stable_stringify(&parsed), r#"{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}"#);
}

fn frame_of_type(frames: &[serde_json::Value], kind: &str) -> serde_json::Value {
    let found: Vec<&serde_json::Value> = frames.iter().filter(|frame| frame["type"] == kind).collect();

    assert_eq!(found.len(), 1, "sent {} {kind} frames, want exactly one", found.len());

    found[0].clone()
}

/// The generated watch member reaches the primitive with the right function path. The
/// subscribe frame is sent at call time, the first data frame is decoded through the
/// receiver, and unsubscribing sends the unsubscribe for the same id.
#[test]
fn generated_watch_reaches_the_primitive() {
    let frames: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&frames);

    let mut client = Client::new("https://app.example", None);
    client.attach_socket(
        Box::new(move |frame: &serde_json::Value| sink.lock().expect("frames").push(frame.clone())),
        None,
    );

    let (events, id) = Api::new(&mut client)
        .messages()
        .watch_list(
            &MessagesListArgs {
                channel_id: "chan_1".to_owned(),
                limit: None,
            },
            None,
        )
        .expect("generated watch");

    let sent = frames.lock().expect("frames").clone();
    let subscribe = frame_of_type(&sent, "subscribe");

    assert_eq!(subscribe["id"].as_str(), Some(id.as_str()));
    assert_eq!(subscribe["query"]["functionPath"], "messages:list");
    assert_eq!(stable_stringify(&subscribe["query"]["args"]), r#"{"channelId":"chan_1"}"#);

    client
        .handle_frame(&json!({ "cursor": 1, "data": { "ok": true }, "id": id, "type": "data" }).to_string())
        .expect("data frame");

    match events.recv().expect("the watch yielded a value") {
        WatchEvent::Value(value) => assert_eq!(encode_wire(&value).expect("encode"), json!({ "ok": true })),
        WatchEvent::Error(error) => panic!("watch delivered an error: {}", error.message),
    }

    client.unsubscribe(&id);

    let sent = frames.lock().expect("frames").clone();
    let unsubscribe = frame_of_type(&sent, "unsubscribe");

    assert_eq!(unsubscribe["id"].as_str(), Some(id.as_str()));
}
