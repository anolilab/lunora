//! A fake Caddy for the black-box tests (see `common.rs` for how it is run).
//! It answers `version`; `run --config` serves the admin API on the config's
//! `admin.listen`, records each `POST /load` body to `caddy-loads.jsonl`
//! (refused while the `reject-load` flag file exists), and exits on SIGTERM.

#[path = "common.rs"]
mod common;

use common::{address_of, append_line, flag_value, invocation, respond, runtime, serve};

fn main() {
    let run = invocation("caddy.jsonl");

    if run.args.first().map(String::as_str) == Some("version") {
        println!("{}", run.version);

        return;
    }

    let config_path = flag_value(&run.args, "--config").expect("caddy run --config");
    let config: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(config_path).expect("Caddy's config")).expect("Caddy's config is JSON");
    let listen = config["admin"]["listen"].as_str().expect("admin.listen").to_owned();
    let records = run.records;

    runtime().block_on(async move {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("a SIGTERM handler");
        let origin = format!("http://{listen}");

        tokio::spawn(serve(address_of(&listen), move |request| {
            let header = |name: &str| request.headers.get(name).and_then(|value| value.to_str().ok());

            // As Caddy does: a request with Sec-Fetch-Mode (a browser's) must carry the admin origin.
            if header("sec-fetch-mode").is_some() && header("origin") != Some(origin.as_str()) {
                let named = header("origin").unwrap_or_default();

                return respond(403, serde_json::json!({ "error": format!("client is not allowed to access from origin '{named}'") }).to_string());
            }

            if request.method == "POST" && request.path == "/load" {
                if records.join("reject-load").exists() {
                    return respond(400, "loading new config: http.handlers.nope: unknown module");
                }

                append_line(&records.join("caddy-loads.jsonl"), &String::from_utf8_lossy(&request.body).replace('\n', ""));

                return respond(200, "");
            }

            respond(404, "")
        }));

        terminate.recv().await;
    });
}
