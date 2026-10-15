//! `lunora-hostd enrol` (D4, W4 "Enrol"): bind this machine to an
//! organization with the one-time token the studio showed.
//!
//! In order: check the bucket with celld's own probe (so a wrong bucket fails
//! before the single-use token is spent), generate the box's Ed25519 key,
//! `POST /v1/boxes/enrol` with the token, the public key, the box's public
//! addresses and its binaries' versions, then write the configuration and the
//! bucket credentials (0600). The new key is written beside the current one and
//! takes its place only once the control plane accepted it, so a refused
//! `--force` leaves an enrolled box exactly as it was. The token is sent once
//! and never printed; the bucket credentials are read from the environment,
//! never from the command line, and never leave the box.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use super::celld_cli::{CelldPlacement, celld_diagnose};
use super::config::{CREDENTIAL_NAMES, ConfigError, DEFAULT_DATA_DIR, HostdConfig, parse_config, save_bucket_credentials, save_config};
use super::identity::generate_identity;
use super::log::Logger;
use super::release_install::installed_versions;

/// The production control plane `enrol` uses without `--control-plane` — none is published yet (D16).
pub const DEFAULT_CONTROL_PLANE: Option<&str> = None;

#[derive(Clone, Debug, Default)]
pub struct EnrolInput {
    pub bucket: String,
    /// Run the bucket probe; off only where celld is not installed yet.
    pub check_bucket: bool,
    pub config_path: String,
    pub control_plane: Option<String>,
    pub data_dir: Option<String>,
    pub endpoint: Option<String>,
    /// Overwrite an existing enrolment.
    pub force: bool,
    pub install_dir: Option<String>,
    pub ipv4: Option<String>,
    pub ipv6: Option<String>,
    pub region: Option<String>,
    pub single_trust: bool,
    pub token: String,
}

fn is_private_ipv4(address: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = address.octets();

    a == 10
        || a == 127
        || a == 0
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
        || (a == 100 && (64..=127).contains(&b))
}

/// Global unicast (2000::/3), which the control plane requires.
fn is_global_ipv6(address: std::net::Ipv6Addr) -> bool {
    address.segments()[0] & 0xe000 == 0x2000
}

/// The machine's first public IPv4 and global IPv6 address, which the control plane points the box's hostnames at.
pub fn public_addresses(interfaces: &[(bool, IpAddr)]) -> (Option<String>, Option<String>) {
    let ipv4 = interfaces.iter().find_map(|(loopback, address)| match address {
        IpAddr::V4(address) if !loopback && !is_private_ipv4(*address) => Some(address.to_string()),
        _ => None,
    });
    let ipv6 = interfaces.iter().find_map(|(loopback, address)| match address {
        IpAddr::V6(address) if !loopback && is_global_ipv6(*address) => Some(address.to_string()),
        _ => None,
    });

    (ipv4, ipv6)
}

/// This machine's addresses, each with whether it is on a loopback interface.
fn interfaces() -> Vec<(bool, IpAddr)> {
    if_addrs::get_if_addrs().map(|interfaces| interfaces.iter().map(|interface| (interface.is_loopback(), interface.ip())).collect()).unwrap_or_default()
}

/// A bucket given as `name` or `s3://name`.
fn bucket_name_of(bucket: &str) -> Result<String, ConfigError> {
    let name = bucket.strip_prefix("s3://").unwrap_or(bucket).trim_end_matches('/');

    if name.is_empty() || name.contains('/') || name.contains("://") {
        return Err(ConfigError("--bucket must be a bucket name or s3://{name}: each fleet gets its own prefix in it".into()));
    }

    Ok(name.to_owned())
}

