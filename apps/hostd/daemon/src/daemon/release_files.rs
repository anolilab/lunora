//! A stored release on the box (plan 458 D6, W4 `deploy` steps 1–2): download
//! it with a signed request, check its size and shape, and lay it out as a
//! directory `celld deploy` takes — the bundle, the static assets and the
//! Wrangler config [`celld_config_from_release`] derives from its binding manifest.
//!
//! The release is the control plane's `StoredRelease` JSON, byte for byte:
//! `{ bundle (base64), manifest, assets? }`. Everything in it is checked before
//! a byte is written, and no asset path may leave the release directory.

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use base64::alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use serde_json::{Map, Value};

use super::celld_release::{CELLD_RELEASE_ASSETS_DIRECTORY, CELLD_RELEASE_MAIN, CelldReleaseAssetsConfig, CelldReleaseOptions, celld_config_from_release};
use super::config::create_dir_all_with_mode;
use super::job_error::{JobError, codes};
use super::signed_fetch::{SignedFetch, describe_error};
use crate::wire::types::DeployJob;

/// The largest release the box downloads: the control plane's 100 MiB deploy cap, plus JSON and base64 overhead.
pub const MAX_RELEASE_BYTES: usize = 160 * 1024 * 1024;

/// The config file `celld deploy` reads in the release directory.
pub const RELEASE_CONFIG_FILE: &str = "wrangler.json";

const FETCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseAsset {
    /// Base64.
    pub content: String,
    pub path: String,
}

/// The root files celld's asset layer reads as rules, as the release's `assets.config` carries them.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReleaseRulesFiles {
    pub headers: Option<String>,
    pub redirects: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReleaseAssets {
    /// What the celld config takes.
    pub config: Option<CelldReleaseAssetsConfig>,
    pub files: Vec<ReleaseAsset>,
    /// Written as files into the assets directory.
    pub rules: Option<ReleaseRulesFiles>,
}

/// A downloaded release, checked.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredRelease {
    pub assets: Option<ReleaseAssets>,
    /// Base64.
    pub bundle: String,
    /// The binding manifest: an object whose `bindings` are `{binding, type}` records.
    pub manifest: Value,
}

fn invalid(message: &str) -> JobError {
    JobError::new(codes::RELEASE_INVALID, format!("the release {message}"))
}

/// `^[\d+/A-Za-z]*={0,2}$`.
fn is_base64(text: &str) -> bool {
    let data = text.trim_end_matches('=');

    text.len() - data.len() <= 2 && data.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

/// Decoding stops at the padding, a lone trailing character is dropped and stray bits are ignored, as `Buffer.from(…, "base64")` does.
const FORGIVING: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::RequireNone),
);

/// Decode text [`is_base64`] admits, byte for byte as Node does.
fn decode_base64(text: &str) -> Vec<u8> {
    let data = text.trim_end_matches('=');
    let data = if data.len() % 4 == 1 { &data[..data.len() - 1] } else { data };

    FORGIVING.decode(data).unwrap_or_default()
}

/// An asset path: `/` then non-empty segments, none `.` or `..`, no backslash or NUL.
fn is_asset_path(path: &str) -> bool {
    path.strip_prefix('/').is_some_and(|rest| {
        !path.contains('\\') && !path.contains('\0') && rest.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
    })
}

const HTML_HANDLING: [&str; 4] = ["auto-trailing-slash", "drop-trailing-slash", "force-trailing-slash", "none"];

const NOT_FOUND_HANDLING: [&str; 3] = ["404-page", "none", "single-page-application"];

/// Root files the asset layer reads as config. A release carries `_headers` /
/// `_redirects` as `assets.config` strings, never as files, so one among the
/// files is refused rather than left to shadow (or be shadowed by) the config.
const RESERVED_ASSET_PATHS: [&str; 3] = ["/.assetsignore", "/_headers", "/_redirects"];

/// `_headers` / `_redirects` from the release's asset config, each a string or absent.
fn pick_rules_files(config: &Map<String, Value>) -> Result<ReleaseRulesFiles, JobError> {
    let pick = |name: &str| match config.get(name) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(invalid(&format!("assets.config.{name} is not a string"))),
    };

    Ok(ReleaseRulesFiles { headers: pick("_headers")?, redirects: pick("_redirects")? })
}

