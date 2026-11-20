//! Strict validators for every hostd message (protocol §4): each reader takes
//! an untrusted JSON value and returns a typed message holding only the known
//! fields, or the first field at fault. Reader by reader a port of the
//! reference `apps/hostd/src/wire/validate.ts`, reading fields in the same
//! order, so a frame with several problems reports the same one.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::types::{
    AliasReport, BoxIsolation, BoxMessage, BoxResources, BoxVersions, CloudMessage, DeployJob, ErrorDetail, FleetState, FleetSummary, HelloMessage, HostdJob,
    IsolationStatus, ReportMessage, ResultMessage, RouteEntry, TelemetryConfig, UpgradeJob,
};
use super::{LIMITS, MAX_SAFE_INTEGER, js_length};

/// A field failed validation: where, and the reference's sentence for it (which starts with the path).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invalid {
    pub message: String,
    pub path: String,
}

pub type Read<T> = Result<T, Invalid>;

pub fn fail<T>(path: &str, message: &str) -> Read<T> {
    Err(Invalid { message: format!("{path} {message}"), path: path.to_owned() })
}

const SIGNATURE_LENGTH: usize = 86;

const MIN_NONCE_LENGTH: usize = 22;

const MAX_NONCE_LENGTH: usize = 128;

const MAX_HOSTNAME_LENGTH: usize = 253;

const MAX_CRON_LENGTH: usize = 256;

const FLEET_STATES: &str = "failed, running, starting, stopped";

const ISOLATION_STATUSES: &str = "enforced, refused, single-trust";

const JOB_KINDS: &str = "deploy, destroy, diagnose, reload, upgrade";

const fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

const fn is_lower_alphanumeric(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

/// `^[a-z\d]+(?:-[a-z\d]+)*$`: dash-separated runs, so never `--`, never a leading or trailing `-`.
fn is_dash_separated(value: &str) -> bool {
    !value.is_empty() && value.split('-').all(|run| !run.is_empty() && run.bytes().all(is_lower_alphanumeric))
}

/// A deployment alias: dash-separated runs of `[a-z0-9]`, at most 63 characters (one DNS label).
pub fn is_alias(value: &str) -> bool {
    value.len() <= LIMITS.max_alias_length && is_dash_separated(value)
}

/// A protocol id (box, job, deployment, release): `^[A-Za-z0-9_-]{1,128}$`.
pub fn is_protocol_id(value: &str) -> bool {
    (1..=128).contains(&value.len()) && value.bytes().all(|byte| is_word(byte) || byte == b'-')
}

fn is_base64url(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| is_word(byte) || byte == b'-')
}

/// A challenge or request nonce: 22-128 base64url characters.
pub fn is_nonce(value: &str) -> bool {
    (MIN_NONCE_LENGTH..=MAX_NONCE_LENGTH).contains(&value.len()) && is_base64url(value)
}

/// A version string as `hello` reports one: `^[A-Za-z0-9_.+~-]{1,64}$`.
pub fn is_version(value: &str) -> bool {
    (1..=64).contains(&value.len()) && value.bytes().all(|byte| is_word(byte) || b".+~-".contains(&byte))
}

/// `^[A-Z][A-Z0-9_]{0,63}$`.
pub fn is_error_code(value: &str) -> bool {
    let bytes = value.as_bytes();

    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes[1..].iter().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// `^[A-Za-z_][A-Za-z0-9_]{0,255}$`.
fn is_var_name(value: &str) -> bool {
    let bytes = value.as_bytes();

    (1..=256).contains(&bytes.len()) && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_') && bytes.iter().copied().all(is_word)
}

/// `^\d{4}-\d{2}-\d{2}$`.
fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();

    bytes.len() == 10 && bytes.iter().enumerate().all(|(index, byte)| if index == 4 || index == 7 { *byte == b'-' } else { byte.is_ascii_digit() })
}

/// One DNS label: `^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$`.
fn is_hostname_label(label: &str) -> bool {
    let bytes = label.as_bytes();

    (1..=63).contains(&bytes.len())
        && is_lower_alphanumeric(bytes[0])
        && is_lower_alphanumeric(bytes[bytes.len() - 1])
        && bytes.iter().all(|byte| is_lower_alphanumeric(*byte) || *byte == b'-')
}

