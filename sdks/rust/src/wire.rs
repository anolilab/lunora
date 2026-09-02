//! The tagged value codec for Lunora's client↔server wire, ported from
//! `shared/wire-codec.ts`.
//!
//! The wire is JSON with no reviver; values JSON cannot carry (big integers,
//! bytes, dates, maps/sets, ±Infinity/NaN, `undefined` in an array position)
//! become self-delimiting tagged arrays whose first element is [`TAG`].
//! Pure-JSON values encode to a structurally identical tree.
//!
//! Rust's enum makes this port the most faithful of the set: [`WireValue`] can
//! represent every wire shape exactly, so `encode(decode(x)) == x` is a total
//! function rather than a convention. Big integers keep their decimal digits as
//! a `String` — no stdlib arbitrary-precision integer exists, and narrowing to
//! `i64` would cap the range at 2^63 and silently corrupt anything larger,
//! which is exactly what `v.bigint()` exists to prevent.
//!
//! See `protocol/README.md` §2 for the normative grammar.

use std::collections::HashMap;
use std::fmt;

use serde_json::{Map, Number, Value};

/// Marks a JSON array as a tagged wire value. An array is significant to the
/// codec only when its first element is exactly this string.
pub const TAG: &str = "$lunora.wire$";

/// Bounds recursion so a hostile deeply-nested payload cannot exhaust the stack.
pub const MAX_DEPTH: usize = 64;

/// Bounds a decoded big integer. Decimal parsing is superlinear, so an
/// unbounded digit string from an untrusted peer is a denial of service.
/// Applied only on decode — the untrusted direction.
pub const MAX_BIGINT_DIGITS: usize = 1024;

/// Bytes per element for the typed-array views the codec round-trips. A view
/// whose payload is not a whole number of elements is not a view the reference
/// can rebuild — `new Float32Array(buffer)` raises a `RangeError` there — so
/// accepting it would hand the consumer bytes it cannot reconstruct.
/// `ArrayBuffer` is absent deliberately: it is untyped, so nothing to align.
const TYPED_ARRAY_ELEMENT_SIZES: &[(&str, usize)] = &[
    ("BigInt64Array", 8),
    ("BigUint64Array", 8),
    ("Float32Array", 4),
    ("Float64Array", 8),
    ("Int16Array", 2),
    ("Int32Array", 4),
    ("Int8Array", 1),
    ("Uint16Array", 2),
    ("Uint32Array", 4),
    ("Uint8Array", 1),
    ("Uint8ClampedArray", 1),
];

/// Every value the Lunora wire can carry.
///
/// `Undefined` is distinct from `Null`: as an object field it is dropped on
/// encode (matching `JSON.stringify`), but in an array position it is preserved,
/// because dropping it there would silently shift every later element.
#[derive(Clone, Debug, PartialEq)]
pub enum WireValue {
    Null,
    Undefined,
    Bool(bool),
    /// A finite JSON number. NaN and ±Infinity have their own variants because
    /// JSON cannot carry them.
    Number(f64),
    NaN,
    Infinity,
    NegInfinity,
    String(String),
    /// A `v.bigint()`, as decimal digits — see the module docs for why.
    BigInt(String),
    /// A `Date`, as epoch milliseconds. An invalid Date carries `f64::NAN`.
    Date(Box<WireValue>),
    Url(String),
    Array(Vec<WireValue>),
    Object(Vec<(String, WireValue)>),
    /// Ordered pairs whose keys may be non-string, which is why a map type
    /// cannot represent it.
    Map(Vec<(WireValue, WireValue)>),
    Set(Vec<WireValue>),
    /// A plain `Uint8Array`: raw bytes, 2-element wire form.
    Bytes(Vec<u8>),
    /// Any other typed-array view, carrying its constructor name so the exact
    /// view type survives.
    TypedBytes {
        data: Vec<u8>,
        ctor: String,
    },
    Error {
        name: String,
        message: String,
        props: Vec<(String, WireValue)>,
        cause: Option<Box<WireValue>>,
    },
}

