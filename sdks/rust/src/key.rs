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
/// ECMA-262 `Number::toString`: take the shortest digit string `d1..dk` that
/// reads back as the same double, with decimal exponent `n` (the value is
/// `0.d1..dk × 10^n`), and lay it out positionally for `-6 < n ≤ 21`, in
/// exponent form (always signed, never zero-padded) otherwise. A negative zero
/// is spelled `-0`, so it keys apart from `0`.
pub(crate) fn format_number(value: f64) -> String {
    if !value.is_finite() {
        return "null".to_string();
    }

    if value == 0.0 {
        return if value.is_sign_negative() { "-0" } else { "0" }.to_string();
    }

    let (digits, n) = shortest_digits(value.abs());
    let k = digits.len() as i32;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(-n as usize))
    } else {
        let mantissa = if k == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };

        format!("{mantissa}e{}{}", if n >= 1 { "+" } else { "-" }, (n - 1).abs())
    };

    if value < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// The shortest round-trip digits of a positive finite double and its decimal
/// exponent `n`.
///
/// Rust's `{:e}` already prints the shortest digits, closest to the value — but
/// when the value lies EXACTLY halfway between two shortest candidates it rounds
/// up, where ECMA-262 takes the even one: `-1447690133445719.25` keyed as
/// `…719.3` here and `…719.2` in the reference. A tie only ever differs from
/// round-up when the chosen last digit is odd, so that is the only case checked.
fn shortest_digits(magnitude: f64) -> (String, i32) {
    let text = format!("{magnitude:e}");
    let (mantissa, exponent) = text.split_once('e').expect("LowerExp writes an exponent");
    let mut digits = mantissa.replace('.', "");
    let n = exponent.parse::<i32>().expect("LowerExp writes an integer exponent") + 1;
    let last = *digits.as_bytes().last().expect("at least one digit");

    if (last - b'0') % 2 == 1 {
        let mut lower = digits[..digits.len() - 1].to_string();

        lower.push((last - 1) as char);

        // The cheap test first — the even neighbour must read back as the same
        // double at all — then the exact one: the value is the midpoint
        // `0.<lower>5 × 10^n`. An f64's exact decimal expansion has at most 767
        // significant digits, so 800 places print it whole.
        if format!("0.{lower}e{n}").parse::<f64>() == Ok(magnitude) {
            let exact = format!("{magnitude:.800e}");
            let (exact_mantissa, exact_exponent) = exact.split_once('e').expect("LowerExp writes an exponent");

            if exact_exponent == (n - 1).to_string() && exact_mantissa.replace('.', "").trim_end_matches('0') == format!("{lower}5") {
                digits = lower;
            }
        }
    }

    (digits, n)
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
