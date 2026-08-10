//! Runs a generated call, rather than only compiling one.
//!
//! `cargo build` proves the shapes line up. It does not prove a call reaches the
//! wire: Java shipped a surface that compiled and threw on the first invocation,
//! and Ruby one whose every method raised NoMethodError, both with the
//! compile-or-parse gate green.
//!
//! Lives in `tests/` rather than `src/`, which `lunora sdk generate` overwrites.

use std::cell::RefCell;
use std::rc::Rc;

use lunora::client::Client;
use lunora::key::stable_stringify;
use lunora_generated_check::api::Api;
use lunora_generated_check::models::MessagesListArgs;

#[test]
fn generated_call_reaches_the_wire() {
    let captured: Rc<RefCell<Option<Vec<u8>>>> = Rc::new(RefCell::new(None));
    let sink = Rc::clone(&captured);

    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, _headers, body: &[u8]| {
            *sink.borrow_mut() = Some(body.to_vec());

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

    let body = captured.borrow().clone().expect("the poster was never called");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("captured body is not JSON");

    assert_eq!(
        stable_stringify(&parsed),
        r#"{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}"#
    );
}