#[derive(Debug, PartialEq)]
pub enum WireError {
    DepthExceeded,
    InvalidBigInt,
    Malformed(&'static str),
}

impl fmt::Display for WireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WireError::DepthExceeded => write!(formatter, "wire-codec: value nesting exceeds the {MAX_DEPTH}-level limit"),
            WireError::InvalidBigInt => {
                write!(formatter, "wire-codec: invalid or over-long bigint (max {MAX_BIGINT_DIGITS} digits)")
            }
            WireError::Malformed(tag) => write!(formatter, "wire-codec: malformed {tag} tag"),
        }
    }
}

impl std::error::Error for WireError {}

type WireResult<T> = Result<T, WireError>;

fn tagged(parts: Vec<Value>) -> Value {
    Value::Array(parts)
}

fn tag_value() -> Value {
    Value::String(TAG.to_string())
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[(triple >> 18 & 0x3F) as usize] as char);
        out.push(ALPHABET[(triple >> 12 & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6 & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 { ALPHABET[(triple & 0x3F) as usize] as char } else { '=' });
    }

    out
}

/// Decode base64 exactly as the reference does.
///
/// The reference decodes through `atob`, i.e. WHATWG "forgiving base64": ASCII
/// whitespace is stripped, up to two `=` are removed from the end of a
/// multiple-of-four input, and a remaining length of 1 mod 4 — or any other
/// character outside the alphabet — is a hard error.
///
/// The first version of this function skipped `=`, `\n` and `\r` wherever they
/// appeared and discarded the trailing bits, so `"AQIDA"` (a truncated payload)
/// and `"AQ=ID"` (a corrupted one) both decoded to a perfectly ordinary
/// `[1, 2, 3]`. Seven ports rejected both; this one handed short, valid-looking
/// bytes to application code, which is the single outcome the `bytes` tag
/// exists to prevent.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    // `atob` removes ASCII whitespace before doing anything else, so a payload
    // wrapped across lines decodes here too — that leniency IS the reference's.
    let cleaned: Vec<u8> = text.bytes().filter(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\x0C' | b'\r')).collect();

    let mut end = cleaned.len();

    // Padding is only padding at the end of a whole quantum. An `=` anywhere
    // else stays in `body` and is rejected by the alphabet match below.
    if end.is_multiple_of(4) {
        for _ in 0..2 {
            if end > 0 && cleaned[end - 1] == b'=' {
                end -= 1;
            } else {
                break;
            }
        }
    }

    let body = &cleaned[..end];

    // A single leftover character carries 6 bits: not a byte, and not a
    // legitimate encoding of anything. This is the check that makes a truncated
    // payload an error instead of a shorter one.
    if body.len() % 4 == 1 {
        return None;
    }

    let mut accumulator: u32 = 0;
    let mut bits = 0;
    let mut out = Vec::with_capacity(body.len() / 4 * 3);

    for &byte in body {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;

        accumulator = (accumulator << 6) | value;
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
        }
    }

    Some(out)
}

/// The largest integer an `f64` holds exactly (2^53 - 1). JSON numbers are
/// `f64`, so an integer past this cannot cross the wire as a number without
/// changing value — `v.bigint()` and its tag exist for that case.
pub const MAX_EXACT_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A finite `f64` onto the wire.
///
/// An integral value is written as a JSON integer, because that is what the
/// reference writes: `JSON.stringify(1)` is `1`, while serialising through
/// `f64` alone spelled it `1.0`. Nothing caught the difference, because the
/// conformance comparison normalises both sides through `stable_stringify`,
/// which formats numbers the ECMAScript way — so the two sides agreed on the
/// comparison and disagreed on the bytes actually sent.
fn encode_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= MAX_EXACT_INTEGER {
        // `-0.0` lands here as `0`, matching `JSON.stringify(-0) === "0"`.
        return Value::Number(Number::from(value as i64));
    }

    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// Encode a [`WireValue`] into a JSON tree, tagging the leaves JSON cannot carry.
pub fn encode_wire(value: &WireValue) -> WireResult<Value> {
    encode_at(value, 0)
}