/// The configuration an enrolment writes, validated (and defaulted) before anything is written or sent.
fn draft_config(input: &EnrolInput, control_plane: &str) -> Result<HostdConfig, ConfigError> {
    let config_directory = Path::new(&input.config_path).parent().unwrap_or_else(|| Path::new("/"));
    let origin = url::Url::parse(control_plane)
        .map(|url| url.origin().ascii_serialization())
        .map_err(|_| ConfigError(format!("--control-plane {control_plane} is not a URL")))?;
    let mut bucket = json!({ "name": bucket_name_of(&input.bucket)? });

    if let Some(endpoint) = &input.endpoint {
        bucket["endpoint"] = json!(endpoint);
    }

    if let Some(region) = &input.region {
        bucket["region"] = json!(region);
    }

    let mut raw = json!({
        "boxId": "pending",
        "bucket": bucket,
        "controlPlane": origin,
        "credentialsFile": config_directory.join("bucket.env"),
        "dataDir": input.data_dir.as_deref().unwrap_or(DEFAULT_DATA_DIR),
        "hostname": "pending",
        "keyFile": config_directory.join("box.key"),
        "singleTrust": input.single_trust,
    });

    if let Some(install_dir) = &input.install_dir {
        raw["installDir"] = json!(install_dir);
    }

    parse_config(&raw)
}

/// Run celld's own bucket probe; fails (before the token is spent) when a bucket check fails.
async fn check_bucket(draft: &HostdConfig, credentials: &BTreeMap<String, String>, logger: &Logger) -> Result<(), ConfigError> {
    logger.info(&format!("checking s3://{} with celld diagnose", draft.bucket.name));

    let probe = celld_diagnose(draft, "_hostd-enrol-check", credentials, &CelldPlacement::default()).await.map_err(|error| ConfigError(error.message))?;
    let checks: Vec<&String> = probe.lines.iter().filter(|line| line.contains("\"check\":\"bucket")).collect();

    if checks.is_empty() || checks.iter().any(|line| !line.contains("\"verdict\":\"ok\"")) {
        return Err(ConfigError(format!("the bucket check failed, so the enrolment token was not used:\n{}", probe.lines.join("\n"))));
    }

    Ok(())
}

/// Why the control plane refused, from its `{error}` (or `{message}`) body.
fn refusal_reason(body: &Value) -> String {
    body.get("message").and_then(Value::as_str).or_else(|| body.get("error").and_then(Value::as_str)).unwrap_or("no reason given").to_owned()
}

struct Enrolled {
    box_id: String,
    dns_error: Option<String>,
    hostname: String,
}

/// `POST /v1/boxes/enrol`; the box's id and hostname, or a refusal. The token is in the body only.
async fn request_enrolment(control_plane: &str, payload: &Value) -> Result<Enrolled, ConfigError> {
    let url = format!("{control_plane}/v1/boxes/enrol");
    let response = super::http::no_redirect_client()
        .post(&url)
        .header("content-type", "application/json")
        .body(payload.to_string())
        .timeout(Duration::from_secs(30))
        .send()
        .await
        // The URL is the control plane's own and carries nothing secret; the token is in the body, never echoed.
        .map_err(|error| ConfigError(format!("could not reach the control plane: {}", super::signed_fetch::describe_error(&error))))?;
    let status = response.status();
    let body: Value = response.bytes().await.ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null);
    let text = |key: &str| body.get(key).and_then(Value::as_str).map(str::to_owned);

    match (status.is_success(), text("boxId"), text("hostname")) {
        (true, Some(box_id), Some(hostname)) => Ok(Enrolled { box_id, dns_error: text("dnsError"), hostname }),
        _ => Err(ConfigError(format!("the control plane refused the enrolment ({}): {}", status.as_u16(), refusal_reason(&body)))),
    }
}

