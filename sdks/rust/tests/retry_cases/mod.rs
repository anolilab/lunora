//! The subscription retry hint, against `subscriptionRetry` in `protocol/fixtures/ws-frames.json`.
//!
//! Plain functions, dispatched from `conformance.rs` and wrapped in `#[test]` there. Not
//! manifest cases yet: `conformance-cases.json` only lists behaviour every port has.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use lunora::client::{Client, FrameSender};
use lunora::wire::WireValue;
use serde_json::{json, Value};

use crate::{fixture, wire_text};

type Sent = Arc<Mutex<Vec<Value>>>;
type Codes = Arc<Mutex<Vec<Option<String>>>>;

fn retry_fixture() -> Value {
    fixture("ws-frames.json")["subscriptionRetry"].clone()
}

/// A sender that records every frame, in order.
fn recording_sender(sent: &Sent) -> FrameSender {
    let outbound = Arc::clone(sent);

    Box::new(move |frame| outbound.lock().expect("sent").push(frame.clone()))
}

fn take(sent: &Sent) -> Vec<Value> {
    std::mem::take(&mut *sent.lock().expect("sent"))
}

fn subscribes(frames: &[Value]) -> Vec<Value> {
    frames.iter().filter(|frame| frame["type"] == json!("subscribe")).cloned().collect()
}

/// An attached client holding one `messages:list` subscription that has received the seed frame.
/// Returns the client, what it sent, the error codes its handler saw, and the subscription id.
fn open() -> (Client, Sent, Codes, String) {
    let retry = retry_fixture();
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));
    let codes: Codes = Arc::new(Mutex::new(Vec::new()));

    let mut client = Client::new("https://app.example", None);
    client.client_id = "client-test".to_string();
    client.attach_socket(recording_sender(&sent), None);

    let args = WireValue::Object(vec![("channel".into(), WireValue::String("general".into()))]);
    let recorded = Arc::clone(&codes);
    let id = client.subscribe(
        "messages:list",
        args,
        None,
        Some(Box::new(move |error| recorded.lock().expect("codes").push(error.code.clone()))),
    );

    client.handle_frame(&wire_text(&retry["seedFrame"])).expect("seed frame");
    take(&sent);

    (client, sent, codes, id)
}

pub fn re_subscribes_once_cold_at_the_hint() {
    let retry = retry_fixture();
    let (mut client, sent, _codes, _id) = open();

    let t0 = Instant::now();
    client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");
    let t1 = Instant::now();
    let d = client.next_subscription_retry_at().expect("a retry is pending");

    assert!(
        t0 + Duration::from_secs(5) <= d && d <= t1 + Duration::from_secs(5),
        "deadline is the hint from now"
    );
    assert_eq!(client.retry_due_subscriptions(d - Duration::from_millis(1)).expect("not yet due"), 0);
    assert!(take(&sent).is_empty(), "nothing is sent before the hint has elapsed");

    assert_eq!(client.retry_due_subscriptions(d).expect("due"), 1);
    assert_eq!(take(&sent), vec![retry["retryFrame"].clone()]);

    assert_eq!(client.retry_due_subscriptions(d + Duration::from_secs(60)).expect("fired once"), 0);
    assert!(client.next_subscription_retry_at().is_none());
}

pub fn the_error_still_reaches_the_handler() {
    let retry = retry_fixture();
    let (mut client, _sent, codes, _id) = open();

    client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");

    assert_eq!(*codes.lock().expect("codes"), vec![Some("SUBSCRIPTION_REFRESH_FAILED".to_string())]);
}

pub fn a_later_hint_replaces_the_pending_one() {
    let retry = retry_fixture();
    let (mut client, sent, _codes, _id) = open();

    client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");
    let d1 = client.next_subscription_retry_at().expect("first deadline");
    client.handle_frame(&wire_text(&retry["laterHintFrame"])).expect("later hint frame");
    let d2 = client.next_subscription_retry_at().expect("replaced deadline");

    assert!(d2 > d1, "the later hint is the longer one");
    assert_eq!(
        client.retry_due_subscriptions(d1).expect("earlier deadline"),
        0,
        "the earlier deadline was replaced"
    );
    assert_eq!(client.retry_due_subscriptions(d2).expect("later deadline"), 1);
    assert_eq!(take(&sent), vec![retry["retryFrame"].clone()]);
}

pub fn each_cancel_frame_cancels() {
    let retry = retry_fixture();

    for case in retry["cancelFrames"].as_array().expect("cancel frames") {
        let (mut client, sent, _codes, _id) = open();
        client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");

        client.handle_frame(&wire_text(&case["frame"])).expect("cancel frame");

        assert!(client.next_subscription_retry_at().is_none(), "{} cancels the retry", case["name"]);
        assert_eq!(client.retry_due_subscriptions(Instant::now() + Duration::from_secs(3600)).expect("far"), 0);
        assert!(subscribes(&take(&sent)).is_empty(), "{} sends no subscribe", case["name"]);
    }
}