fn encode_at(value: &WireValue, depth: usize) -> WireResult<Value> {
    if depth > MAX_DEPTH {
        return Err(WireError::DepthExceeded);
    }

    Ok(match value {
        WireValue::Null => Value::Null,
        WireValue::Undefined => tagged(vec![tag_value(), Value::String("undefined".into())]),
        WireValue::Bool(inner) => Value::Bool(*inner),
        WireValue::NaN => tagged(vec![tag_value(), Value::String("nan".into())]),
        WireValue::Infinity => tagged(vec![tag_value(), Value::String("inf".into())]),
        WireValue::NegInfinity => tagged(vec![tag_value(), Value::String("-inf".into())]),
        WireValue::Number(inner) => encode_number(*inner),
        WireValue::String(inner) => Value::String(inner.clone()),
        WireValue::BigInt(digits) => tagged(vec![tag_value(), Value::String("bigint".into()), Value::String(digits.clone())]),
        WireValue::Date(epoch) => tagged(vec![tag_value(), Value::String("date".into()), encode_at(epoch, depth + 1)?]),
        WireValue::Url(href) => tagged(vec![tag_value(), Value::String("url".into()), Value::String(href.clone())]),
        WireValue::Array(items) => {
            let encoded: Vec<Value> = items.iter().map(|item| encode_at(item, depth + 1)).collect::<WireResult<_>>()?;

            // Escape a user array whose first element is literally the sentinel,
            // or the decoder would mistake it for a tagged value.
            if encoded.first() == Some(&tag_value()) {
                tagged(vec![tag_value(), Value::String("arr".into()), Value::Array(encoded)])
            } else {
                Value::Array(encoded)
            }
        }
        WireValue::Object(fields) => {
            let mut object = Map::new();

            for (key, field) in fields {
                // Drop undefined fields, matching JSON.stringify, so a pure-JSON
                // object stays byte-identical across the codec.
                if matches!(field, WireValue::Undefined) {
                    continue;
                }

                object.insert(key.clone(), encode_at(field, depth + 1)?);
            }

            Value::Object(object)
        }
        WireValue::Map(entries) => {
            let encoded: Vec<Value> = entries
                .iter()
                .map(|(key, item)| Ok(Value::Array(vec![encode_at(key, depth + 1)?, encode_at(item, depth + 1)?])))
                .collect::<WireResult<_>>()?;

            tagged(vec![tag_value(), Value::String("map".into()), Value::Array(encoded)])
        }
        WireValue::Set(items) => {
            let encoded: Vec<Value> = items.iter().map(|item| encode_at(item, depth + 1)).collect::<WireResult<_>>()?;

            tagged(vec![tag_value(), Value::String("set".into()), Value::Array(encoded)])
        }
        WireValue::Bytes(data) => tagged(vec![tag_value(), Value::String("bytes".into()), Value::String(base64_encode(data))]),
        WireValue::TypedBytes { data, ctor } => tagged(vec![
            tag_value(),
            Value::String("bytes".into()),
            Value::String(base64_encode(data)),
            Value::String(ctor.clone()),
        ]),
        WireValue::Error { name, message, props, cause } => {
            let mut object = Map::new();

            for (key, item) in props {
                if matches!(item, WireValue::Undefined) {
                    continue;
                }

                object.insert(key.clone(), encode_at(item, depth + 1)?);
            }

            let mut parts = vec![
                tag_value(),
                Value::String("error".into()),
                Value::String(name.clone()),
                Value::String(message.clone()),
                Value::Object(object),
            ];

            // `cause` rides a positional slot; absent when unset, keeping the
            // 5-element form.
            if let Some(inner) = cause {
                if !matches!(**inner, WireValue::Undefined) {
                    parts.push(encode_at(inner, depth + 1)?);
                }
            }

            tagged(parts)
        }
    })
}

/// Inverse of [`encode_wire`]: revive tagged leaves into [`WireValue`].
pub fn decode_wire(value: &Value) -> WireResult<WireValue> {
    decode_at(value, 0)
}

