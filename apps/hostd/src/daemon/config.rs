//! `lunora-hostd`'s on-disk configuration (plan 458 W4): where the control
//! plane is, who this box is, where its key, bucket and data live, and which
//! ports and binaries it may use. Written once by `enrol`, read by every other
//! command, in the same JSON the TypeScript daemon wrote, so a box keeps its
//! enrolment across the switch.
//!
//! Secrets never sit in this file: the box key is its own file (`keyFile`,
//! 0600) and the bucket credentials an environment file (`credentialsFile`,
//! 0600) only the fleets' environment reads — neither reaches the control
//! plane (plan 458 §3 rule 5).

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::release::ReleaseComponent;
use crate::wire::validate::is_protocol_id;

pub const DEFAULT_CONFIG_PATH: &str = "/etc/lunora-hostd/config.json";

pub const DEFAULT_DATA_DIR: &str = "/var/lib/lunora-hostd";

/// Where `install.sh` and `upgrade` put each release (`{installDir}/{releaseId}/`) and the `current` link.
pub const DEFAULT_INSTALL_DIR: &str = "/opt/lunora-hostd";

/// The link in the install directory naming the release that runs.
pub const CURRENT_RELEASE_LINK: &str = "current";

pub const DEFAULT_FLEET_USER: &str = "lunora-fleet";

pub const DEFAULT_EDGE_USER: &str = "lunora-edge";

/// Two loopback ports per fleet (public and internal).
pub const DEFAULT_PORTS: Ports = Ports { first: 20_000, last: 20_999 };

/// The bucket credentials a fleet may be handed from the credentials file; nothing else in it is read.
pub const CREDENTIAL_NAMES: [&str; 3] = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

/// A config problem worth showing the operator as it is.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// The customer's bucket (D7); each fleet lives under `fleets/{alias}/` in it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BucketConfig {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

/// The box's edge: Caddy, its admin API and hostd's on-demand-TLS `ask` endpoint.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CaddyConfig {
    /// Loopback only (`127.0.0.1:2019`).
    #[serde(rename = "adminAddress")]
    pub admin_address: String,
    /// Where hostd serves Caddy's on-demand-TLS permission check, loopback only.
    #[serde(rename = "askAddress")]
    pub ask_address: String,
    #[serde(rename = "httpPort")]
    pub http_port: u16,
    #[serde(rename = "httpsPort")]
    pub https_port: u16,
    /// Off only for test and development boxes: plain HTTP, no certificates.
    pub tls: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct Ports {
    pub first: u16,
    pub last: u16,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct HostdConfig {
    /// Run as root anyway; off by default.
    #[serde(rename = "allowRoot")]
    pub allow_root: bool,
    #[serde(rename = "boxId")]
    pub box_id: String,
    pub bucket: BucketConfig,
    pub caddy: CaddyConfig,
    /// The control plane's origin: the only one this box signs requests for or takes jobs from.
    #[serde(rename = "controlPlane")]
    pub control_plane: String,
    #[serde(rename = "credentialsFile")]
    pub credentials_file: String,
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    #[serde(rename = "edgeUser")]
    pub edge_user: String,
    /// Each fleet's cgroup `memory.max`, in MiB; absent: the box's memory less a reserve.
    #[serde(rename = "fleetMemoryMaxMb", skip_serializing_if = "Option::is_none")]
    pub fleet_memory_max_mb: Option<u64>,
    #[serde(rename = "fleetUser")]
    pub fleet_user: String,
    /// `{slug}.{box domain}`: its aliases answer under it.
    pub hostname: String,
    #[serde(rename = "installDir")]
    pub install_dir: String,
    #[serde(rename = "keyFile")]
    pub key_file: String,
    pub ports: Ports,
    /// Enrolled with `--single-trust`: fleets may start without the W8 self-check.
    #[serde(rename = "singleTrust")]
    pub single_trust: bool,
}

/// Where the configuration is read from: `--config`, then `LUNORA_HOSTD_CONFIG`, then the default.
pub fn config_path_of(flag: Option<&str>, environment: &BTreeMap<String, String>) -> String {
    flag.map(str::to_owned).or_else(|| environment.get("LUNORA_HOSTD_CONFIG").cloned()).unwrap_or_else(|| DEFAULT_CONFIG_PATH.to_owned())
}

/// A file's permission bits, as `ls` prints them in octal.
pub const fn permissions_of(mode: u32) -> u32 {
    mode & 0o777
}

/// Whether a file with `mode` grants its group or others anything.
pub const fn is_open_to_others(mode: u32) -> bool {
    mode & 0o077 != 0
}

type Check = fn(&Value) -> bool;

fn read_field<'a>(record: &'a Map<String, Value>, key: &str, check: Check, what: &str, path: &str) -> Result<&'a Value, ConfigError> {
    match record.get(key) {
        Some(value) if check(value) => Ok(value),
        _ => Err(ConfigError(format!("{path}.{key} must be {what}"))),
    }
}