/// A lowercase DNS hostname: labels of `[a-z0-9-]`, at most 253 characters, no trailing dot, a final label not all digits.
pub fn is_hostname(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_HOSTNAME_LENGTH || !value.split('.').all(is_hostname_label) {
        return false;
    }

    !value.rsplit('.').next().is_some_and(|last| last.bytes().all(|byte| byte.is_ascii_digit()))
}

/// A bearer token: printable ASCII without spaces (`!`–`~`), at least one character.
fn is_token(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

/// Whether `key` is an array index as JavaScript orders object keys: `0`..`4294967294`, no leading zeros.
fn is_array_index(key: &str) -> bool {
    !key.is_empty()
        && (key == "0" || !key.starts_with('0'))
        && key.bytes().all(|byte| byte.is_ascii_digit())
        && key.parse::<u64>().is_ok_and(|index| index < 4_294_967_295)
}

/// An object's keys in `Object.keys` order: array indexes ascending, then the rest as written.
pub fn js_key_order(record: &Map<String, Value>) -> Vec<&String> {
    let mut indexes: Vec<&String> = record.keys().filter(|key| is_array_index(key)).collect();

    indexes.sort_by_key(|key| key.parse::<u64>().unwrap_or(0));
    indexes.extend(record.keys().filter(|key| !is_array_index(key)));

    indexes
}

/// An object holding `required`, and nothing outside `required` and `optional`.
pub fn read_object<'a>(value: &'a Value, path: &str, required: &[&str], optional: &[&str]) -> Read<&'a Map<String, Value>> {
    let Value::Object(record) = value else {
        return fail(path, "must be an object");
    };

    for key in js_key_order(record) {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return fail(&format!("{path}.{key}"), "is not a known field");
        }
    }

    for key in required {
        if !record.contains_key(*key) {
            return fail(&format!("{path}.{key}"), "is required");
        }
    }

    Ok(record)
}

/// `record[key]`, which a successful [`read_object`] guarantees for a required key.
pub fn field<'a>(record: &'a Map<String, Value>, key: &str) -> &'a Value {
    record.get(key).unwrap_or(&Value::Null)
}

pub fn read_array<'a>(value: &'a Value, path: &str, max: usize) -> Read<&'a Vec<Value>> {
    let Value::Array(entries) = value else {
        return fail(path, "must be an array");
    };

    if entries.len() > max {
        return fail(path, &format!("must have at most {max} entries"));
    }

    Ok(entries)
}

fn read_boolean(value: &Value, path: &str) -> Read<bool> {
    value.as_bool().map_or_else(|| fail(path, "must be a boolean"), Ok)
}

/// A JSON number as JavaScript reads it: `1`, `1.0` and `1e0` are the same double.
fn as_double(value: &Value) -> Option<f64> {
    value.as_f64()
}

/// A safe integer of at least `min`, as `Number.isSafeInteger` decides one (so `2.0` counts).
pub fn read_integer(value: &Value, path: &str, min: u64) -> Read<u64> {
    let fail_integer = || fail(path, &format!("must be an integer >= {min}"));

    if let Some(integer) = value.as_u64() {
        // u64 and the f64 bound agree here: 2^53 - 1 is exact in both.
        #[allow(clippy::cast_precision_loss)]
        return if (integer as f64) <= MAX_SAFE_INTEGER && integer >= min { Ok(integer) } else { fail_integer() };
    }

    match as_double(value) {
        // A negative zero is a safe integer, 0; any other negative number is below every `min`.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some(number) if number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER && number >= 0.0 && (number as u64) >= min => {
            Ok(number as u64)
        }
        _ => fail_integer(),
    }
}

fn read_non_negative_number(value: &Value, path: &str) -> Read<f64> {
    match as_double(value) {
        Some(number) if number.is_finite() && number >= 0.0 => Ok(number),
        _ => fail(path, "must be a finite number >= 0"),
    }
}

pub fn read_string<'a>(value: &'a Value, path: &str) -> Read<&'a str> {
    value.as_str().map_or_else(|| fail(path, "must be a string"), Ok)
}

pub fn read_matching(value: &Value, path: &str, check: fn(&str) -> bool, description: &str) -> Read<String> {
    let text = read_string(value, path)?;

    if !check(text) {
        return fail(path, &format!("must be {description}"));
    }

    Ok(text.to_owned())
}

