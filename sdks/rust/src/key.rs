//! The stable subscription key, ported from `shared/stable-key.ts`.
//!
//! A key is compared verbatim against one produced by the reference TypeScript
//! client, so every spelling here must match ECMAScript exactly — a mismatch
//! silently splits one subscription into two.

use serde_json::Value;

use crate::wire::{encode_wire, WireError, WireValue};

/// Canonical JSON encoding of a pure-JSON tree: object keys sorted at every
/// depth, arrays keeping their order, null fields kept, undefined object fields
/// dropped.
pub fn stable_stringify(value: &Value) -> String {
    let mut out = String::new();

    write_stable(&mut out, value);
    out
}

/// The stable cache/dedup key for `value`.
pub fn stable_wire_key(value: &WireValue) -> Result<String, WireError> {
    Ok(stable_stringify(&encode_wire(value)?))
}

fn write_stable(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(inner) => out.push_str(if *inner { "true" } else { "false" }),
        Value::Number(inner) => out.push_str(&format_number(inner.as_f64().unwrap_or(f64::NAN))),
        Value::String(inner) => out.push_str(&json_string(inner)),
        Value::Array(items) => {
            out.push('[');

            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }

                write_stable(out, item);
            }

            out.push(']');
        }
        Value::Object(fields) => {
            // JavaScript compares strings by UTF-16 code unit. Rust's `Ord` for
            // `str` is UTF-8 byte-wise, which agrees inside the BMP but not
            // above it: an astral character is its high surrogate (0xD83D) as
            // UTF-16 yet 0xF0.. as UTF-8, so it sorts before U+FFFD there and
            // after it here.
            let mut keys: Vec<&String> = fields.keys().collect();

            keys.sort_by_key(|key| utf16_units(key));
            out.push('{');

            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }

                out.push_str(&json_string(key));
                out.push(':');
                write_stable(out, &fields[key.as_str()]);
            }

            out.push('}');
        }
    }
}

fn utf16_units(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

/// Renders a number exactly as `String(v)` does in JavaScript, which is what
/// `JSON.stringify` emits for a finite number.
///
/// Rust's `{}` for f64 never uses exponent notation at all and writes integral
/// values without a decimal; ECMAScript stays positional only between 1e-7 and
/// 1e21 and uses exponent form outside that, never zero-padding the exponent.
pub(crate) fn format_number(value: f64) -> String {
    if value.is_nan() || value.is_infinite() {
        return "null".to_string();
    }

    if value == value.trunc() && value.abs() < 1e21 {
        // `{}` prints the SHORTEST digits that read back as the same f64, which
        // is ECMAScript's rule; `{:.0}` prints the EXACT expansion, so 2^60 came
        // out as 1152921504606846976 where `String(2**60)` is
        // 1152921504606847000. Both spell a negative zero "-0".
        return format!("{}", value);
    }

    let magnitude = value.abs();

    if (1e-6..1e21).contains(&magnitude) {
        return trim_trailing_zeros(&format!("{}", value));
    }

    exponential(value)
}

fn exponential(value: f64) -> String {
    for precision in 0..=17 {
        let candidate = format!("{:.*e}", precision, value);

        if candidate.parse::<f64>() == Ok(value) {
            return normalise_exponent(&candidate);
        }
    }

    normalise_exponent(&format!("{:.17e}", value))
}

/// Rust writes "1e-7" as `1e-7` already, but with a bare `e` and no `+` for a
/// positive exponent; ECMAScript always signs it. Trailing mantissa zeros are
/// dropped for the same reason.
fn normalise_exponent(text: &str) -> String {
    let Some((mantissa, exponent)) = text.split_once('e') else {
        return text.to_string();
    };

    let mantissa = trim_trailing_zeros(mantissa);
    let (sign, digits) = match exponent.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("+", exponent.strip_prefix('+').unwrap_or(exponent)),
    };
    let digits = digits.trim_start_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };

    format!("{mantissa}e{sign}{digits}")
}

fn trim_trailing_zeros(text: &str) -> String {
    if !text.contains('.') {
        return text.to_string();
    }

    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Quotes a string the way `JSON.stringify` does: `<`, `>`, `&`, U+2028 and
/// U+2029 stay raw, unlike some JSON encoders.
pub(crate) fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);

    out.push('"');

    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            character if (character as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", character as u32)),
            character => out.push(character),
        }
    }

    out.push('"');
    out
}