/// `record[key]` checked, or `None` when it is absent.
fn read_optional<'a>(record: &'a Map<String, Value>, key: &str, check: Check, what: &str, path: &str) -> Result<Option<&'a Value>, ConfigError> {
    if record.contains_key(key) { read_field(record, key, check, what, path).map(Some) } else { Ok(None) }
}

fn is_string(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.is_empty())
}

fn is_absolute_path(value: &Value) -> bool {
    value.as_str().is_some_and(|text| text.starts_with('/'))
}

fn is_boolean(value: &Value) -> bool {
    value.is_boolean()
}

fn is_record(value: &Value) -> bool {
    value.is_object()
}

/// `^[a-z_][\w-]{0,31}$`.
fn is_user_name(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        let bytes = text.as_bytes();

        (1..=32).contains(&bytes.len())
            && (bytes[0].is_ascii_lowercase() || bytes[0] == b'_')
            && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
    })
}

fn whole(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite() && number.fract() == 0.0)
}

fn is_memory_mb(value: &Value) -> bool {
    whole(value).is_some_and(|number| number >= 64.0)
}

fn is_port(value: &Value) -> bool {
    whole(value).is_some_and(|number| (1.0..=65_535.0).contains(&number))
}

/// `^127\.0\.0\.1:\d{1,5}$`.
fn is_loopback_address(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|text| text.strip_prefix("127.0.0.1:"))
        .is_some_and(|port| (1..=5).contains(&port.len()) && port.bytes().all(|byte| byte.is_ascii_digit()))
}

/// An `http:`/`https:` origin with nothing after it.
fn is_origin(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        url::Url::parse(text).is_ok_and(|url| (url.scheme() == "https" || url.scheme() == "http") && url.origin().ascii_serialization() == text)
    })
}

