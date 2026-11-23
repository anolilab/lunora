//! A reconnect re-sends its query subscriptions a few at a time, as the reference client does.
//!
//! `RESUBSCRIBE_CONCURRENCY` in `packages/client/src/client-tuning.ts` is the width: a
//! re-sent `subscribe` holds a slot until any frame bearing its id arrives, it is
//! unsubscribed, or `RESUBSCRIBE_ACK_TIMEOUT` passes with no reply. Plain functions,
//! dispatched from `conformance.rs` and wrapped in `#[test]` there. Not manifest cases:
//! `conformance-cases.json` only lists behaviour every port has.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use lunora::client::{Client, FrameSender, RESUBSCRIBE_ACK_TIMEOUT, RESUBSCRIBE_CONCURRENCY};
use lunora::wire::WireValue;
use serde_json::{json, Value};

type Sent = Arc<Mutex<Vec<Value>>>;

const SUBSCRIPTIONS: usize = 7;

fn recording_sender(sent: &Sent) -> FrameSender {
    let outbound = Arc::clone(sent);

    Box::new(move |frame| outbound.lock().expect("sent").push(frame.clone()))
}

/// The ids of every `subscribe` frame sent so far, in order.
fn subscribes(sent: &Sent) -> Vec<String> {
    sent.lock()
        .expect("sent")
        .iter()
        .filter(|frame| frame["type"] == json!("subscribe"))
        .map(|frame| frame["id"].as_str().expect("id").to_string())
        .collect()
}

fn channel(index: usize) -> WireValue {
    WireValue::Object(vec![("channel".into(), WireValue::String(format!("c{index}")))])
}

fn ack(client: &mut Client, id: &str) {
    client.handle_frame(&format!(r#"{{"type":"ack","id":"{id}"}}"#)).expect("ack");
}

/// A client holding `count` query subscriptions, re-attached to a fresh socket and resent.
fn reconnected(count: usize) -> (Client, Sent, Vec<String>) {
    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}), None);

    let ids = (0..count).map(|index| client.subscribe("messages:list", channel(index), None, None)).collect();
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));

    client.attach_socket(recording_sender(&sent), None);
    sent.lock().expect("sent").clear();
    client.resend_subscriptions().expect("resend");

    (client, sent, ids)
}

pub fn only_the_window_goes_out_until_a_reply_arrives() {
    assert_eq!(RESUBSCRIBE_CONCURRENCY, 3, "the reference client's width");

    let (_client, sent, _ids) = reconnected(SUBSCRIPTIONS);

    assert_eq!(subscribes(&sent).len(), RESUBSCRIBE_CONCURRENCY);
}

