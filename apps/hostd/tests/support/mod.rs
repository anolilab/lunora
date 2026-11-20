//! What the black-box tests share: a fake control plane, the fake celld and
//! Caddy, a test box, the daemon as a process, test releases and TLS.

// Each test crate compiles this module on its own and uses part of it.
#![allow(dead_code)]

pub mod fakes;
pub mod hostd;
pub mod lane;
pub mod plane;
pub mod release;
pub mod test_box;
pub mod tls;

use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// A string field that must match `pattern`, inside an [`assert_matches`] expectation (vitest's `stringMatching`).
pub fn re(pattern: &str) -> Value {
    json!({ "$regex": pattern })
}

/// Why `actual` does not match `expected` (vitest's `toMatchObject`): an object matches when every expected key
/// matches, an array when it has the same length and each element matches, a [`re`] when the string matches it.
pub fn mismatch(actual: &Value, expected: &Value, path: &str) -> Option<String> {
    match expected {
        Value::Object(fields) if fields.len() == 1 && fields.contains_key("$regex") => {
            let pattern = regex::Regex::new(fields["$regex"].as_str().unwrap()).unwrap();

            match actual.as_str() {
                Some(text) if pattern.is_match(text) => None,
                _ => Some(format!("{path}: {actual} does not match /{pattern}/")),
            }
        }
        Value::Object(fields) => {
            let Some(object) = actual.as_object() else { return Some(format!("{path}: {actual} is not an object")) };

            fields.iter().find_map(|(key, value)| match object.get(key) {
                Some(found) => mismatch(found, value, &format!("{path}.{key}")),
                None => Some(format!("{path}.{key} is missing")),
            })
        }
        Value::Array(items) => {
            let Some(array) = actual.as_array().filter(|array| array.len() == items.len()) else {
                return Some(format!("{path}: {actual} does not have {} elements", items.len()));
            };

            array.iter().zip(items).enumerate().find_map(|(index, (found, item))| mismatch(found, item, &format!("{path}[{index}]")))
        }
        _ => (actual != expected).then(|| format!("{path}: {actual} is not {expected}")),
    }
}

/// Whether `actual` matches `expected`, as [`mismatch`] decides.
pub fn matches(actual: &Value, expected: &Value) -> bool {
    mismatch(actual, expected, "$").is_none()
}

/// Assert `actual` matches `expected` (vitest's `toMatchObject`).
#[track_caller]
pub fn assert_matches(actual: &Value, expected: &Value) {
    if let Some(reason) = mismatch(actual, expected, "$") {
        panic!("{reason}\nactual: {actual:#}");
    }
}

/// Poll `read` until `done` accepts its value or `timeout` passes; the last value (vitest's `expect.poll`).
pub fn poll<T>(timeout: Duration, mut read: impl FnMut() -> T, done: impl Fn(&T) -> bool) -> T {
    let deadline = Instant::now() + timeout;

    loop {
        let value = read();

        if done(&value) || Instant::now() >= deadline {
            return value;
        }

        std::thread::sleep(Duration::from_millis(50));
    }
}

/// How long [`poll`] waits by default.
pub const POLL: Duration = Duration::from_secs(5);

/// A file's permission bits.
pub fn permissions_of(path: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}