fn is_optional_string(value: &Value) -> bool {
    is_string(value)
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn port(value: &Value) -> u16 {
    whole(value).unwrap_or_default() as u16
}

fn read_caddy(raw: &Map<String, Value>) -> Result<CaddyConfig, ConfigError> {
    let empty = Map::new();
    let caddy = read_optional(raw, "caddy", is_record, "an object", "$")?.and_then(Value::as_object).unwrap_or(&empty);
    let path = "$.caddy";

    Ok(CaddyConfig {
        admin_address: read_optional(caddy, "adminAddress", is_loopback_address, "127.0.0.1:{port}", path)?.map_or_else(|| "127.0.0.1:2019".to_owned(), text),
        ask_address: read_optional(caddy, "askAddress", is_loopback_address, "127.0.0.1:{port}", path)?.map_or_else(|| "127.0.0.1:2020".to_owned(), text),
        http_port: read_optional(caddy, "httpPort", is_port, "a port", path)?.map_or(80, port),
        https_port: read_optional(caddy, "httpsPort", is_port, "a port", path)?.map_or(443, port),
        tls: read_optional(caddy, "tls", is_boolean, "a boolean", path)?.is_none_or(|value| value.as_bool().unwrap_or(true)),
    })
}

fn read_ports(raw: &Map<String, Value>) -> Result<Ports, ConfigError> {
    let Some(ports) = read_optional(raw, "ports", is_record, "an object", "$")?.and_then(Value::as_object) else {
        return Ok(DEFAULT_PORTS);
    };
    let first = port(read_field(ports, "first", is_port, "a port", "$.ports")?);
    let last = port(read_field(ports, "last", is_port, "a port", "$.ports")?);

    if last <= first {
        return Err(ConfigError("$.ports.last must be above $.ports.first: each fleet takes two ports".to_owned()));
    }

    Ok(Ports { first, last })
}

/// Validate a parsed configuration, filling the defaults a hand-written file may leave out.
pub fn parse_config(raw: &Value) -> Result<HostdConfig, ConfigError> {
    let Value::Object(raw) = raw else {
        return Err(ConfigError("the configuration must be a JSON object".to_owned()));
    };
    let data_dir = read_optional(raw, "dataDir", is_absolute_path, "an absolute path", "$")?.map_or_else(|| DEFAULT_DATA_DIR.to_owned(), text);
    let bucket = read_field(raw, "bucket", is_record, "an object", "$")?.as_object().unwrap_or(raw);

    Ok(HostdConfig {
        allow_root: read_optional(raw, "allowRoot", is_boolean, "a boolean", "$")?.is_some_and(|value| value.as_bool() == Some(true)),
        box_id: text(read_field(raw, "boxId", |value| value.as_str().is_some_and(is_protocol_id), "a box id", "$")?),
        bucket: BucketConfig {
            name: text(read_field(bucket, "name", is_string, "a bucket name", "$.bucket")?),
            endpoint: read_optional(bucket, "endpoint", is_optional_string, "a URL", "$.bucket")?.map(text),
            region: read_optional(bucket, "region", is_optional_string, "a region", "$.bucket")?.map(text),
        },
        caddy: read_caddy(raw)?,
        control_plane: text(read_field(raw, "controlPlane", is_origin, "an http(s) origin with no path", "$")?),
        credentials_file: text(read_field(raw, "credentialsFile", is_absolute_path, "an absolute path", "$")?),
        data_dir,
        edge_user: read_optional(raw, "edgeUser", is_user_name, "a user name", "$")?.map_or_else(|| DEFAULT_EDGE_USER.to_owned(), text),
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        fleet_memory_max_mb: read_optional(raw, "fleetMemoryMaxMb", is_memory_mb, "a whole number of MiB, at least 64", "$")?
            .and_then(whole)
            .map(|mb| mb as u64),
        fleet_user: read_optional(raw, "fleetUser", is_user_name, "a user name", "$")?.map_or_else(|| DEFAULT_FLEET_USER.to_owned(), text),
        hostname: text(read_field(raw, "hostname", is_string, "the box's hostname", "$")?),
        install_dir: read_optional(raw, "installDir", is_absolute_path, "an absolute path", "$")?.map_or_else(|| DEFAULT_INSTALL_DIR.to_owned(), text),
        key_file: text(read_field(raw, "keyFile", is_absolute_path, "an absolute path", "$")?),
        ports: read_ports(raw)?,
        single_trust: read_optional(raw, "singleTrust", is_boolean, "a boolean", "$")?.is_some_and(|value| value.as_bool() == Some(true)),
    })
}

/// Read and validate the configuration at `path`.
pub fn load_config(path: &str) -> Result<HostdConfig, ConfigError> {
    let Ok(contents) = fs::read_to_string(path) else {
        return Err(ConfigError(format!("no configuration at {path}: enrol this box first (lunora-hostd enrol --token …)")));
    };
    let Ok(raw) = serde_json::from_str::<Value>(&contents) else {
        return Err(ConfigError(format!("{path} is not valid JSON")));
    };

    parse_config(&raw).map_err(|error| ConfigError(format!("{path}: {error}")))
}

/// Write `contents` to `path` atomically (temp file + rename) with `mode`, creating the directory.
pub fn write_file_atomic(path: &Path, contents: &[u8], mode: u32) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        create_dir_all_with_mode(parent, 0o750)?;
    }

    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));

    fs::write(&temporary, contents)?;
    // Not left to the umask: set outright.
    fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))?;
    fs::rename(&temporary, path)
}

