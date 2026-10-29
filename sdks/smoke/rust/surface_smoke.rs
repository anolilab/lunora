//! Calls every function of the `sdk-surface` spec through a generated SDK.
//!
//! `generated_smoke.rs` proves a call reaches the wire. This proves the surface
//! handles every SHAPE a model backend renders differently: a no-arg function,
//! id / number / array / record / null results, a nullable object, an array of
//! objects, a union, an unset optional, bigint arguments and results (top level
//! and nested), and keyword-named functions — `match` and `type` take the `r#`
//! raw form, `self` cannot and becomes `self_`, and none of them may leak into
//! a `subscribe_…` name.
//!
//! Run by `sdks/generated-check.sh rust` from a consumer crate outside this repo.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use lunora::client::Client;
use lunora::key::stable_stringify;
use lunora::wire::WireValue;
use lunora_api::api::Api;
use lunora_api::models::{Choice, ChoiceKind, ItemsCreateArgs, ItemsFindArgs, ItemsMatchArgs, ItemsPageResultKind, ItemsPickArgs, ItemsPickResult};

const BIG_FIVE: &str = r#"["$lunora.wire$","bigint","5"]"#;

fn object(entries: Vec<(&str, WireValue)>) -> WireValue {
    WireValue::Object(entries.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

#[test]
fn surface_shapes_reach_the_wire_and_decode() {
    let frames: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let reply: Arc<Mutex<String>> = Arc::new(Mutex::new("null".to_owned()));
    let (sink, source) = (Arc::clone(&frames), Arc::clone(&reply));

    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, _headers, body: &[u8]| {
            let parsed: serde_json::Value = serde_json::from_slice(body).expect("captured body is not JSON");
            sink.lock().expect("frames").push(stable_stringify(&parsed));
            Ok((200, format!(r#"{{"result":{}}}"#, source.lock().expect("reply")).into_bytes()))
        })),
    );
    let mut api = Api::new(&mut client);
    let set = |value: &str| *reply.lock().expect("reply") = value.to_owned();

    set("2");
    assert_eq!(api.items().count(&HashMap::new(), None).expect("count"), 2.0);
    set(r#"{"size":2,"title":"t"}"#);
    let summary = api.items().summary(&HashMap::new(), None).expect("summary");
    assert!(summary.size == 2.0 && summary.title == "t");
    set(r#"{"title":"t","value":"x"}"#);
    let detail = api.items().detail(&HashMap::new(), None).expect("detail");
    assert!(detail.title == "t" && matches!(detail.value, ItemsPickResult::PurpleString(ref value) if value == "x"));
    set(r#""items_1""#);
    let created = api.items().create(
        &ItemsCreateArgs {
            note: None,
            title: "t".to_owned(),
        },
        None,
    );
    assert_eq!(created.expect("create"), "items_1");
    set("null");
    assert_eq!(api.items().clear(&HashMap::new(), None).expect("clear"), None);
    set(r#"["a"]"#);
    assert_eq!(api.items().tags(&HashMap::new(), None).expect("tags"), vec!["a".to_owned()]);
    set(r#"["b"]"#);
    assert_eq!(api.items().labels(&HashMap::new(), None).expect("labels"), vec!["b".to_owned()]);
    set(r#"{"a":1}"#);
    assert_eq!(api.items().stats(&HashMap::new(), None).expect("stats"), HashMap::from([("a".to_owned(), 1.0)]));
    set(r#"{"b":2}"#);
    assert_eq!(
        api.items().totals(&HashMap::new(), None).expect("totals"),
        HashMap::from([("b".to_owned(), 2.0)])
    );
    set("null");
    let found = api.items().find(&ItemsFindArgs { id: "items_1".to_owned() }, None);
    assert_eq!(found.expect("find"), WireValue::Null);
    set(r#"[{"kind":"a","title":"t"}]"#);
    let page = api.items().page(&HashMap::new(), None).expect("page");
    assert!(page.len() == 1 && page[0].title == "t" && matches!(page[0].kind, ItemsPageResultKind::A));
    set(r#""x""#);
    let choice = Choice {
        a: Some(1.0),
        b: None,
        kind: ChoiceKind::X,
    };
    let picked = api.items().pick(&ItemsPickArgs { choice }, None).expect("pick");
    assert!(matches!(picked, ItemsPickResult::PurpleString(ref value) if value == "x"));
    set("1");
    assert_eq!(api.items().r#match(&ItemsMatchArgs { pattern: "p".to_owned() }, None).expect("match"), 1.0);
    assert_eq!(api.items().r#type(&HashMap::new(), None).expect("type"), 1.0);
    assert_eq!(api.items().self_(&HashMap::new(), None).expect("self"), 1.0);

    let five = || WireValue::BigInt("5".to_owned());
    set(BIG_FIVE);
    assert_eq!(api.ledger().charge(&object(vec![("amount", five())]), None).expect("charge"), five());
    set(&format!(r#"{{"rows":[{{"amount":{BIG_FIVE}}}],"total":{BIG_FIVE}}}"#));
    let accounts = object(vec![(
        "accounts",
        WireValue::Array(vec![object(vec![("id", WireValue::String("acc".to_owned())), ("limit", five())])]),
    )]);
    let balances = api.ledger().balances(&accounts, None).expect("balances");
    assert_eq!(
        balances,
        object(vec![("rows", WireValue::Array(vec![object(vec![("amount", five())])])), ("total", five())])
    );

    let want = vec![
        r#"{"args":{},"functionPath":"items:count"}"#.to_owned(),
        r#"{"args":{},"functionPath":"items:summary"}"#.to_owned(),
        r#"{"args":{},"functionPath":"items:detail"}"#.to_owned(),
        r#"{"args":{"title":"t"},"functionPath":"items:create"}"#.to_owned(),
        r#"{"args":{},"functionPath":"items:clear"}"#.to_owned(),
        r#"{"args":{},"functionPath":"items:tags"}"#.to_owned(),
        r#"{"args":{},"functionPath":"items:labels"}"#.to_owned(),
        r#"{"args":{},"functionPath":"items:stats"}"#.to_owned(),
        r#"{"args":{},"functionPath":"items:totals"}"#.to_owned(),
        r#"{"args":{"id":"items_1"},"functionPath":"items:find"}"#.to_owned(),
        r#"{"args":{},"functionPath":"items:page"}"#.to_owned(),
        r#"{"args":{"choice":{"a":1,"kind":"x"}},"functionPath":"items:pick"}"#.to_owned(),
        r#"{"args":{"pattern":"p"},"functionPath":"items:match"}"#.to_owned(),
        r#"{"args":{},"functionPath":"items:type"}"#.to_owned(),
        r#"{"args":{},"functionPath":"items:self"}"#.to_owned(),
        format!(r#"{{"args":{{"amount":{BIG_FIVE}}},"functionPath":"ledger:charge"}}"#),
        format!(r#"{{"args":{{"accounts":[{{"id":"acc","limit":{BIG_FIVE}}}]}},"functionPath":"ledger:balances"}}"#),
    ];

    assert_eq!(*frames.lock().expect("frames"), want);
}