/// A string of at most `max_bytes` UTF-8 bytes.
fn read_text(value: &Value, path: &str, max_bytes: usize) -> Read<String> {
    let text = read_string(value, path)?;

    if text.len() > max_bytes {
        return fail(path, &format!("must be at most {max_bytes} UTF-8 bytes"));
    }

    Ok(text.to_owned())
}

pub fn read_id(value: &Value, path: &str) -> Read<String> {
    read_matching(value, path, is_protocol_id, "1-128 characters of [A-Za-z0-9_-]")
}

fn read_alias(value: &Value, path: &str) -> Read<String> {
    let alias = read_string(value, path)?;

    if !is_alias(alias) {
        return fail(path, &format!("must be an alias: dash-separated runs of [a-z0-9], at most {} characters", LIMITS.max_alias_length));
    }

    Ok(alias.to_owned())
}

fn read_hostname(value: &Value, path: &str) -> Read<String> {
    let hostname = read_string(value, path)?;

    if !is_hostname(hostname) {
        return fail(path, "must be a lowercase DNS hostname");
    }

    Ok(hostname.to_owned())
}

/// An absolute `http:`/`https:` URL of at most 2048 characters, without credentials.
fn read_url(value: &Value, path: &str) -> Read<String> {
    let text = read_string(value, path)?;
    let parsed = if js_length(text) > LIMITS.max_url_length { None } else { url::Url::parse(text).ok() };

    let Some(url) = parsed else {
        return fail(path, &format!("must be an absolute URL of at most {} characters", LIMITS.max_url_length));
    };

    if url.scheme() != "https" && url.scheme() != "http" {
        return fail(path, "must be an http(s) URL");
    }

    if !url.username().is_empty() || url.password().is_some() {
        return fail(path, "must not carry credentials");
    }

    Ok(text.to_owned())
}

fn read_nonce(value: &Value, path: &str) -> Read<String> {
    let nonce = read_matching(value, path, is_base64url, "base64url without padding")?;

    if !(MIN_NONCE_LENGTH..=MAX_NONCE_LENGTH).contains(&nonce.len()) {
        return fail(path, &format!("must be {MIN_NONCE_LENGTH}-{MAX_NONCE_LENGTH} base64url characters"));
    }

    Ok(nonce)
}

fn read_error_detail(value: &Value, path: &str) -> Read<ErrorDetail> {
    let record = read_object(value, path, &["code", "message"], &[])?;

    Ok(ErrorDetail {
        code: read_matching(field(record, "code"), &format!("{path}.code"), is_error_code, "an UPPER_SNAKE_CASE code of at most 64 characters")?,
        message: read_text(field(record, "message"), &format!("{path}.message"), LIMITS.max_error_message_bytes)?,
    })
}

/// Rejects a list whose entries repeat a key.
fn assert_unique<'a>(keys: impl Iterator<Item = &'a str>, path: &str, name: &str) -> Read<()> {
    let mut seen = std::collections::HashSet::new();

    for (index, key) in keys.enumerate() {
        if !seen.insert(key) {
            return fail(&format!("{path}[{index}].{name}"), &format!("repeats {}", serde_json::to_string(key).unwrap_or_default()));
        }
    }

    Ok(())
}

fn read_fleet(value: &Value, path: &str) -> Read<FleetSummary> {
    let record = read_object(value, path, &["alias", "state"], &["deploymentId"])?;
    let state_path = format!("{path}.state");
    let state = read_string(field(record, "state"), &state_path)?;
    let Some(state) = FleetState::parse(state) else {
        return fail(&state_path, &format!("must be one of {FLEET_STATES}"));
    };
    let alias = read_alias(field(record, "alias"), &format!("{path}.alias"))?;
    let deployment_id = match record.get("deploymentId") {
        Some(value) => Some(read_id(value, &format!("{path}.deploymentId"))?),
        None => None,
    };

    Ok(FleetSummary { alias, deployment_id, state })
}