/// `mkdir -p` with `mode` for each directory it creates (masked by the umask, as `mkdirSync` is).
pub fn create_dir_all_with_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    fs::DirBuilder::new().recursive(true).mode(mode).create(path)
}

/// Write the configuration (0640: it names paths and ids, never a secret).
pub fn save_config(path: &Path, config: &HostdConfig) -> std::io::Result<()> {
    let mut contents = serde_json::to_string_pretty(config).map_err(std::io::Error::other)?;

    contents.push('\n');
    write_file_atomic(path, pretty_four(&contents).as_bytes(), 0o640)
}

/// `JSON.stringify(value, undefined, 4)`'s indentation from serde's two-space pretty printing.
pub fn pretty_four(two_space: &str) -> String {
    two_space
        .lines()
        .map(|line| {
            let depth = line.len() - line.trim_start_matches(' ').len();

            format!("{}{}", " ".repeat(depth * 2), &line[depth..])
        })
        .collect::<Vec<_>>()
        .join("\n")
        + if two_space.ends_with('\n') { "\n" } else { "" }
}

/// `KEY=value` lines; blank lines and `#` comments skipped, values verbatim.
pub fn parse_environment_file(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let separator = trimmed.find('=')?;

            (!trimmed.starts_with('#') && separator >= 1).then(|| (trimmed[..separator].to_owned(), trimmed[separator + 1..].to_owned()))
        })
        .collect()
}

/// The bucket credentials from the credentials file — only the names celld's AWS chain reads. A file others
/// can read is refused: it holds the keys to the customer's data. No file: the AWS chain finds them elsewhere.
pub fn load_bucket_credentials(path: &str) -> Result<BTreeMap<String, String>, ConfigError> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(BTreeMap::new());
    };
    let mode = metadata.permissions().mode();

    if is_open_to_others(mode) {
        return Err(ConfigError(format!("{path} is readable by others (mode {:o}); chmod 600 it", permissions_of(mode))));
    }

    let entries = parse_environment_file(&fs::read_to_string(path).map_err(|error| ConfigError(format!("cannot read {path}: {error}")))?);

    Ok(CREDENTIAL_NAMES.iter().filter_map(|name| Some(((*name).to_owned(), entries.get(*name)?.clone()))).collect())
}

/// Write the bucket credentials file, 0600.
pub fn save_bucket_credentials(path: &Path, credentials: &BTreeMap<String, String>) -> std::io::Result<()> {
    let lines: Vec<String> = CREDENTIAL_NAMES.iter().filter_map(|name| Some(format!("{name}={}", credentials.get(*name)?))).collect();

    write_file_atomic(path, format!("# lunora-hostd bucket credentials — never shared with Lunora Cloud\n{}\n", lines.join("\n")).as_bytes(), 0o600)
}

/// The binary of `component` in the release `{installDir}/current` names.
pub fn binary_path(install_dir: &str, component: ReleaseComponent) -> PathBuf {
    Path::new(install_dir).join(CURRENT_RELEASE_LINK).join(component.binary_name())
}

/// The bucket prefix a fleet's objects live under, without its trailing slash.
pub fn fleet_prefix(alias: &str) -> String {
    format!("fleets/{alias}")
}

