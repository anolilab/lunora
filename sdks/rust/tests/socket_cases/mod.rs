//! The socket session and whisper cases, against `protocol/fixtures/ws-frames.json`.
//!
//! Plain functions, dispatched from the manifest arms in `conformance.rs` and
//! wrapped in `#[test]` there, so each runs on its own and under the manifest.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use lunora::client::{build_connect_frame, build_whisper_frame, build_whisper_subscribe_frame, build_whisper_unsubscribe_frame, Client, FrameSender};
use lunora::wire::{encode_wire, from_json, WireValue};
use serde_json::{json, Value};

use crate::{canonical, fixture, wire_text};

/// The session credential the goldens carry as `token`.
const SESSION: &str = "session-token";

/// The RPC bearer. It must never reach `connect` or a URL.
const BEARER: &str = "bearer-secret";

/// Whether `url` carries `credential`. `ws_url` percent-encodes its values, so a
/// leak shows up with each hyphen spelled `%2D`; a raw-only check would pass.
fn carries(url: &str, credential: &str) -> bool {
    url.contains(credential) || url.contains(&credential.replace('-', "%2D"))
}

/// A sender that records every frame, in order.
fn recording_sender(sent: &Arc<Mutex<Vec<Value>>>) -> FrameSender {
    let outbound = Arc::clone(sent);

    Box::new(move |frame| outbound.lock().expect("sent").push(frame.clone()))
}

fn take(sent: &Arc<Mutex<Vec<Value>>>) -> Vec<Value> {
    std::mem::take(&mut *sent.lock().expect("sent"))
}

/// Connect is the first frame of every open, and subscriptions follow it. The
/// session credential rides `connect.token` only; the RPC bearer rides nothing.
pub fn connect_frame_first_and_carries_session_token() {
    let document = fixture("ws-frames.json");
    let frames = &document["clientFrames"];
    let args = WireValue::Object(vec![("channel".into(), WireValue::String("general".into()))]);

    let sent = Arc::new(Mutex::new(Vec::new()));
    let mut client = Client::new("https://app.example", None);

    client.client_id = "client-test".to_string();
    client.set_auth_token(Some(BEARER.to_string()));
    client.subscribe("messages:list", args, None, None);
    client.set_session_token(Some(SESSION.to_string()));
    client.attach_socket(recording_sender(&sent), None);
    client.resend_subscriptions().expect("resend");

    let opened = take(&sent);

    assert_eq!(opened[0]["type"], json!("connect"), "connect is the first frame");
    assert_eq!(opened[1]["type"], json!("subscribe"), "the subscription follows connect");
    assert_eq!(
        canonical(&opened[0]),
        canonical(&frames["connect-with-token"]),
        "connect carries the session token"
    );
    assert!(!wire_text(&opened[0]).contains(BEARER), "the RPC bearer never reaches connect");
    let url = client.ws_url(Some("tenant_a"), None);

    assert!(
        !carries(&url, SESSION) && !carries(&url, BEARER),
        "no credential rides the URL after attach: {url}"
    );

    let mut bare = Client::new("https://app.example", None);

    bare.client_id = "client-test".to_string();
    bare.attach_socket(recording_sender(&sent), None);

    let unauthenticated = take(&sent);

    assert!(unauthenticated[0].get("token").is_none(), "no session credential means no token key");
    assert_eq!(canonical(&unauthenticated[0]), canonical(&frames["connect"]));

    assert_eq!(
        canonical(&build_connect_frame(Some("client-test"), Some(&json!({ "roomId": "general" })), Some(SESSION))),
        canonical(&frames["connect-with-token-and-context"]),
        "the builder matches the token-and-context golden"
    );
}

/// The socket URL carries the admin ticket and nothing else.
pub fn ws_url_carries_only_the_admin_ticket() {
    let mut client = Client::new("https://app.example", None);

    client.set_auth_token(Some(BEARER.to_string()));
    client.set_session_token(Some(SESSION.to_string()));

    let url = client.ws_url(Some("tenant_a"), Some("ticket-abc"));

    assert_eq!(url.matches("token=").count(), 1, "exactly one token parameter in {url}");
    assert!(url.ends_with("&token=ticket%2Dabc"), "the ticket is the token, hyphen encoded: {url}");
    assert!(!carries(&url, SESSION) && !carries(&url, BEARER), "no credential rides the URL: {url}");
    assert!(!client.ws_url(None, None).contains("token="), "no ticket means no token parameter");
}

/// A connection context rides `connect` when given, and is omitted otherwise.
pub fn attach_socket_carries_connection_context() {
    let document = fixture("ws-frames.json");
    let frames = &document["clientFrames"];
    let context = json!({ "roomId": "general" });
    let sent = Arc::new(Mutex::new(Vec::new()));

    let mut with_context = Client::new("https://app.example", None);

    with_context.client_id = "client-test".to_string();
    with_context.attach_socket(recording_sender(&sent), Some(&context));

    assert_eq!(canonical(&take(&sent)[0]), canonical(&frames["connect-with-context"]));

    let mut without_context = Client::new("https://app.example", None);

    without_context.client_id = "client-test".to_string();
    without_context.attach_socket(recording_sender(&sent), None);

    let connect = take(&sent)[0].clone();

    assert!(connect.get("context").is_none(), "no context means no context key");
    assert_eq!(canonical(&connect), canonical(&frames["connect"]));
}

