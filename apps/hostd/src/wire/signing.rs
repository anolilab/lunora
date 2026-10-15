//! The bytes a box signs (protocol §6): the challenge answer (`auth`) and a
//! signed HTTP request (release fetch, D6). Each starts with its own domain
//! tag, so a signature made for one can never be replayed as the other. The
//! signature itself is the identity's job (`daemon::identity`).

use super::validate::{is_nonce, is_protocol_id};

pub const AUTH_DOMAIN: &str = "lunora-hostd-auth:v1";

pub const REQUEST_DOMAIN: &str = "lunora-hostd-request:v1";

/// The headers a signed request carries its fields in (§6.2).
pub const HEADER_BOX_ID: &str = "x-lunora-box-id";
pub const HEADER_NONCE: &str = "x-lunora-box-nonce";
pub const HEADER_SIGNATURE: &str = "x-lunora-box-signature";
pub const HEADER_TIMESTAMP: &str = "x-lunora-box-timestamp";

const MAX_PATH_LENGTH: usize = 2048;

fn check_ids(box_id: &str, nonce: &str) -> Result<(), String> {
    if !is_protocol_id(box_id) {
        return Err("boxId must be 1-128 characters of [A-Za-z0-9_-]".to_owned());
    }

    if !is_nonce(nonce) {
        return Err("nonce must be 22-128 base64url characters".to_owned());
    }

    Ok(())
}

/// `lunora-hostd-auth:v1:{boxId}:{nonce}` (§6.1). `:` is unambiguous: neither field can hold one.
pub fn challenge_payload(nonce: &str, box_id: &str) -> Result<Vec<u8>, String> {
    check_ids(box_id, nonce)?;

    Ok(format!("{AUTH_DOMAIN}:{box_id}:{nonce}").into_bytes())
}

/// An origin-form request target: `/`, then printable ASCII without spaces or `#`, at most 2048 characters.
fn is_origin_form_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= MAX_PATH_LENGTH && path.bytes().all(|byte| byte > 0x20 && byte <= 0x7e && byte != b'#')
}

/// The six lines a signed request covers (§6.2), joined by `\n`, no trailing newline.
pub fn request_payload(method: &str, path: &str, box_id: &str, timestamp: u64, nonce: &str) -> Result<Vec<u8>, String> {
    if !(1..=16).contains(&method.len()) || !method.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err("method must be an upper-case HTTP method".to_owned());
    }

    if !is_origin_form_path(path) {
        return Err("path must be an origin-form request target: '/' then printable ASCII, no '#', at most 2048 characters".to_owned());
    }

    check_ids(box_id, nonce)?;

    Ok([REQUEST_DOMAIN, method, path, box_id, &timestamp.to_string(), nonce].join("\n").into_bytes())
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn builds_the_golden_payloads_byte_for_byte() {
        let fixtures: Value = serde_json::from_str(include_str!("../../../../protocol/hostd/fixtures/messages.json")).unwrap();
        let signing = &fixtures["signing"];
        let challenge = &signing["challenge"];

        assert_eq!(
            challenge_payload(challenge["nonce"].as_str().unwrap(), challenge["boxId"].as_str().unwrap()).unwrap(),
            challenge["payload"].as_str().unwrap().as_bytes()
        );

        for name in ["request", "request-with-query"] {
            let case = &signing[name];
            let payload = request_payload(
                case["method"].as_str().unwrap(),
                case["path"].as_str().unwrap(),
                case["boxId"].as_str().unwrap(),
                case["timestamp"].as_u64().unwrap(),
                case["nonce"].as_str().unwrap(),
            )
            .unwrap();

            assert_eq!(payload, case["payload"].as_str().unwrap().as_bytes(), "{name}");
        }
    }

    #[test]
    fn refuses_fields_that_could_break_the_payload() {
        assert!(challenge_payload("short", "box_1").is_err());
        assert!(challenge_payload("c2VydmVyLW5vbmNlLTEyOC1iaXRz", "box:1").is_err());
        assert!(request_payload("get", "/", "box_1", 1, "c2VydmVyLW5vbmNlLTEyOC1iaXRz").is_err());
        assert!(request_payload("GET", "/a b", "box_1", 1, "c2VydmVyLW5vbmNlLTEyOC1iaXRz").is_err());
        assert!(request_payload("GET", "/a#b", "box_1", 1, "c2VydmVyLW5vbmNlLTEyOC1iaXRz").is_err());
        assert!(request_payload("GET", "relative", "box_1", 1, "c2VydmVyLW5vbmNlLTEyOC1iaXRz").is_err());
    }
}