fn read_versions(value: &Value, path: &str) -> Read<BoxVersions> {
    let record = read_object(value, path, &["hostd", "celld", "caddy"], &[])?;
    let description = "1-64 characters of [A-Za-z0-9_.+~-]";

    Ok(BoxVersions {
        caddy: read_matching(field(record, "caddy"), &format!("{path}.caddy"), is_version, description)?,
        celld: read_matching(field(record, "celld"), &format!("{path}.celld"), is_version, description)?,
        hostd: read_matching(field(record, "hostd"), &format!("{path}.hostd"), is_version, description)?,
    })
}

fn read_resources(value: &Value, path: &str) -> Read<BoxResources> {
    let record = read_object(value, path, &["memMb", "diskFreeMb"], &[])?;

    Ok(BoxResources {
        disk_free_mb: read_integer(field(record, "diskFreeMb"), &format!("{path}.diskFreeMb"), 0)?,
        mem_mb: read_integer(field(record, "memMb"), &format!("{path}.memMb"), 0)?,
    })
}

fn read_isolation(value: &Value, path: &str) -> Read<BoxIsolation> {
    let record = read_object(value, path, &["status"], &["problems"])?;
    let status_path = format!("{path}.status");
    let status = read_string(field(record, "status"), &status_path)?;
    let Some(status) = IsolationStatus::parse(status) else {
        return fail(&status_path, &format!("must be one of {ISOLATION_STATUSES}"));
    };
    let problems = match record.get("problems") {
        Some(value) => {
            let problems_path = format!("{path}.problems");
            let entries = read_array(value, &problems_path, LIMITS.max_isolation_problems)?;

            Some(
                entries
                    .iter()
                    .enumerate()
                    .map(|(index, problem)| read_text(problem, &format!("{problems_path}[{index}]"), LIMITS.max_isolation_problem_bytes))
                    .collect::<Read<Vec<_>>>()?,
            )
        }
        None => None,
    };

    Ok(BoxIsolation { problems, status })
}

fn read_hello(value: &Value, path: &str) -> Read<HelloMessage> {
    let record = read_object(value, path, &["type", "protocol", "boxId", "versions", "fleets", "resources"], &["isolation"])?;
    let fleets_path = format!("{path}.fleets");
    let fleets = read_array(field(record, "fleets"), &fleets_path, LIMITS.max_fleets)?
        .iter()
        .enumerate()
        .map(|(index, fleet)| read_fleet(fleet, &format!("{fleets_path}[{index}]")))
        .collect::<Read<Vec<_>>>()?;

    assert_unique(fleets.iter().map(|fleet| fleet.alias.as_str()), &fleets_path, "alias")?;

    let box_id = read_id(field(record, "boxId"), &format!("{path}.boxId"))?;
    let isolation = match record.get("isolation") {
        Some(value) => Some(read_isolation(value, &format!("{path}.isolation"))?),
        None => None,
    };

    Ok(HelloMessage {
        box_id,
        fleets,
        isolation,
        protocol: read_integer(field(record, "protocol"), &format!("{path}.protocol"), 1)?,
        resources: read_resources(field(record, "resources"), &format!("{path}.resources"))?,
        versions: read_versions(field(record, "versions"), &format!("{path}.versions"))?,
    })
}

fn read_auth(value: &Value, path: &str) -> Read<BoxMessage> {
    let record = read_object(value, path, &["type", "signature"], &[])?;
    let signature_path = format!("{path}.signature");
    let signature = read_matching(field(record, "signature"), &signature_path, is_base64url, "base64url without padding")?;

    if signature.len() != SIGNATURE_LENGTH {
        return fail(&signature_path, &format!("must be a {SIGNATURE_LENGTH}-character base64url Ed25519 signature"));
    }

    Ok(BoxMessage::Auth { signature })
}

fn read_progress(value: &Value, path: &str) -> Read<BoxMessage> {
    let record = read_object(value, path, &["type", "jobId", "line"], &[])?;

    Ok(BoxMessage::Progress {
        job_id: read_id(field(record, "jobId"), &format!("{path}.jobId"))?,
        line: read_text(field(record, "line"), &format!("{path}.line"), LIMITS.max_line_bytes)?,
    })
}