/// Enrol this machine; returns the written configuration.
pub async fn enrol(input: &EnrolInput, environment: &BTreeMap<String, String>, logger: &Logger) -> Result<HostdConfig, ConfigError> {
    let Some(control_plane) = input.control_plane.as_deref().or(DEFAULT_CONTROL_PLANE) else {
        return Err(ConfigError("no default control plane is configured in this build; pass --control-plane {origin}".into()));
    };

    if Path::new(&input.config_path).exists() && !input.force {
        return Err(ConfigError(format!(
            "{} exists: this machine is enrolled already. Enrolling again creates a new box; pass --force to do that",
            input.config_path
        )));
    }

    let draft = draft_config(input, control_plane)?;
    let credentials: BTreeMap<String, String> =
        CREDENTIAL_NAMES.iter().filter_map(|name| Some(((*name).to_owned(), environment.get(*name)?.clone()))).collect();

    if input.check_bucket {
        check_bucket(&draft, &credentials, logger).await?;
    }

    let (detected_ipv4, detected_ipv6) = public_addresses(&interfaces());
    let ipv4 = input.ipv4.clone().or(detected_ipv4);
    let ipv6 = input.ipv6.clone().or(detected_ipv6);

    if ipv4.is_none() && ipv6.is_none() {
        return Err(ConfigError(
            "found no public IPv4 or IPv6 address on this machine; pass --ipv4 or --ipv6 with the address its hostnames should point at".into(),
        ));
    }

    // The new key waits beside the current one until the control plane accepts it: a refused `--force` must leave
    // the box enrolled as it was, not keyless.
    let pending = PathBuf::from(format!("{}.pending", draft.key_file));
    let identity = generate_identity(&pending).map_err(ConfigError)?;
    let mut payload = json!({
        "publicKey": identity.public_key(),
        "singleTrust": input.single_trust,
        "token": input.token,
        "versions": installed_versions(&draft.install_dir).await,
    });

    if let Some(ipv4) = ipv4 {
        payload["ipv4"] = json!(ipv4);
    }

    if let Some(ipv6) = ipv6 {
        payload["ipv6"] = json!(ipv6);
    }

    let enrolled = match request_enrolment(&draft.control_plane, &payload).await {
        Ok(enrolled) => enrolled,
        Err(error) => {
            let _ = std::fs::remove_file(&pending);

            return Err(error);
        }
    };
    let mut config = draft;

    config.box_id.clone_from(&enrolled.box_id);
    config.hostname.clone_from(&enrolled.hostname);

    // Validated again with the real id and hostname, exactly as it is written.
    let config = parse_config(&serde_json::to_value(&config).map_err(|error| ConfigError(error.to_string()))?)?;
    let io = |error: std::io::Error| ConfigError(error.to_string());

    std::fs::rename(&pending, &config.key_file).map_err(io)?;
    save_bucket_credentials(Path::new(&config.credentials_file), &credentials).map_err(io)?;
    save_config(Path::new(&input.config_path), &config).map_err(io)?;
    logger.info(&format!("enrolled as box {} ({})", config.box_id, config.hostname));

    if let Some(dns_error) = enrolled.dns_error {
        logger.warn(&format!("the control plane could not write this box's DNS records yet: {dns_error}"));
    }

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_first_public_ipv4_and_global_ipv6() {
        let address = |text: &str| text.parse::<IpAddr>().unwrap();
        let interfaces = [
            (true, address("127.0.0.1")),
            (false, address("10.0.0.5")),
            (false, address("100.64.0.9")),
            (false, address("fe80::1")),
            (false, address("fd00::1")),
            (false, address("203.0.113.10")),
            (false, address("2001:db8::10")),
            (false, address("198.51.100.1")),
        ];

        assert_eq!(public_addresses(&interfaces), (Some("203.0.113.10".into()), Some("2001:db8::10".into())));
        assert_eq!(public_addresses(&interfaces[..5]), (None, None));
    }

    #[test]
    fn takes_a_bucket_by_name_or_s3_url() {
        assert_eq!(bucket_name_of("s3://my-bucket/").unwrap(), "my-bucket");
        assert_eq!(bucket_name_of("my-bucket").unwrap(), "my-bucket");
        assert!(bucket_name_of("s3://my-bucket/prefix").is_err());
        assert!(bucket_name_of("gs://my-bucket").is_err());
        assert!(bucket_name_of("").is_err());
    }
}
