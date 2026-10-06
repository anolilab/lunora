//! A fake `celld` for the black-box tests (see `common.rs` for how it is run).
//! It answers `--version`, `deploy` (reads `wrangler.json`, prints celld's
//! JSON version line; fails while the `fail-deploy` flag file exists) and
//! `diagnose`. Run as a node, it serves the health route on `--listen`, logs a
//! WARN line on stderr and app output on stdout, and on SIGTERM drains and
//! exits, unless the `ignore-sigterm` flag file exists.

#[path = "common.rs"]
mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use common::{address_of, flag_value, invocation, respond, runtime, serve};

fn main() {
    let run = invocation("celld.jsonl");
    let args = &run.args;

    match args.first().map(String::as_str) {
        Some("--version") => println!("{}", run.version),
        Some("deploy") => {
            if run.records.join("fail-deploy").exists() {
                eprintln!("error: the bucket refused the upload");
                std::process::exit(1);
            }

            let directory = args.get(1).expect("deploy names the release directory");
            let config: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(std::path::Path::new(directory).join("wrangler.json")).expect("a wrangler.json"))
                    .expect("wrangler.json is JSON");
            let name = config["name"].as_str().unwrap_or_default();

            println!("Bundled {name} (0.00 sec)");
            println!("{}", serde_json::json!({ "dry_run": false, "version": "v-test-1", "worker": name }));
        }
        Some("diagnose") => {
            println!("{}", serde_json::json!({ "check": "bucket s3://test", "detail": "", "verdict": "ok" }));
            println!("{}", serde_json::json!({ "check": "bucket conditional write", "detail": "create", "verdict": "ok" }));
        }
        _ => node(&run),
    }
}

fn node(run: &common::Invocation) {
    let listen = flag_value(&run.args, "--listen").expect("a node is started with --listen").to_owned();
    let bucket = flag_value(&run.args, "--bucket").unwrap_or_default().to_owned();
    let ignore_sigterm = run.records.join("ignore-sigterm");

    runtime().block_on(async move {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("a SIGTERM handler");
        let draining = Arc::new(AtomicBool::new(false));
        let server = {
            let draining = Arc::clone(&draining);

            serve(address_of(&listen), move |request| {
                if request.path == "/.well-known/celld/health" {
                    let ok = !draining.load(Ordering::SeqCst);
                    let mut response = respond(if ok { 200 } else { 503 }, serde_json::json!({ "ok": ok }).to_string());

                    response.headers_mut().insert("content-type", hyper::header::HeaderValue::from_static("application/json"));

                    return response;
                }

                let host = request.headers.get("x-forwarded-host").and_then(|value| value.to_str().ok()).unwrap_or("undefined");

                respond(200, format!("fleet {bucket} host {host}"))
            })
        };

        tokio::spawn(server);
        // What celld's RUST_LOG=error,celld=warn lets through, on stderr; and app output on stdout.
        eprintln!("2026-10-03T00:00:00Z  WARN celld::node: fake node listening on {listen}");
        println!("app console output");

        loop {
            terminate.recv().await;
            draining.store(true, Ordering::SeqCst);

            if !ignore_sigterm.exists() {
                tokio::time::sleep(Duration::from_millis(50)).await;
                std::process::exit(0);
            }
        }
    });
}