fn read_result(value: &Value, path: &str) -> Read<BoxMessage> {
    let record = read_object(value, path, &["type", "jobId", "ok"], &["url", "error"])?;
    let job_id = read_id(field(record, "jobId"), &format!("{path}.jobId"))?;
    let ok = read_boolean(field(record, "ok"), &format!("{path}.ok"))?;
    let url = match record.get("url") {
        Some(value) => Some(read_url(value, &format!("{path}.url"))?),
        None => None,
    };
    let error_path = format!("{path}.error");
    let error = match record.get("error") {
        Some(_) if ok => return fail(&error_path, "must be absent when ok is true"),
        Some(value) => Some(read_error_detail(value, &error_path)?),
        None if !ok => return fail(&error_path, "is required when ok is false"),
        None => None,
    };

    Ok(BoxMessage::Result(ResultMessage { error, job_id, ok, url }))
}

fn read_alias_report(value: &Value, path: &str) -> Read<AliasReport> {
    let record = read_object(value, path, &["alias", "requests", "errors"], &["p50Ms"])?;
    let alias = read_alias(field(record, "alias"), &format!("{path}.alias"))?;
    let errors = read_integer(field(record, "errors"), &format!("{path}.errors"), 0)?;
    let requests = read_integer(field(record, "requests"), &format!("{path}.requests"), 0)?;

    if errors > requests {
        return fail(&format!("{path}.errors"), "must not exceed requests");
    }

    let p50_ms = match record.get("p50Ms") {
        Some(value) => Some(read_non_negative_number(value, &format!("{path}.p50Ms"))?),
        None => None,
    };

    Ok(AliasReport { alias, errors, p50_ms, requests })
}

fn read_report(value: &Value, path: &str) -> Read<BoxMessage> {
    let record = read_object(value, path, &["type", "windowStart", "windowEnd", "perAlias"], &[])?;
    let window_start = read_integer(field(record, "windowStart"), &format!("{path}.windowStart"), 0)?;
    let window_end = read_integer(field(record, "windowEnd"), &format!("{path}.windowEnd"), 0)?;

    if window_end < window_start {
        return fail(&format!("{path}.windowEnd"), "must not be before windowStart");
    }

    let per_alias_path = format!("{path}.perAlias");
    let per_alias = read_array(field(record, "perAlias"), &per_alias_path, LIMITS.max_report_aliases)?
        .iter()
        .enumerate()
        .map(|(index, entry)| read_alias_report(entry, &format!("{per_alias_path}[{index}]")))
        .collect::<Read<Vec<_>>>()?;

    assert_unique(per_alias.iter().map(|entry| entry.alias.as_str()), &per_alias_path, "alias")?;

    Ok(BoxMessage::Report(ReportMessage { per_alias, window_end, window_start }))
}

fn read_variables(value: &Value, path: &str) -> Read<IndexMap<String, String>> {
    let Value::Object(record) = value else {
        return fail(path, "must be an object");
    };
    let mut variables = IndexMap::new();

    for name in js_key_order(record) {
        let entry_path = format!("{path}.{name}");

        // `__proto__` matches the pattern but would replace an object's prototype in the reference.
        if name == "__proto__" || !is_var_name(name) {
            return fail(&entry_path, "must be named like an environment variable ([A-Za-z_][A-Za-z0-9_]*, at most 256 characters)");
        }

        variables.insert(name.clone(), read_string(field(record, name), &entry_path)?.to_owned());
    }

    Ok(variables)
}

/// A cron expression must not be blank, as JavaScript's `trim` decides it (which also strips a BOM).
fn is_blank(text: &str) -> bool {
    text.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}').is_empty()
}

fn read_deploy_job(value: &Value, path: &str) -> Read<HostdJob> {
    let record = read_object(value, path, &["kind", "alias", "deploymentId", "releaseUrl", "vars", "crons"], &["compatibilityDate"])?;
    let alias = read_alias(field(record, "alias"), &format!("{path}.alias"))?;
    let crons_path = format!("{path}.crons");
    let crons = read_array(field(record, "crons"), &crons_path, LIMITS.max_crons)?
        .iter()
        .enumerate()
        .map(|(index, cron)| {
            let cron_path = format!("{crons_path}[{index}]");
            let expression = read_string(cron, &cron_path)?;

            if is_blank(expression) || js_length(expression) > MAX_CRON_LENGTH {
                return fail(&cron_path, &format!("must be a non-blank cron expression of at most {MAX_CRON_LENGTH} characters"));
            }

            Ok(expression.to_owned())
        })
        .collect::<Read<Vec<_>>>()?;
    let deployment_id = read_id(field(record, "deploymentId"), &format!("{path}.deploymentId"))?;
    let release_url = read_url(field(record, "releaseUrl"), &format!("{path}.releaseUrl"))?;
    let vars = read_variables(field(record, "vars"), &format!("{path}.vars"))?;
    let compatibility_date = match record.get("compatibilityDate") {
        Some(value) => Some(read_matching(value, &format!("{path}.compatibilityDate"), is_date, "a YYYY-MM-DD date")?),
        None => None,
    };

    Ok(HostdJob::Deploy(DeployJob { alias, compatibility_date, crons, deployment_id, release_url, vars }))
}