fn decode_at(value: &Value, depth: usize) -> WireResult<WireValue> {
    if depth > MAX_DEPTH {
        return Err(WireError::DepthExceeded);
    }

    Ok(match value {
        Value::Null => WireValue::Null,
        Value::Bool(inner) => WireValue::Bool(*inner),
        Value::Number(inner) => WireValue::Number(inner.as_f64().unwrap_or(f64::NAN)),
        Value::String(inner) => WireValue::String(inner.clone()),
        Value::Array(items) => {
            if items.first() == Some(&tag_value()) {
                decode_tagged(items, depth)?
            } else {
                WireValue::Array(items.iter().map(|item| decode_at(item, depth + 1)).collect::<WireResult<_>>()?)
            }
        }
        Value::Object(fields) => WireValue::Object(
            fields
                .iter()
                .map(|(key, item)| Ok((key.clone(), decode_at(item, depth + 1)?)))
                .collect::<WireResult<Vec<_>>>()?,
        ),
    })
}

/// A map key's collapse identity, or `None` when it never collapses.
///
/// The reference's `Map` compares keys by SameValueZero: primitives by value
/// (`NaN` equal to itself), everything else by reference — so two structurally
/// identical `Date`/bytes keys stay two entries there and must stay two here.
fn map_key_identity(key: &WireValue) -> Option<String> {
    Some(match key {
        WireValue::Null => "null".to_owned(),
        WireValue::Undefined => "undefined".to_owned(),
        WireValue::Bool(value) => format!("bool:{value}"),
        WireValue::Number(value) => format!("num:{value}"),
        WireValue::NaN => "num:nan".to_owned(),
        WireValue::Infinity => "num:inf".to_owned(),
        WireValue::NegInfinity => "num:-inf".to_owned(),
        WireValue::String(value) => format!("str:{value}"),
        // The digits are carried verbatim, so `01` and `1` are one key to the
        // reference (`BigInt("01") === 1n`) and must be one here.
        WireValue::BigInt(digits) => format!("big:{}", normalise_bigint(digits)),
        _ => return None,
    })
}

/// Strip a bigint literal's leading zeros and a sign that only reaches zero.
fn normalise_bigint(digits: &str) -> String {
    let (sign, body) = match digits.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", digits),
    };
    let trimmed = body.trim_start_matches('0');

    if trimmed.is_empty() {
        return "0".to_owned();
    }

    format!("{sign}{trimmed}")
}