/// Only the three serving options the deploy request carries, each checked —
/// anything else (a `directory`, say) never reaches the celld config.
fn pick_assets_config(config: &Map<String, Value>) -> CelldReleaseAssetsConfig {
    let one_of = |key: &str, allowed: &[&str]| config.get(key).and_then(Value::as_str).filter(|value| allowed.contains(value)).map(str::to_owned);
    let run_worker_first =
        config.get("run_worker_first").filter(|value| value.is_boolean() || value.as_array().is_some_and(|patterns| patterns.iter().all(Value::is_string)));

    CelldReleaseAssetsConfig {
        html_handling: one_of("html_handling", &HTML_HANDLING),
        not_found_handling: one_of("not_found_handling", &NOT_FOUND_HANDLING),
        run_worker_first: run_worker_first.cloned(),
    }
}

/// `JSON.stringify(path.slice(0, 200))`, the cut on a character boundary.
fn quoted_prefix(path: &str) -> String {
    let mut units = 0;
    let prefix: String = path
        .chars()
        .take_while(|character| {
            units += character.len_utf16();

            units <= 200
        })
        .collect();

    serde_json::to_string(&prefix).unwrap_or_default()
}

/// The `assets` of a stored release, checked: every path safe, every content base64.
fn parse_assets(source: &Value) -> Result<ReleaseAssets, JobError> {
    let record = source.as_object();
    let files = record.and_then(|record| record.get("files")).and_then(Value::as_array);
    let files: Option<Vec<ReleaseAsset>> = files.and_then(|files| {
        files
            .iter()
            .map(|file| {
                let file = file.as_object()?;

                Some(ReleaseAsset { content: file.get("content")?.as_str()?.to_owned(), path: file.get("path")?.as_str()?.to_owned() })
            })
            .collect()
    });
    let Some(files) = files else {
        return Err(invalid("assets.files is not a list of {path, content}"));
    };

    for file in &files {
        if !is_asset_path(&file.path) || !is_base64(&file.content) {
            return Err(invalid(&format!("asset {} has an unsafe path or non-base64 content", quoted_prefix(&file.path))));
        }

        if RESERVED_ASSET_PATHS.contains(&file.path.as_str()) {
            return Err(invalid(&format!("asset {} is a config file, not a served one", file.path)));
        }
    }

    let config = record.and_then(|record| record.get("config")).and_then(Value::as_object);
    let rules = config.map(pick_rules_files).transpose()?.filter(|rules| rules.headers.is_some() || rules.redirects.is_some());

    Ok(ReleaseAssets { config: config.map(pick_assets_config), files, rules })
}

/// Check the shape of a release's JSON. Only what the box uses is read; unknown fields are ignored.
pub fn parse_release(raw: &Value) -> Result<StoredRelease, JobError> {
    let record = raw.as_object();
    let (Some(Value::String(bundle)), Some(manifest @ Value::Object(fields))) =
        (record.and_then(|record| record.get("bundle")), record.and_then(|record| record.get("manifest")))
    else {
        return Err(invalid("is not a stored release ({bundle, manifest, assets?})"));
    };

    if bundle.is_empty() || !is_base64(bundle) {
        return Err(invalid("bundle is not base64"));
    }

    let bindings_ok = fields.get("bindings").and_then(Value::as_array).is_some_and(|bindings| {
        bindings.iter().all(|entry| entry.get("binding").is_some_and(Value::is_string) && entry.get("type").is_some_and(Value::is_string))
    });

    if !bindings_ok {
        return Err(invalid("manifest.bindings is not a list of {binding, type}"));
    }

    Ok(StoredRelease {
        assets: record.and_then(|record| record.get("assets")).map(parse_assets).transpose()?,
        bundle: bundle.clone(),
        manifest: manifest.clone(),
    })
}