pub fn no_retry_frames_schedule_nothing() {
    let retry = retry_fixture();

    for case in retry["noRetryFrames"].as_array().expect("no-retry frames") {
        let (mut client, sent, _codes, _id) = open();

        client.handle_frame(&wire_text(&case["frame"])).expect("error frame");

        assert!(client.next_subscription_retry_at().is_none(), "{} schedules nothing", case["name"]);
        assert_eq!(client.retry_due_subscriptions(Instant::now() + Duration::from_secs(3600)).expect("far"), 0);
        assert!(subscribes(&take(&sent)).is_empty(), "{} sends no subscribe", case["name"]);
    }
}

pub fn unsubscribe_cancels() {
    let retry = retry_fixture();
    let (mut client, _sent, _codes, id) = open();
    client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");

    client.unsubscribe(&id);

    assert!(client.next_subscription_retry_at().is_none());
}

pub fn detach_cancels() {
    let retry = retry_fixture();
    let (mut client, _sent, _codes, _id) = open();
    client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");

    client.detach_socket(None, None);

    assert!(client.next_subscription_retry_at().is_none());
}

pub fn attach_cancels() {
    let retry = retry_fixture();
    let (mut client, _sent, _codes, _id) = open();
    client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");
    let second: Sent = Arc::new(Mutex::new(Vec::new()));

    client.attach_socket(recording_sender(&second), None);

    assert!(client.next_subscription_retry_at().is_none());
    assert_eq!(client.retry_due_subscriptions(Instant::now() + Duration::from_secs(3600)).expect("far"), 0);
    assert!(subscribes(&take(&second)).is_empty());
}

pub fn close_cancels() {
    let retry = retry_fixture();
    let (mut client, _sent, _codes, _id) = open();
    client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");

    client.close();

    assert!(client.next_subscription_retry_at().is_none());
}

pub fn a_shape_error_never_schedules() {
    let (mut client, _sent, _codes, _id) = open();
    let shape_id = client.subscribe_shape("messages", None, None, None);
    let shape_error = json!({
        "id": shape_id,
        "type": "error",
        "error": { "code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed", "retryAfterMs": 5000 }
    });

    client.handle_frame(&wire_text(&shape_error)).expect("shape error frame");

    assert!(client.next_subscription_retry_at().is_none());
}

pub fn the_hint_is_clamped() {
    let mut frame = retry_fixture()["hintFrame"].clone();
    frame["error"]["retryAfterMs"] = json!(3_600_000);
    let (mut client, _sent, _codes, _id) = open();

    client.handle_frame(&wire_text(&frame)).expect("hint frame");
    let t1 = Instant::now();
    let d = client.next_subscription_retry_at().expect("a retry is pending");

    assert!(d <= t1 + Duration::from_secs(60), "the server's hint is clamped to the 60s ceiling");
}

pub fn a_data_frame_that_cannot_be_applied_keeps_the_retry() {
    let retry = retry_fixture();
    let (mut client, _sent, _codes, id) = open();

    client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");

    let refused = format!(
        r#"{{"cursor":13,"data":["{}","bigint","not-a-number"],"id":"{id}","type":"data"}}"#,
        lunora::wire::TAG
    );
    client.handle_frame(&refused).expect("a refused payload must not fail handle_frame");

    assert!(client.next_subscription_retry_at().is_some(), "a frame that was not applied answers nothing");
}

pub fn a_cold_retry_forgets_the_confirmed_cursor() {
    let retry = retry_fixture();
    let (mut client, _sent, _codes, id) = open();

    client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");
    let d = client.next_subscription_retry_at().expect("a retry is pending");
    client.retry_due_subscriptions(d).expect("due");

    assert_eq!(client.subscription_state(&id).expect("registered").server_cursor, None);
}

pub fn a_slow_error_handler_does_not_push_the_retry_later() {
    let retry = retry_fixture();
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));
    let mut client = Client::new("https://app.example", None);
    client.attach_socket(recording_sender(&sent), None);

    let args = WireValue::Object(vec![("channel".into(), WireValue::String("general".into()))]);
    client.subscribe(
        "messages:list",
        args,
        None,
        Some(Box::new(|_error| std::thread::sleep(Duration::from_millis(200)))),
    );
    client.handle_frame(&wire_text(&retry["seedFrame"])).expect("seed frame");

    let t0 = Instant::now();
    client.handle_frame(&wire_text(&retry["hintFrame"])).expect("hint frame");
    let d = client.next_subscription_retry_at().expect("a retry is pending");

    assert!(d < t0 + Duration::from_secs(5) + Duration::from_millis(200), "the hint counts from arrival");
}