fn decode_tagged(items: &[Value], depth: usize) -> WireResult<WireValue> {
    let name = items.get(1).and_then(Value::as_str).unwrap_or("");

    Ok(match name {
        "undefined" => WireValue::Undefined,
        "nan" => WireValue::NaN,
        "inf" => WireValue::Infinity,
        "-inf" => WireValue::NegInfinity,
        "bigint" => {
            let raw = items.get(2).and_then(Value::as_str).ok_or(WireError::InvalidBigInt)?;

            if raw.len() > MAX_BIGINT_DIGITS || !is_bigint_literal(raw) {
                return Err(WireError::InvalidBigInt);
            }

            WireValue::BigInt(raw.to_string())
        }
        "date" => WireValue::Date(Box::new(decode_at(items.get(2).ok_or(WireError::Malformed("date"))?, depth + 1)?)),
        "url" => WireValue::Url(items.get(2).and_then(Value::as_str).ok_or(WireError::Malformed("url"))?.to_string()),
        "map" => {
            let raw = items.get(2).and_then(Value::as_array).ok_or(WireError::Malformed("map"))?;
            let mut entries: Vec<(WireValue, WireValue)> = Vec::with_capacity(raw.len());
            let mut seen: HashMap<String, usize> = HashMap::new();

            for pair in raw {
                let pair = pair.as_array().ok_or(WireError::Malformed("map entry"))?;

                let [key, item] = pair.as_slice() else {
                    return Err(WireError::Malformed("map entry"));
                };

                let key = decode_at(key, depth + 1)?;
                let item = decode_at(item, depth + 1)?;

                // Last write wins, at the FIRST occurrence's position — the
                // reference builds a real Map, and `Map.prototype.set` on a key
                // already present overwrites the value in place rather than
                // appending. Keeping both entries left two peers of one
                // deployment reading a different value from identical bytes.
                if let Some(identity) = map_key_identity(&key) {
                    if let Some(&index) = seen.get(&identity) {
                        entries[index] = (key, item);

                        continue;
                    }

                    seen.insert(identity, entries.len());
                }

                entries.push((key, item));
            }

            WireValue::Map(entries)
        }
        "set" => {
            let raw = items.get(2).and_then(Value::as_array).ok_or(WireError::Malformed("set"))?;

            WireValue::Set(raw.iter().map(|item| decode_at(item, depth + 1)).collect::<WireResult<_>>()?)
        }
        "error" => {
            // The props slot is NOT optional and NOT nullable: the reference
            // reads it with `Object.keys`, which throws on a null or missing
            // slot, so quietly substituting an empty map accepted a frame the
            // reference refuses.
            let props = match items.get(4) {
                Some(Value::Object(fields)) => fields
                    .iter()
                    .map(|(key, item)| Ok((key.clone(), decode_at(item, depth + 1)?)))
                    .collect::<WireResult<Vec<_>>>()?,
                None | Some(Value::Null) => return Err(WireError::Malformed("error")),
                Some(_) => Vec::new(),
            };

            WireValue::Error {
                name: items.get(2).and_then(Value::as_str).unwrap_or("").to_string(),
                message: items.get(3).and_then(Value::as_str).unwrap_or("").to_string(),
                props,
                cause: match items.get(5) {
                    Some(inner) => Some(Box::new(decode_at(inner, depth + 1)?)),
                    None => None,
                },
            }
        }
        "bytes" => {
            let encoded = items.get(2).and_then(Value::as_str).ok_or(WireError::Malformed("bytes"))?;
            let data = base64_decode(encoded).ok_or(WireError::Malformed("bytes"))?;
            let ctor = items.get(3).and_then(Value::as_str).unwrap_or("Uint8Array");

            // A plain Uint8Array re-encodes to the 2-element form; every other
            // view keeps its constructor name.
            if ctor == "Uint8Array" {
                WireValue::Bytes(data)
            } else if ctor == "ArrayBuffer" {
                WireValue::TypedBytes { data, ctor: ctor.to_string() }
            } else {
                match TYPED_ARRAY_ELEMENT_SIZES.iter().find(|(name, _)| *name == ctor) {
                    // An UNKNOWN ctor name decodes to raw bytes, dropping the
                    // name — the forward-compat rule in protocol/README.md §2.1.
                    // Keeping it re-encoded a 4-element form the reference emits
                    // as 3, so the same value relayed through JS and through here
                    // produced different bytes, and therefore different stable
                    // subscription keys.
                    None => WireValue::Bytes(data),
                    Some((_, size)) if data.len() % size != 0 => return Err(WireError::Malformed("typed-array bytes")),
                    Some(_) => WireValue::TypedBytes { data, ctor: ctor.to_string() },
                }
            }
        }
        "arr" => {
            let raw = items.get(2).and_then(Value::as_array).ok_or(WireError::Malformed("arr"))?;

            WireValue::Array(raw.iter().map(|item| decode_at(item, depth + 1)).collect::<WireResult<_>>()?)
        }
        // Unknown tag (forward compatibility): an ordinary array.
        _ => WireValue::Array(items.iter().map(|item| decode_at(item, depth + 1)).collect::<WireResult<_>>()?),
    })
}

/// Whether `number` is an integer an `f64` cannot hold exactly.
///
/// Only integers — a float like `1e300` is a perfectly good JSON number and is
/// left alone; it is the integer that changes VALUE when narrowed.
fn is_inexact_integer(number: &Number) -> bool {
    const LIMIT: i64 = 9_007_199_254_740_991;

    if let Some(value) = number.as_i64() {
        return !(-LIMIT..=LIMIT).contains(&value);
    }

    if let Some(value) = number.as_u64() {
        return value > LIMIT as u64;
    }

    false
}

/// Whether `raw` is an optionally-negative run of ASCII digits. Deliberately not
/// a regex: this runs on untrusted input on every decode.
fn is_bigint_literal(raw: &str) -> bool {
    let body = raw.strip_prefix('-').unwrap_or(raw);

    !body.is_empty() && body.bytes().all(|byte| byte.is_ascii_digit())
}