/// Read a response body, refusing one over `max_bytes` before it is all in memory.
async fn read_capped(mut response: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, JobError> {
    // `Number(header ?? "0")`: a header that is not a number refuses nothing here.
    let declared = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.trim().parse::<f64>().ok())
        .unwrap_or(0.0);

    #[allow(clippy::cast_precision_loss)]
    if declared > max_bytes as f64 {
        return Err(invalid(&format!("is {declared} bytes, over the {max_bytes}-byte cap")));
    }

    let mut bytes = Vec::new();

    while let Some(chunk) = response.chunk().await.map_err(|error| JobError::new(codes::JOB_FAILED, describe_error(&error)))? {
        if bytes.len() + chunk.len() > max_bytes {
            return Err(invalid(&format!("is over the {max_bytes}-byte cap")));
        }

        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

async fn fetch_capped(signed: &SignedFetch, release_url: &str, max_bytes: usize) -> Result<(usize, StoredRelease), JobError> {
    let response = signed.get(release_url, FETCH_TIMEOUT).await.map_err(|error| {
        if error.code == codes::ORIGIN_REFUSED {
            error
        } else {
            JobError::new(codes::FETCH_FAILED, format!("could not download the release: {}", error.message))
        }
    })?;

    if response.status() != 200 {
        return Err(JobError::new(codes::FETCH_FAILED, format!("the control plane answered {} for the release", response.status().as_u16())));
    }

    let bytes = read_capped(response, max_bytes).await?;
    // `TextDecoder` then `JSON.parse`: invalid UTF-8 decodes to U+FFFD, a leading BOM is dropped.
    let text = String::from_utf8_lossy(&bytes);
    let Ok(raw) = serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text)) else {
        return Err(invalid("is not JSON"));
    };

    Ok((bytes.len(), parse_release(&raw)?))
}

/// Download and check the release a deploy job names: its size in bytes, and the release.
/// `FETCH_FAILED` when the control plane does not serve it, `RELEASE_INVALID` when it is malformed or too large.
pub async fn fetch_release(signed: &SignedFetch, release_url: &str) -> Result<(usize, StoredRelease), JobError> {
    fetch_capped(signed, release_url, MAX_RELEASE_BYTES).await
}

/// `path.resolve(base, relative)`: absolute, with every `.` and `..` resolved lexically.
fn resolve(base: &Path, relative: &str) -> PathBuf {
    let mut resolved = if base.is_absolute() { PathBuf::new() } else { std::env::current_dir().unwrap_or_default() };

    for component in base.components().chain(Path::new(relative).components()) {
        match component {
            Component::RootDir => resolved = PathBuf::from("/"),
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(segment) => resolved.push(segment),
            Component::CurDir | Component::Prefix(_) => {}
        }
    }

    resolved
}

/// Create `path` with `mode` (masked by the umask) and write `contents`.
fn write_file(path: &Path, contents: &[u8], mode: u32) -> std::io::Result<()> {
    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(path)?.write_all(contents)
}

