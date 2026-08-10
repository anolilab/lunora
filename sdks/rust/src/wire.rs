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
    TypedBytes { data: Vec<u8>, ctor: String },
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
        out.push(if chunk.len() > 1 { ALPHABET[(triple >> 6 & 0x3F) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(triple & 0x3F) as usize] as char } else { '=' });
    }

    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut accumulator: u32 = 0;
    let mut bits = 0;
    let mut out = Vec::with_capacity(text.len() / 4 * 3);

    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' => continue,
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
        WireValue::Number(inner) => Number::from_f64(*inner).map_or(Value::Null, Value::Number),
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
            let mut entries = Vec::with_capacity(raw.len());

            for pair in raw {
                let pair = pair.as_array().ok_or(WireError::Malformed("map entry"))?;
                let key = pair.first().ok_or(WireError::Malformed("map entry"))?;
                let item = pair.get(1).ok_or(WireError::Malformed("map entry"))?;

                entries.push((decode_at(key, depth + 1)?, decode_at(item, depth + 1)?));
            }

            WireValue::Map(entries)
        }
        "set" => {
            let raw = items.get(2).and_then(Value::as_array).ok_or(WireError::Malformed("set"))?;

            WireValue::Set(raw.iter().map(|item| decode_at(item, depth + 1)).collect::<WireResult<_>>()?)
        }
        "error" => {
            let props = match items.get(4) {
                Some(Value::Object(fields)) => fields
                    .iter()
                    .map(|(key, item)| Ok((key.clone(), decode_at(item, depth + 1)?)))
                    .collect::<WireResult<Vec<_>>>()?,
                _ => Vec::new(),
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
            } else {
                WireValue::TypedBytes { data, ctor: ctor.to_string() }
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

/// Whether `raw` is an optionally-negative run of ASCII digits. Deliberately not
/// a regex: this runs on untrusted input on every decode.
fn is_bigint_literal(raw: &str) -> bool {
    let body = raw.strip_prefix('-').unwrap_or(raw);

    !body.is_empty() && body.bytes().all(|byte| byte.is_ascii_digit())
}

/// Project a generated model's serde output onto the wire, dropping null-valued
/// object fields at every depth.
///
/// quicktype's Rust backend renders an optional field as `Option<T>` with no
/// `skip_serializing_if`, so an unset one serialises as an explicit null — while
/// `v.optional(x)` parses `undefined`-or-`x` and REJECTS null, failing validation
/// on the server for every call that leaves an optional unset. The Go backend
/// emits `omitempty` and Python's `to_dict` omits the key; this makes Rust agree
/// with both.
///
/// The ceiling: a field the caller means to send AS null is dropped too. That is
/// the same limitation the Python backend has, and nothing in the rendered model
/// distinguishes the two cases.
pub fn from_model_json(value: &Value) -> WireValue {
    match value {
        Value::Array(items) => WireValue::Array(items.iter().map(from_model_json).collect()),
        Value::Object(fields) => WireValue::Object(
            fields
                .iter()
                .filter(|(_, item)| !item.is_null())
                .map(|(key, item)| (key.clone(), from_model_json(item)))
                .collect(),
        ),
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
        Value::Number(inner) => WireValue::Number(inner.as_f64().unwrap_or(f64::NAN)),
        Value::String(inner) => WireValue::String(inner.clone()),
        Value::Array(items) => WireValue::Array(items.iter().map(from_json).collect()),
        Value::Object(fields) => WireValue::Object(fields.iter().map(|(key, item)| (key.clone(), from_json(item))).collect()),
    }
}