/// A generated list of paths into a model, each a run of keys from its root.
///
/// `*` stands for every element of an array or every value of a record, neither
/// of which has a named position.
pub type WirePaths<'a> = &'a [&'a [&'a str]];

/// Project a generated model's serde output onto the wire, dropping a null ONLY
/// where the schema says the property is optional.
///
/// quicktype's Rust backend renders an optional field as `Option<T>` with no
/// `skip_serializing_if`, so an unset one serialises as an explicit null — while
/// `v.optional(x)` parses `undefined`-or-`x` and REJECTS null, failing validation
/// on the server for every call that leaves an optional unset.
///
/// Dropping every null was the first fix, and it was wrong in the other
/// direction: a required `v.nullable()` set to null has to reach the wire AS
/// null, because the validator requires the key present, and a null inside a
/// record or an array is a value the caller chose. Nothing in the rendered struct
/// tells the three apart — each is a bare `Option<T>` — so `optional_paths`
/// carries the answer from the schema, where `required` still exists. The
/// generated call site passes it; see `ModelNullPaths` in
/// `packages/codegen/src/sdk/spec.ts`.
pub fn from_model_json(value: &Value, optional_paths: WirePaths) -> WireValue {
    let mut path: Vec<&str> = Vec::new();

    prune_unset(value, optional_paths, &mut path)
}

/// Whether `path` matches one of `paths`, where a `*` segment matches any key.
fn matches_path(paths: WirePaths, path: &[&str]) -> bool {
    paths
        .iter()
        .any(|candidate| candidate.len() == path.len() && candidate.iter().zip(path.iter()).all(|(segment, actual)| *segment == "*" || segment == actual))
}

fn prune_unset<'a>(value: &'a Value, optional_paths: WirePaths, path: &mut Vec<&'a str>) -> WireValue {
    match value {
        Value::Array(items) => {
            // No element is ever dropped — an array position is not optional, and
            // removing one would shift every later element.
            path.push("*");

            let mut out = Vec::with_capacity(items.len());

            for item in items {
                out.push(prune_unset(item, optional_paths, path));
            }

            path.pop();

            WireValue::Array(out)
        }
        Value::Object(fields) => {
            let mut out = Vec::with_capacity(fields.len());

            for (key, item) in fields {
                path.push(key.as_str());

                if !(item.is_null() && matches_path(optional_paths, path)) {
                    out.push((key.clone(), prune_unset(item, optional_paths, path)));
                }

                path.pop();
            }

            WireValue::Object(out)
        }
        other => from_json(other),
    }
}

/// Convert a plain `serde_json::Value` — such as a generated model serialised
/// through serde — into a [`WireValue`] tree.
///
/// Safe as a plain structural mapping because a generated model can never
/// contain a wire wrapper: the generator refuses to emit a typed model for any
/// schema carrying a `v.bigint()` or `v.bytes()`, which are exactly the values
/// this conversion could not represent.
pub fn from_json(value: &Value) -> WireValue {
    match value {
        Value::Null => WireValue::Null,
        Value::Bool(inner) => WireValue::Bool(*inner),
        // An i64/u64 past the exact-f64 range keeps its digits as a bigint
        // rather than being narrowed. `as_f64` alone rounded it silently, so a
        // generated model holding 9007199254740993 sent 9007199254740992 and
        // nothing on either end could tell. A bigint tag against a `v.number()`
        // field is a validation error the server reports; a wrong number is not.
        Value::Number(inner) if is_inexact_integer(inner) => WireValue::BigInt(inner.to_string()),
        Value::Number(inner) => WireValue::Number(inner.as_f64().unwrap_or(f64::NAN)),
        Value::String(inner) => WireValue::String(inner.clone()),
        Value::Array(items) => WireValue::Array(items.iter().map(from_json).collect()),
        Value::Object(fields) => WireValue::Object(fields.iter().map(|(key, item)| (key.clone(), from_json(item))).collect()),
    }
}