/// `s3://{bucket}/fleets/{alias}`: the fleet's own prefix of the customer's bucket (D8).
pub fn fleet_bucket_url(bucket: &BucketConfig, alias: &str) -> String {
    format!("s3://{}/{}", bucket.name, fleet_prefix(alias))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn minimal() -> Value {
        json!({
            "boxId": "box_1",
            "bucket": { "name": "b" },
            "controlPlane": "https://cloud.example",
            "credentialsFile": "/etc/lunora-hostd/bucket.env",
            "hostname": "box-1.boxes.lunora.app",
            "keyFile": "/etc/lunora-hostd/box.key"
        })
    }

    #[test]
    fn fills_the_defaults_a_hand_written_file_leaves_out() {
        let config = parse_config(&minimal()).unwrap();

        assert_eq!(config.data_dir, DEFAULT_DATA_DIR);
        assert_eq!(config.install_dir, DEFAULT_INSTALL_DIR);
        assert_eq!(config.ports, DEFAULT_PORTS);
        assert_eq!(config.caddy.admin_address, "127.0.0.1:2019");
        assert_eq!(config.caddy.ask_address, "127.0.0.1:2020");
        assert_eq!((config.caddy.http_port, config.caddy.https_port, config.caddy.tls), (80, 443, true));
        assert_eq!((config.fleet_user.as_str(), config.edge_user.as_str()), (DEFAULT_FLEET_USER, DEFAULT_EDGE_USER));
        assert!(!config.single_trust && !config.allow_root);
    }

    #[test]
    fn names_the_first_field_that_is_wrong() {
        let error = |patch: Value| {
            let mut raw = minimal();

            for (key, value) in patch.as_object().unwrap() {
                raw[key] = value.clone();
            }

            parse_config(&raw).unwrap_err().0
        };

        assert_eq!(error(json!({ "boxId": "a b" })), "$.boxId must be a box id");
        assert_eq!(error(json!({ "controlPlane": "https://cloud.example/path" })), "$.controlPlane must be an http(s) origin with no path");
        assert_eq!(error(json!({ "ports": { "first": 20_000, "last": 20_000 } })), "$.ports.last must be above $.ports.first: each fleet takes two ports");
        assert_eq!(error(json!({ "caddy": { "adminAddress": "0.0.0.0:2019" } })), "$.caddy.adminAddress must be 127.0.0.1:{port}");
        assert_eq!(error(json!({ "fleetMemoryMaxMb": 32 })), "$.fleetMemoryMaxMb must be a whole number of MiB, at least 64");
        assert_eq!(error(json!({ "fleetUser": "Root" })), "$.fleetUser must be a user name");
        assert_eq!(parse_config(&json!([])).unwrap_err().0, "the configuration must be a JSON object");
    }

    #[test]
    fn round_trips_through_the_file_with_four_space_indentation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("etc").join("config.json");
        let config = parse_config(&minimal()).unwrap();

        save_config(&path, &config).unwrap();

        let written = fs::read_to_string(&path).unwrap();

        assert!(
            written.starts_with("{\n    \"allowRoot\": false,\n    \"boxId\": \"box_1\",\n    \"bucket\": {\n        \"name\": \"b\"\n    },"),
            "{written}"
        );
        assert_eq!(load_config(path.to_str().unwrap()).unwrap(), config);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
    }

    #[test]
    fn refuses_a_credentials_file_others_can_read() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bucket.env");
        let credentials = BTreeMap::from([("AWS_ACCESS_KEY_ID".to_owned(), "id".to_owned()), ("AWS_SECRET_ACCESS_KEY".to_owned(), "secret".to_owned())]);

        save_bucket_credentials(&path, &credentials).unwrap();
        assert_eq!(load_bucket_credentials(path.to_str().unwrap()).unwrap(), credentials);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_bucket_credentials(path.to_str().unwrap()).unwrap_err().0.contains("readable by others (mode 644)"));
        assert!(load_bucket_credentials("/nonexistent/bucket.env").unwrap().is_empty());
    }

    #[test]
    fn reads_only_the_credential_names() {
        let entries = parse_environment_file("# comment\n\nAWS_ACCESS_KEY_ID=a=b\n  OTHER=x\n=nothing\n");

        assert_eq!(entries.get("AWS_ACCESS_KEY_ID").map(String::as_str), Some("a=b"));
        assert_eq!(entries.get("OTHER").map(String::as_str), Some("x"));
        assert!(!entries.contains_key(""));
    }
}