/// `rm -rf`: a missing path is not an error.
fn remove_all(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Lay `release` out in `directory` (replacing anything there): the bundle as
/// `worker.js`, the assets under `assets/` with its `_headers` / `_redirects`
/// at that root, and the celld config, which it returns.
/// `RELEASE_INVALID` when the release cannot run on celld.
pub fn write_release_directory(directory: &Path, release: &StoredRelease, job: &DeployJob) -> Result<Value, JobError> {
    let options = CelldReleaseOptions {
        alias: job.alias.clone(),
        assets_config: release.assets.as_ref().and_then(|assets| assets.config.clone()),
        compatibility_date: job.compatibility_date.clone(),
        compatibility_flags: None,
        crons: job.crons.clone(),
        has_assets: release.assets.is_some(),
        vars: job.vars.clone(),
    };
    let config = celld_config_from_release(&release.manifest, &options).map_err(|error| JobError::new(codes::RELEASE_INVALID, error.message))?;

    remove_all(directory)?;
    create_dir_all_with_mode(directory, 0o750)?;
    write_file(&directory.join(CELLD_RELEASE_MAIN), &decode_base64(&release.bundle), 0o640)?;

    let assets_root = resolve(directory, CELLD_RELEASE_ASSETS_DIRECTORY);
    let files = release.assets.as_ref().map_or(&[][..], |assets| &assets.files);

    for file in files {
        let target = resolve(&assets_root, &format!(".{}", file.path));

        // Checked again on the resolved path: belt and braces over `is_asset_path`.
        if target == assets_root || !target.starts_with(&assets_root) {
            return Err(invalid(&format!("asset {} resolves outside the release", serde_json::to_string(&file.path).unwrap_or_default())));
        }

        if let Some(parent) = target.parent() {
            create_dir_all_with_mode(parent, 0o750)?;
        }

        write_file(&target, &decode_base64(&file.content), 0o640)?;
    }

    // celld refuses an assets directory it cannot find, even an empty one.
    if release.assets.is_some() {
        create_dir_all_with_mode(&assets_root, 0o750)?;
    }

    // celld reads `_headers` / `_redirects` at the assets root as Cloudflare's
    // asset layer does (custom headers, redirects) and never serves them.
    if let Some(rules) = release.assets.as_ref().and_then(|assets| assets.rules.as_ref()) {
        for (name, content) in [("_headers", &rules.headers), ("_redirects", &rules.redirects)] {
            if let Some(content) = content {
                write_file(&assets_root.join(name), content.as_bytes(), 0o640)?;
            }
        }
    }

    // `JSON.stringify(config, undefined, 4)`. Mode 0600: the vars carry the app's secrets (plan 458 D10).
    let mut contents = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut contents, serde_json::ser::PrettyFormatter::with_indent(b"    "));

    serde::Serialize::serialize(&config, &mut serializer).map_err(|error| JobError::new(codes::JOB_FAILED, error.to_string()))?;
    contents.push(b'\n');
    write_file(&directory.join(RELEASE_CONFIG_FILE), &contents, 0o600)?;

    Ok(config)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use indexmap::IndexMap;
    use serde_json::json;

    use super::super::signed_fetch::test_server::{TestServer, respond, serve};
    use super::*;
    use crate::daemon::http::no_redirect_client;
    use crate::daemon::identity::generate_identity;

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    fn stored_release() -> Value {
        json!({
            "assets": {
                "config": {
                    "_headers": "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n",
                    "_redirects": "/old /new 301\n",
                    "directory": "/etc",
                    "not_found_handling": "single-page-application"
                },
                "files": [
                    { "content": b64("<h1>hi</h1>"), "path": "/index.html" },
                    { "content": b64("body{}"), "path": "/assets/app.css" }
                ]
            },
            "bundle": b64("export default { fetch() { return new Response('ok'); } };"),
            "manifest": {
                "bindings": [
                    { "binding": "ASSETS", "type": "assets" },
                    { "binding": "DB", "resource": "app", "type": "d1" },
                    { "binding": "SHARD", "className": "ShardDO", "sqlite": true, "type": "durable_object" }
                ],
                "compatibilityDate": "2026-04-01"
            }
        })
    }

    fn deploy_job() -> DeployJob {
        DeployJob {
            alias: "my-app".into(),
            compatibility_date: None,
            crons: vec!["*/5 * * * *".into()],
            deployment_id: "dep_1".into(),
            release_url: "https://cloud.example/v1/boxes/releases/dep_1".into(),
            vars: IndexMap::from([("API_KEY".to_owned(), "secret-value".to_owned())]),
        }
    }

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn decodes_base64_as_node_does() {
        // `Buffer.from(text, "base64")` for each.
        for (text, decoded) in [
            ("Q", ""),
            ("QQ", "A"),
            ("QQ=", "A"),
            ("QQ==", "A"),
            ("QR", "A"),
            ("QUJ", "AB"),
            ("QUJD=", "ABC"),
            ("QUJDQ==", "ABC"),
            ("QUJDQ", "ABC"),
            ("", ""),
            ("==", ""),
            ("QUJDRA=", "ABCD"),
        ] {
            assert!(is_base64(text), "{text}");
            assert_eq!(decode_base64(text), decoded.as_bytes(), "{text}");
        }

        assert!(!is_base64("QQ===") && !is_base64("QQ=Q") && !is_base64("QQ-_") && !is_base64("QQ Q"));
    }

    #[test]
    fn parses_a_stored_release_keeping_only_the_serving_options() {
        let release = parse_release(&stored_release()).unwrap();
        let assets = release.assets.unwrap();

        assert_eq!(assets.files.len(), 2);
        assert_eq!(assets.config, Some(CelldReleaseAssetsConfig { not_found_handling: Some("single-page-application".into()), ..Default::default() }));
        assert_eq!(assets.rules.unwrap().redirects.as_deref(), Some("/old /new 301\n"));

        let config = pick_assets_config(json!({ "html_handling": "sometimes", "run_worker_first": ["/api/*", 1] }).as_object().unwrap());

        assert_eq!(config, CelldReleaseAssetsConfig::default());
        assert_eq!(pick_assets_config(json!({ "run_worker_first": ["/api/*"] }).as_object().unwrap()).run_worker_first, Some(json!(["/api/*"])));
    }

    #[test]
    fn refuses_a_malformed_release_naming_what_is_wrong() {
        let message = |raw: Value| parse_release(&raw).unwrap_err();
        let with_assets = |assets: Value| json!({ "assets": assets, "bundle": "AA==", "manifest": { "bindings": [] } });

        assert_eq!(message(json!([])), invalid("is not a stored release ({bundle, manifest, assets?})"));
        assert_eq!(message(json!({ "bundle": "AA==", "manifest": [] })), invalid("is not a stored release ({bundle, manifest, assets?})"));
        assert_eq!(message(json!({ "bundle": "", "manifest": {} })), invalid("bundle is not base64"));
        assert_eq!(message(json!({ "bundle": "not base64!", "manifest": {} })), invalid("bundle is not base64"));
        assert_eq!(
            message(json!({ "bundle": "AA==", "manifest": { "bindings": [{ "binding": "A" }] } })),
            invalid("manifest.bindings is not a list of {binding, type}")
        );
        assert_eq!(message(with_assets(Value::Null)), invalid("assets.files is not a list of {path, content}"));
        assert_eq!(message(with_assets(json!({ "files": [{ "path": "/a" }] }))), invalid("assets.files is not a list of {path, content}"));

        for path in ["/../../etc/passwd", "a", "/a//b", "/a\\b", "/./a", "/"] {
            assert_eq!(
                message(with_assets(json!({ "files": [{ "content": "AA==", "path": path }] }))),
                invalid(&format!("asset {} has an unsafe path or non-base64 content", json!(path)))
            );
        }

        assert_eq!(
            message(with_assets(json!({ "files": [{ "content": "AA==", "path": "/_headers" }] }))).message,
            "the release asset /_headers is a config file, not a served one"
        );
        assert_eq!(message(with_assets(json!({ "config": { "_redirects": 1 }, "files": [] }))), invalid("assets.config._redirects is not a string"));
        assert_eq!(quoted_prefix(&"é".repeat(300)), json!("é".repeat(200)).to_string());
    }

    #[test]
    fn lays_a_release_out_as_celld_deploy_takes_it() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("releases").join("dep_1");

        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("stale.js"), "old").unwrap();

        let config = write_release_directory(&directory, &parse_release(&stored_release()).unwrap(), &deploy_job()).unwrap();

        assert!(fs::read_to_string(directory.join("worker.js")).unwrap().contains("new Response('ok')"));
        assert_eq!(fs::read_to_string(directory.join("assets").join("assets").join("app.css")).unwrap(), "body{}");
        assert_eq!(fs::read_to_string(directory.join("assets").join("_headers")).unwrap(), "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n");
        assert_eq!(fs::read_to_string(directory.join("assets").join("_redirects")).unwrap(), "/old /new 301\n");
        assert!(!directory.join("stale.js").exists());
        assert_eq!(config["assets"], json!({ "binding": "ASSETS", "directory": "./assets", "not_found_handling": "single-page-application" }));
        assert_eq!(config["d1_databases"], json!([{ "binding": "DB", "database_id": "my-app--db", "database_name": "my-app--db" }]));
        assert_eq!(
            (&config["name"], &config["triggers"], &config["vars"]),
            (&json!("my-app"), &json!({ "crons": ["*/5 * * * *"] }), &json!({ "API_KEY": "secret-value" }))
        );

        let written = fs::read_to_string(directory.join(RELEASE_CONFIG_FILE)).unwrap();

        assert!(
            written.starts_with(
                "{\n    \"name\": \"my-app\",\n    \"main\": \"worker.js\",\n    \"no_bundle\": true,\n    \"compatibility_date\": \"2026-04-01\",\n"
            ),
            "{written}"
        );
        assert!(written.ends_with("}\n"));
        assert_eq!(mode_of(&directory.join(RELEASE_CONFIG_FILE)), 0o600);
        assert_eq!(mode_of(&directory.join("worker.js")) & !0o022, 0o640);
    }

    #[test]
    fn refuses_a_release_celld_cannot_run_before_writing_anything() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("dep_2");
        let release = parse_release(&json!({ "bundle": "AA==", "manifest": { "bindings": [{ "binding": "AI", "type": "ai" }] } })).unwrap();
        let error = write_release_directory(&directory, &release, &deploy_job()).unwrap_err();

        assert_eq!(error.code, codes::RELEASE_INVALID);
        assert!(error.message.contains("AI (ai)"), "{}", error.message);
        assert!(!directory.exists());
    }

    #[test]
    fn refuses_an_asset_path_that_resolves_outside_the_release() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("dep_3");
        let release = StoredRelease {
            assets: Some(ReleaseAssets { config: None, files: vec![ReleaseAsset { content: "AA==".into(), path: "/../../etc/passwd".into() }], rules: None }),
            bundle: "AA==".into(),
            manifest: json!({ "bindings": [{ "binding": "ASSETS", "type": "assets" }] }),
        };
        let error = write_release_directory(&directory, &release, &deploy_job()).unwrap_err();

        assert_eq!(error, invalid("asset \"/../../etc/passwd\" resolves outside the release"));
        assert!(!root.path().join("etc").exists());
    }

    async fn signed(server: &TestServer) -> (SignedFetch, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let identity = generate_identity(&directory.path().join("box.key")).unwrap();

        (SignedFetch::new("box_1", &server.origin, identity, no_redirect_client()), directory)
    }

    #[tokio::test]
    async fn fetches_and_checks_a_release() {
        let body = stored_release().to_string();
        let length = body.len();
        let server = serve(move |request| match request.target.as_str() {
            "/v1/boxes/releases/dep_1" => respond(200, body.clone()),
            "/v1/boxes/releases/text" => respond(200, "not json"),
            "/v1/boxes/releases/moved" => respond(301, ""),
            _ => respond(404, "missing"),
        })
        .await;
        let (fetch, _directory) = signed(&server).await;
        let url = |name: &str| format!("{}/v1/boxes/releases/{name}", server.origin);
        let (bytes, release) = fetch_release(&fetch, &url("dep_1")).await.unwrap();

        assert_eq!(bytes, length);
        assert_eq!(release.manifest["compatibilityDate"], "2026-04-01");
        assert!(server.requests.lock().unwrap()[0].headers.contains_key(crate::wire::signing::HEADER_SIGNATURE));

        assert_eq!(
            fetch_release(&fetch, &url("gone")).await.unwrap_err(),
            JobError::new(codes::FETCH_FAILED, "the control plane answered 404 for the release")
        );
        assert_eq!(
            fetch_release(&fetch, &url("moved")).await.unwrap_err(),
            JobError::new(codes::FETCH_FAILED, "the control plane answered 301 for the release")
        );
        assert_eq!(fetch_release(&fetch, &url("text")).await.unwrap_err(), invalid("is not JSON"));
        assert_eq!(fetch_capped(&fetch, &url("dep_1"), 100).await.unwrap_err(), invalid(&format!("is {length} bytes, over the 100-byte cap")));
        assert_eq!(fetch_release(&fetch, "https://evil.example/v1/boxes/releases/dep_1").await.unwrap_err().code, codes::ORIGIN_REFUSED);
    }

    #[tokio::test]
    async fn caps_a_body_that_declares_no_length_while_it_streams() {
        let server = serve(|_| {
            let mut response = respond(200, "x".repeat(500));

            response.headers_mut().insert(hyper::header::TRANSFER_ENCODING, hyper::header::HeaderValue::from_static("chunked"));

            response
        })
        .await;
        let (fetch, _directory) = signed(&server).await;

        assert_eq!(fetch_capped(&fetch, &format!("{}/r", server.origin), 100).await.unwrap_err(), invalid("is over the 100-byte cap"));
    }

    #[tokio::test]
    async fn reports_a_control_plane_it_cannot_reach_as_a_failed_fetch() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());

        drop(listener);

        let directory = tempfile::tempdir().unwrap();
        let fetch = SignedFetch::new("box_1", &origin, generate_identity(&directory.path().join("box.key")).unwrap(), no_redirect_client());
        let error = fetch_release(&fetch, &format!("{origin}/v1/boxes/releases/dep_1")).await.unwrap_err();

        assert_eq!(error.code, codes::FETCH_FAILED);
        assert!(error.message.starts_with("could not download the release: "), "{}", error.message);
    }
}