fn read_destroy_job(value: &Value, path: &str) -> Read<HostdJob> {
    let record = read_object(value, path, &["kind", "alias", "deleteData"], &[])?;

    Ok(HostdJob::Destroy {
        alias: read_alias(field(record, "alias"), &format!("{path}.alias"))?,
        delete_data: read_boolean(field(record, "deleteData"), &format!("{path}.deleteData"))?,
    })
}

fn read_reload_job(value: &Value, path: &str) -> Read<HostdJob> {
    let record = read_object(value, path, &["kind", "alias"], &[])?;

    Ok(HostdJob::Reload { alias: read_alias(field(record, "alias"), &format!("{path}.alias"))? })
}

fn read_upgrade_job(value: &Value, path: &str) -> Read<HostdJob> {
    let record = read_object(value, path, &["kind", "releaseId", "manifestUrl"], &["allowDowngrade"])?;
    let allow_downgrade = match record.get("allowDowngrade") {
        Some(value) => Some(read_boolean(value, &format!("{path}.allowDowngrade"))?),
        None => None,
    };

    Ok(HostdJob::Upgrade(UpgradeJob {
        allow_downgrade,
        manifest_url: read_url(field(record, "manifestUrl"), &format!("{path}.manifestUrl"))?,
        release_id: read_id(field(record, "releaseId"), &format!("{path}.releaseId"))?,
    }))
}

fn read_job(value: &Value, path: &str) -> Read<HostdJob> {
    let Value::Object(record) = value else {
        return fail(path, "must be an object");
    };

    match record.get("kind").and_then(Value::as_str) {
        Some("deploy") => read_deploy_job(value, path),
        Some("destroy") => read_destroy_job(value, path),
        Some("diagnose") => {
            read_object(value, path, &["kind"], &[])?;

            Ok(HostdJob::Diagnose)
        }
        Some("reload") => read_reload_job(value, path),
        Some("upgrade") => read_upgrade_job(value, path),
        _ => fail(&format!("{path}.kind"), &format!("must be one of {JOB_KINDS}")),
    }
}

fn read_route(value: &Value, path: &str) -> Read<RouteEntry> {
    let record = read_object(value, path, &["hostname", "alias"], &[])?;

    Ok(RouteEntry {
        alias: read_alias(field(record, "alias"), &format!("{path}.alias"))?,
        hostname: read_hostname(field(record, "hostname"), &format!("{path}.hostname"))?,
    })
}

fn read_telemetry(value: &Value, path: &str) -> Read<TelemetryConfig> {
    let record = read_object(value, path, &["endpoint", "token"], &[])?;
    let token_path = format!("{path}.token");
    let token = read_string(field(record, "token"), &token_path)?;

    if token.len() > LIMITS.max_token_length || !is_token(token) {
        return fail(&token_path, &format!("must be 1-{} printable ASCII characters without spaces", LIMITS.max_token_length));
    }

    Ok(TelemetryConfig { endpoint: read_url(field(record, "endpoint"), &format!("{path}.endpoint"))?, token: token.to_owned() })
}

/// The reader for a frame a box sends, by `type`.
pub fn read_box_message(kind: &str, value: &Value, path: &str) -> Option<Read<BoxMessage>> {
    Some(match kind {
        "auth" => read_auth(value, path),
        "hello" => read_hello(value, path).map(BoxMessage::Hello),
        "pong" => read_object(value, path, &["type"], &[]).map(|_| BoxMessage::Pong),
        "progress" => read_progress(value, path),
        "report" => read_report(value, path),
        "result" => read_result(value, path),
        _ => return None,
    })
}