pub fn any_frame_bearing_the_id_lets_the_next_one_out() {
    let (mut client, sent, _ids) = reconnected(SUBSCRIPTIONS);
    let window = subscribes(&sent);

    ack(&mut client, &window[0]);
    assert_eq!(subscribes(&sent).len(), 4, "an ack frees its slot");

    client
        .handle_frame(&format!(r#"{{"type":"data","id":"{}","data":[],"cursor":1}}"#, window[1]))
        .expect("data");
    assert_eq!(subscribes(&sent).len(), 5, "a data frame that overtakes the ack frees it too");

    client
        .handle_frame(&format!(
            r#"{{"type":"error","id":"{}","error":{{"code":"FORBIDDEN","message":"no"}}}}"#,
            window[2]
        ))
        .expect("error");
    assert_eq!(subscribes(&sent).len(), 6, "so does the error that refuses it");

    ack(&mut client, &window[0]);
    assert_eq!(subscribes(&sent).len(), 6, "a second frame for a released id frees nothing");
}

pub fn every_subscription_goes_out_exactly_once() {
    let (mut client, sent, ids) = reconnected(SUBSCRIPTIONS);
    let mut answered = 0;

    while answered < subscribes(&sent).len() {
        let id = subscribes(&sent)[answered].clone();

        ack(&mut client, &id);
        answered += 1;
    }

    let resent = subscribes(&sent);

    assert_eq!(resent.len(), SUBSCRIPTIONS);
    assert_eq!(resent.into_iter().collect::<HashSet<_>>(), ids.into_iter().collect::<HashSet<_>>());
}

pub fn an_unsubscribe_skips_a_queued_one_and_frees_an_outstanding_one() {
    let (mut client, sent, ids) = reconnected(5);
    let window = subscribes(&sent);
    let queued: Vec<&String> = ids.iter().filter(|id| !window.contains(id)).collect();

    client.unsubscribe(&queued[0].clone());
    assert_eq!(subscribes(&sent).len(), 3, "a queued one is dropped, and frees no slot");

    client.unsubscribe(&window[0]);
    assert_eq!(subscribes(&sent).len(), 4, "an outstanding one will never be answered, so its slot goes on");
    assert!(!subscribes(&sent).contains(queued[0]), "the dropped one never went out");

    ack(&mut client, &window[1]);
    assert_eq!(subscribes(&sent).len(), 4, "nothing is left to send");
}

pub fn an_unanswered_one_stops_holding_its_slot_after_the_timeout() {
    let before = Instant::now();
    let (mut client, sent, _ids) = reconnected(SUBSCRIPTIONS);
    let after = Instant::now();

    let deadline = client.next_subscription_retry_at().expect("a slot deadline is pending");

    assert!(before + RESUBSCRIBE_ACK_TIMEOUT <= deadline && deadline <= after + RESUBSCRIBE_ACK_TIMEOUT);

    assert_eq!(client.retry_due_subscriptions(deadline - Duration::from_millis(1)).expect("not yet due"), 0);
    assert_eq!(subscribes(&sent).len(), 3);

    assert_eq!(
        client.retry_due_subscriptions(after + RESUBSCRIBE_ACK_TIMEOUT).expect("due"),
        RESUBSCRIBE_CONCURRENCY
    );
    assert_eq!(subscribes(&sent).len(), 6);
}

/// A timer that fires late still passes the deadline it was armed for. The slots it claims are
/// dated from when it ran, or they would already be (nearly) expired and the window would pace
/// nothing.
pub fn a_late_timer_dates_the_next_slots_from_when_it_ran() {
    let (mut client, sent, _ids) = reconnected(SUBSCRIPTIONS);
    let deadline = client.next_subscription_retry_at().expect("a slot deadline is pending");
    let late = deadline + Duration::from_secs(5);

    client.clock = Box::new(move || late);

    assert_eq!(client.retry_due_subscriptions(deadline).expect("due"), RESUBSCRIBE_CONCURRENCY);
    assert_eq!(subscribes(&sent).len(), 2 * RESUBSCRIBE_CONCURRENCY);
    assert!(client.next_subscription_retry_at().expect("the new window's deadline") >= late + RESUBSCRIBE_ACK_TIMEOUT);
}

pub fn a_reconnect_mid_drain_starts_a_fresh_window() {
    let (mut client, sent, _ids) = reconnected(SUBSCRIPTIONS);
    let stale = subscribes(&sent);

    client.detach_socket(None, None);
    assert!(client.next_subscription_retry_at().is_none(), "a dropped socket's slots are gone");

    let resent: Sent = Arc::new(Mutex::new(Vec::new()));

    client.attach_socket(recording_sender(&resent), None);
    client.resend_subscriptions().expect("resend");
    assert_eq!(subscribes(&resent).len(), RESUBSCRIBE_CONCURRENCY);

    let fresh = subscribes(&resent);

    ack(&mut client, &fresh[0]);
    assert_eq!(subscribes(&resent).len(), 4);

    // A late answer to the previous socket's frame frees nothing it does not hold.
    if let Some(old) = stale.iter().find(|id| !fresh.contains(id)) {
        ack(&mut client, old);
        assert_eq!(subscribes(&resent).len(), 4);
    }
}

pub fn a_queued_one_carries_the_cursor_it_has_when_it_goes_out() {
    let mut client = Client::new("https://app.example", None);

    client.set_identity(Some("alice".to_string()));
    client.attach_socket(Box::new(|_frame| {}), None);

    for index in 0..4 {
        let id = client.subscribe("messages:list", channel(index), None, None);

        client
            .handle_frame(&format!(r#"{{"type":"data","id":"{id}","data":[],"cursor":9}}"#))
            .expect("data");
    }

    let sent: Sent = Arc::new(Mutex::new(Vec::new()));

    client.attach_socket(recording_sender(&sent), None);
    client.resend_subscriptions().expect("resend");
    client.set_identity(Some("bob".to_string()));

    let window = subscribes(&sent);

    ack(&mut client, &window[0]);

    let late = subscribes(&sent)[3].clone();
    let frame = sent
        .lock()
        .expect("sent")
        .iter()
        .find(|frame| frame["id"] == json!(late))
        .cloned()
        .expect("the queued frame");

    assert!(
        frame["query"].get("sinceSeq").is_none(),
        "the new identity must not resume the old one's position"
    );
}

pub fn shape_subscriptions_are_not_paced() {
    let mut client = Client::new("https://app.example", None);

    client.attach_socket(Box::new(|_frame| {}), None);

    for index in 0..5 {
        client.subscribe_shape("roomMessages", Some(channel(index)), None, None);
    }

    let sent: Sent = Arc::new(Mutex::new(Vec::new()));

    client.attach_socket(recording_sender(&sent), None);
    client.resend_subscriptions().expect("resend");

    let shapes = sent
        .lock()
        .expect("sent")
        .iter()
        .filter(|frame| frame["type"] == json!("shape_subscribe"))
        .count();

    assert_eq!(shapes, 5);
}
