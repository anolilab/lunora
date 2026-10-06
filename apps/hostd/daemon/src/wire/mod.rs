//! The versioned hostd ↔ control-plane wire protocol (plan 458 W1). The
//! normative contract is `protocol/hostd/README.md`; its golden frames
//! (`protocol/hostd/fixtures/messages.json`) are what this module is tested
//! against, as the TypeScript reference is.

pub mod codec;
pub mod signing;
pub mod types;
pub mod validate;

/// The protocol version this build speaks (§3).
pub const PROTOCOL_VERSION: u64 = 1;

/// `Number.MAX_SAFE_INTEGER`: every integer field is at most this (§1).
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The caps every frame is held to (§4). Byte counts are UTF-8 bytes.
pub struct Limits {
    pub max_alias_length: usize,
    pub max_crons: usize,
    pub max_error_message_bytes: usize,
    pub max_fleets: usize,
    pub max_frame_bytes: usize,
    pub max_isolation_problem_bytes: usize,
    pub max_isolation_problems: usize,
    pub max_line_bytes: usize,
    pub max_report_aliases: usize,
    pub max_routes: usize,
    pub max_token_length: usize,
    pub max_url_length: usize,
}

pub const LIMITS: Limits = Limits {
    max_alias_length: 63,
    max_crons: 64,
    max_error_message_bytes: 8192,
    max_fleets: 500,
    max_frame_bytes: 262_144,
    max_isolation_problem_bytes: 512,
    max_isolation_problems: 8,
    max_line_bytes: 8192,
    max_report_aliases: 500,
    max_routes: 2000,
    max_token_length: 512,
    max_url_length: 2048,
};

/// A string's length as JavaScript counts it (UTF-16 code units), for the caps the reference states in characters.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Truncate `text` to at most `max_bytes` UTF-8 bytes on a character boundary, marking a cut with `...`.
pub fn truncate_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }

    let budget = max_bytes.saturating_sub(3);
    let mut end = 0;

    for (index, character) in text.char_indices() {
        if index + character.len_utf8() > budget {
            break;
        }

        end = index + character.len_utf8();
    }

    format!("{}...", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_on_a_character_boundary() {
        assert_eq!(truncate_utf8("short", 10), "short");
        assert_eq!(truncate_utf8("abcdefghij", 8), "abcde...");
        // "é" is two bytes: a cut never splits it.
        assert_eq!(truncate_utf8("ééééé", 8), "éé...");
        assert!(truncate_utf8(&"x".repeat(10_000), 8192).len() <= 8192);
    }
}