/// The box → cloud types, in the order the reference lists them.
pub const BOX_TYPES: &str = "auth, hello, pong, progress, report, result";

/// The reader for a frame the control plane sends, by `type`.
pub fn read_cloud_message(kind: &str, value: &Value, path: &str) -> Option<Read<CloudMessage>> {
    Some(match kind {
        "challenge" => read_object(value, path, &["type", "nonce"], &[])
            .and_then(|record| Ok(CloudMessage::Challenge { nonce: read_nonce(field(record, "nonce"), &format!("{path}.nonce"))? })),
        "config" => read_object(value, path, &["type"], &["telemetry"]).and_then(|record| {
            Ok(CloudMessage::Config {
                telemetry: match record.get("telemetry") {
                    Some(value) => Some(read_telemetry(value, &format!("{path}.telemetry"))?),
                    None => None,
                },
            })
        }),
        "error" => read_object(value, path, &["type", "code", "message"], &[]).and_then(|record| {
            let detail =
                Value::Object(Map::from_iter([("code".to_owned(), field(record, "code").clone()), ("message".to_owned(), field(record, "message").clone())]));
            let ErrorDetail { code, message } = read_error_detail(&detail, path)?;

            Ok(CloudMessage::Error { code, message })
        }),
        "job" => read_object(value, path, &["type", "jobId", "job"], &[]).and_then(|record| {
            Ok(CloudMessage::Job {
                job: read_job(field(record, "job"), &format!("{path}.job"))?,
                job_id: read_id(field(record, "jobId"), &format!("{path}.jobId"))?,
            })
        }),
        "ping" => read_object(value, path, &["type"], &[]).map(|_| CloudMessage::Ping),
        "routes" => read_object(value, path, &["type", "table"], &[]).and_then(|record| {
            let table_path = format!("{path}.table");
            let table = read_array(field(record, "table"), &table_path, LIMITS.max_routes)?
                .iter()
                .enumerate()
                .map(|(index, entry)| read_route(entry, &format!("{table_path}[{index}]")))
                .collect::<Read<Vec<_>>>()?;

            assert_unique(table.iter().map(|entry| entry.hostname.as_str()), &table_path, "hostname")?;

            Ok(CloudMessage::Routes { table })
        }),
        _ => return None,
    })
}

/// The cloud → box types, in the order the reference lists them.
pub const CLOUD_TYPES: &str = "challenge, config, error, job, ping, routes";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostnames() {
        assert!(is_hostname("my-app.box-1.boxes.lunora.app"));
        assert!(is_hostname("a"));
        assert!(!is_hostname("A.example"));
        assert!(!is_hostname("example.com."));
        assert!(!is_hostname("-a.example"));
        assert!(!is_hostname("a-.example"));
        assert!(!is_hostname("10.0.0.1"));
        assert!(!is_hostname(&format!("{}.com", "a".repeat(64))));
    }

    #[test]
    fn aliases() {
        assert!(is_alias("my-app"));
        assert!(is_alias("a1"));
        assert!(!is_alias("my--app"));
        assert!(!is_alias("-app"));
        assert!(!is_alias("app-"));
        assert!(!is_alias("App"));
        assert!(!is_alias(&"a".repeat(64)));
    }

    #[test]
    fn integers_as_javascript_reads_them() {
        assert_eq!(read_integer(&serde_json::json!(2.0), "$", 0), Ok(2));
        assert_eq!(read_integer(&serde_json::json!(-0.0), "$", 0), Ok(0));
        assert!(read_integer(&serde_json::json!(1.5), "$", 0).is_err());
        assert!(read_integer(&serde_json::json!(9_007_199_254_740_992_u64), "$", 0).is_err());
        assert_eq!(read_integer(&serde_json::json!(9_007_199_254_740_991_u64), "$", 0), Ok(9_007_199_254_740_991));
        assert!(read_integer(&serde_json::json!(0), "$", 1).is_err());
    }

    #[test]
    fn keys_in_javascript_order() {
        let value: Value = serde_json::from_str(r#"{"b":1,"10":2,"a":3,"2":4}"#).unwrap();
        let Value::Object(record) = value else { unreachable!() };

        assert_eq!(js_key_order(&record), ["2", "10", "b", "a"]);
    }
}