/// Every close sequence in the fixture, driven through this port's own calls.
pub fn close_codes_drive_token_expiry() {
    let document = fixture("ws-frames.json");
    let cases = document["closeSequences"]["cases"].as_array().expect("closeSequences.cases");

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let mut client = Client::new("https://app.example", None);
        let expired = Arc::new(AtomicUsize::new(0));
        let errors = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&expired);

        client.on_token_expired(Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));

        let subscription_errors = Arc::clone(&errors);
        let id = client.subscribe(
            "messages:list",
            WireValue::Object(Vec::new()),
            None,
            Some(Box::new(move |_error| {
                subscription_errors.fetch_add(1, Ordering::SeqCst);
            })),
        );

        assert_eq!(id, "sub_1", "{name}: the case registers sub_1");

        let mut credentials = 0;

        for step in case["steps"].as_array().expect("steps") {
            if step.get("attach") == Some(&json!(true)) {
                client.attach_socket(Box::new(|_frame| {}), None);
            } else if let Some(close) = step.get("close") {
                let code = u16::try_from(close["code"].as_u64().expect("close code")).expect("close code fits u16");

                client.detach_socket(Some(code), close["reason"].as_str());
            } else if let Some(frame) = step.get("frame") {
                client
                    .handle_frame(&frame.to_string())
                    .unwrap_or_else(|error| panic!("{name}: frame failed: {error}"));
            } else if step.get("credentialChange") == Some(&json!(true)) {
                credentials += 1;
                client.set_session_token(Some(format!("rotated-{credentials}")));
            } else {
                panic!("{name}: unknown step {step}");
            }
        }

        assert_eq!(
            expired.load(Ordering::SeqCst),
            case["tokenExpiredNotifications"].as_u64().expect("tokenExpiredNotifications") as usize,
            "{name}: tokenExpiredNotifications"
        );

        if let Some(expected) = case.get("subscriptionErrors") {
            assert_eq!(
                errors.load(Ordering::SeqCst),
                expected.as_u64().expect("subscriptionErrors") as usize,
                "{name}: subscriptionErrors"
            );
        }
    }
}

/// The whisper frame builders match the goldens, and a delivered frame reaches
/// only its own topic's listeners.
pub fn whisper_frames_join_send_and_deliver() {
    let document = fixture("ws-frames.json");
    let frames = &document["clientFrames"];
    let whisper = &document["whisperFrames"];

    assert_eq!(
        canonical(&build_whisper_subscribe_frame("room:general")),
        canonical(&frames["whisper-subscribe"])
    );
    assert_eq!(
        canonical(&build_whisper_unsubscribe_frame("room:general")),
        canonical(&frames["whisper-unsubscribe"])
    );

    let data = from_json(&frames["whisper-send"]["data"]);

    assert_eq!(
        canonical(&build_whisper_frame("room:general", &data).expect("whisper encodes")),
        canonical(&frames["whisper-send"])
    );

    for case in whisper["serverFrames"].as_array().expect("serverFrames") {
        let name = case["name"].as_str().expect("case name");
        let mut client = Client::new("https://app.example", None);
        let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));

        // Only `room:general` is joined. A frame on any other topic has no listener,
        // which is what `other_topic_not_delivered` pins.
        let recorder = Arc::clone(&seen);

        client.whisper_subscribe(
            "room:general",
            Box::new(move |value: &WireValue| {
                let encoded = encode_wire(value).expect("a delivered value encodes");

                recorder.lock().expect("seen").push(json!({ "topic": "room:general", "value": encoded }));
            }),
        );

        client
            .handle_frame(&case["frame"].to_string())
            .unwrap_or_else(|error| panic!("{name}: frame failed: {error}"));

        let delivered = Value::Array(seen.lock().expect("seen").clone());

        assert_eq!(canonical(&delivered), canonical(&case["delivered"]), "{name}");
    }
}

/// Each open rejoins every registered topic straight after `connect`.
/// A closed client forgets its room registrations, so an attach after close joins no topic.
pub fn closed_client_does_not_rejoin_rooms() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let mut client = Client::new("https://app.example", None);

    client.client_id = "client-test".to_string();
    let _listener = client.whisper_subscribe("room:general", Box::new(|_value: &WireValue| {}));
    client.close();
    client.attach_socket(recording_sender(&sent), None);

    let frames = take(&sent);

    assert_eq!(frames.len(), 1, "after close, the attach writes connect and no join");
    assert_eq!(frames[0]["type"], json!("connect"));
}

pub fn whisper_topics_rejoin_after_reconnect() {
    let document = fixture("ws-frames.json");
    let rejoin = document["whisperFrames"]["rejoinOnReconnect"].as_array().expect("rejoinOnReconnect");
    let sent = Arc::new(Mutex::new(Vec::new()));
    let mut client = Client::new("https://app.example", None);

    client.client_id = "client-test".to_string();
    let listener = client.whisper_subscribe("room:general", Box::new(|_value: &WireValue| {}));

    for open in 0..2 {
        client.attach_socket(recording_sender(&sent), None);

        let frames = take(&sent);

        assert_eq!(frames.len(), 1 + rejoin.len(), "open {open}: connect plus one join per topic");
        assert_eq!(frames[0]["type"], json!("connect"), "open {open}: connect first");

        for (index, topic) in rejoin.iter().enumerate() {
            assert_eq!(
                canonical(&frames[index + 1]),
                canonical(&build_whisper_subscribe_frame(topic.as_str().expect("topic"))),
                "open {open}"
            );
        }

        client.detach_socket(None, None);
    }

    // Detached, a whisper is refused rather than queued for the next open.
    assert!(!client.whisper("room:general", &WireValue::Null), "a detached client queues no whisper");

    // Removing the last listener on a topic sends one whisper_unsubscribe when attached.
    client.attach_socket(recording_sender(&sent), None);
    take(&sent);
    client.whisper_unsubscribe(listener);

    let left = take(&sent);

    assert_eq!(left.len(), 1, "the last listener's removal sends one frame");
    assert_eq!(canonical(&left[0]), canonical(&build_whisper_unsubscribe_frame("room:general")));
}
