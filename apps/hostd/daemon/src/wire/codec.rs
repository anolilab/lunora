//! Encoding and decoding of hostd frames (protocol §1, §4): one UTF-8 JSON
//! object each, within the frame cap. Decoding never panics; a bad frame comes
//! back as a [`DecodeError`] naming what was wrong and where.

use serde::Serialize;
use serde_json::Value;

use super::LIMITS;
use super::types::{BoxMessage, CloudMessage};
use super::validate::{BOX_TYPES, CLOUD_TYPES, Read, read_box_message, read_cloud_message};

/// Why a frame was rejected (§4).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeErrorCode {
    FrameTooLarge,
    InvalidJson,
    InvalidMessage,
    UnknownType,
}

impl DecodeErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FrameTooLarge => "FRAME_TOO_LARGE",
            Self::InvalidJson => "INVALID_JSON",
            Self::InvalidMessage => "INVALID_MESSAGE",
            Self::UnknownType => "UNKNOWN_TYPE",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodeError {
    pub code: DecodeErrorCode,
    pub message: String,
    /// The offending field (`$.job.alias`), when there is one.
    pub path: Option<String>,
}

/// A frame as a WebSocket delivers it: text, or binary holding UTF-8 text.
pub enum Frame<'a> {
    Text(&'a str),
    Binary(&'a [u8]),
}

fn reject<T>(code: DecodeErrorCode, message: impl Into<String>, path: Option<&str>) -> Result<T, DecodeError> {
    Err(DecodeError { code, message: message.into(), path: path.map(str::to_owned) })
}

fn frame_text<'a>(frame: &Frame<'a>) -> Result<&'a str, DecodeError> {
    let too_large = || reject(DecodeErrorCode::FrameTooLarge, format!("frame exceeds {} bytes", LIMITS.max_frame_bytes), None);

    match *frame {
        Frame::Text(text) if text.len() > LIMITS.max_frame_bytes => too_large(),
        Frame::Text(text) => Ok(text),
        Frame::Binary(bytes) if bytes.len() > LIMITS.max_frame_bytes => too_large(),
        Frame::Binary(bytes) => std::str::from_utf8(bytes).or_else(|_| reject(DecodeErrorCode::InvalidJson, "frame is not valid UTF-8", None)),
    }
}

fn decode_with<T>(frame: &Frame<'_>, read: fn(&str, &Value, &str) -> Option<Read<T>>, types: &str, direction: &str) -> Result<T, DecodeError> {
    let text = frame_text(frame)?;
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return reject(DecodeErrorCode::InvalidJson, "frame is not valid JSON", None);
    };

    if !parsed.is_object() {
        return reject(DecodeErrorCode::InvalidMessage, "frame must be a JSON object", Some("$"));
    }

    let kind = parsed.get("type").and_then(Value::as_str).unwrap_or_default();

    match read(kind, &parsed, "$") {
        None => reject(DecodeErrorCode::UnknownType, format!("type must be one of the {direction} types: {types}"), Some("$.type")),
        Some(Ok(message)) => Ok(message),
        Some(Err(invalid)) => reject(DecodeErrorCode::InvalidMessage, invalid.message, Some(&invalid.path)),
    }
}

/// Decode and validate one frame a box sent.
pub fn decode_box_message(frame: &Frame<'_>) -> Result<BoxMessage, DecodeError> {
    decode_with(frame, read_box_message, BOX_TYPES, "box → cloud")
}

/// Decode and validate one frame the control plane sent.
pub fn decode_cloud_message(frame: &Frame<'_>) -> Result<CloudMessage, DecodeError> {
    decode_with(frame, read_cloud_message, CLOUD_TYPES, "cloud → box")
}

fn encode_with<T: Serialize>(message: &T, read: fn(&str, &Value, &str) -> Option<Read<T>>) -> Result<String, String> {
    let value = serde_json::to_value(message).map_err(|error| error.to_string())?;
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let validated = match read(kind, &value, "$") {
        Some(Ok(validated)) => validated,
        Some(Err(invalid)) => return Err(invalid.message),
        None => return Err(format!("unknown hostd message type: {kind}")),
    };
    let encoded = serde_json::to_string(&validated).map_err(|error| error.to_string())?;

    if encoded.len() > LIMITS.max_frame_bytes {
        return Err(format!("encoded {kind} frame exceeds {} bytes", LIMITS.max_frame_bytes));
    }

    Ok(encoded)
}

/// Validate a box message and encode it as one text frame: whatever this returns, the peer's decoder accepts.
pub fn encode_box_message(message: &BoxMessage) -> Result<String, String> {
    encode_with(message, read_box_message)
}

/// Validate a control-plane message and encode it (for the tests' fake control plane).
pub fn encode_cloud_message(message: &CloudMessage) -> Result<String, String> {
    encode_with(message, read_cloud_message)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// `protocol/hostd/fixtures/messages.json`: the conformance suite of §7.
    fn fixtures() -> Value {
        serde_json::from_str(include_str!("../../../../../protocol/hostd/fixtures/messages.json")).expect("the fixtures are JSON")
    }

    fn text(value: &Value) -> String {
        serde_json::to_string(value).unwrap()
    }

    type Decode = fn(&str) -> Result<(), DecodeError>;

    #[test]
    fn decodes_every_golden_frame_and_round_trips_it() {
        let fixtures = fixtures();

        for (name, frame) in fixtures["box"].as_object().unwrap() {
            let decoded = decode_box_message(&Frame::Text(&text(frame))).unwrap_or_else(|error| panic!("box {name}: {error:?}"));

            assert_eq!(&serde_json::to_value(&decoded).unwrap(), frame, "box {name}");
            assert_eq!(decode_box_message(&Frame::Text(&encode_box_message(&decoded).unwrap())).unwrap(), decoded, "box {name} round trip");
        }

        for (name, frame) in fixtures["cloud"].as_object().unwrap() {
            let decoded = decode_cloud_message(&Frame::Text(&text(frame))).unwrap_or_else(|error| panic!("cloud {name}: {error:?}"));

            assert_eq!(&serde_json::to_value(&decoded).unwrap(), frame, "cloud {name}");
            assert_eq!(decode_cloud_message(&Frame::Text(&encode_cloud_message(&decoded).unwrap())).unwrap(), decoded, "cloud {name} round trip");
        }
    }

    #[test]
    fn rejects_every_invalid_case_with_its_code_and_path() {
        let fixtures = fixtures();

        let decoders: [(&str, Decode); 2] =
            [("box", |frame| decode_box_message(&Frame::Text(frame)).map(|_| ())), ("cloud", |frame| decode_cloud_message(&Frame::Text(frame)).map(|_| ()))];

        for (direction, decode) in decoders {
            for case in fixtures["invalid"][direction].as_array().unwrap() {
                let name = case["name"].as_str().unwrap();
                // A string frame is sent as it is (`not json`); any other value as its JSON.
                let frame = case["frame"].as_str().map_or_else(|| text(&case["frame"]), str::to_owned);
                let error = decode(&frame).expect_err(name);

                assert_eq!(error.code.as_str(), case["code"].as_str().unwrap(), "{direction}: {name}: {}", error.message);

                if let Some(path) = case.get("path").and_then(Value::as_str) {
                    assert_eq!(error.path.as_deref(), Some(path), "{direction}: {name}: {}", error.message);
                }
            }
        }
    }

    /// Every copy of `node` with `unknownField` added to one of its objects, and that field's path. `vars` is free-form.
    fn with_unknown_field(node: &Value, path: &str) -> Vec<(Value, String)> {
        match node {
            Value::Array(entries) => entries
                .iter()
                .enumerate()
                .flat_map(|(index, entry)| {
                    with_unknown_field(entry, &format!("{path}[{index}]")).into_iter().map(move |(variant, at)| {
                        let mut copy = entries.clone();

                        copy[index] = variant;

                        (Value::Array(copy), at)
                    })
                })
                .collect(),
            Value::Object(record) => {
                let mut extended = record.clone();

                extended.insert("unknownField".into(), Value::Bool(true));

                let mut variants = vec![(Value::Object(extended), format!("{path}.unknownField"))];

                for (key, value) in record.iter().filter(|(key, _)| *key != "vars") {
                    for (variant, at) in with_unknown_field(value, &format!("{path}.{key}")) {
                        let mut copy = record.clone();

                        copy.insert(key.clone(), variant);
                        variants.push((Value::Object(copy), at));
                    }
                }

                variants
            }
            _ => Vec::new(),
        }
    }

    #[test]
    fn rejects_an_unknown_field_at_every_level_and_a_missing_required_one() {
        let fixtures = fixtures();
        let decoders: [(&str, Decode); 2] =
            [("box", |frame| decode_box_message(&Frame::Text(frame)).map(|_| ())), ("cloud", |frame| decode_cloud_message(&Frame::Text(frame)).map(|_| ()))];

        assert_eq!(
            with_unknown_field(&fixtures["box"]["hello"], "$").into_iter().map(|(_, path)| path).collect::<Vec<_>>(),
            ["$.unknownField", "$.versions.unknownField", "$.fleets[0].unknownField", "$.fleets[1].unknownField", "$.resources.unknownField"]
        );

        for (direction, decode) in decoders {
            for (name, message) in fixtures[direction].as_object().unwrap() {
                for (variant, path) in with_unknown_field(message, "$") {
                    let error = decode(&text(&variant)).expect_err(&path);

                    assert_eq!((error.code, error.path.as_deref()), (DecodeErrorCode::InvalidMessage, Some(path.as_str())), "{direction} {name}");
                }

                for key in message.as_object().unwrap().keys().filter(|key| !["error", "isolation", "telemetry", "type", "url"].contains(&key.as_str())) {
                    let mut rest = message.as_object().unwrap().clone();

                    rest.shift_remove(key);
                    assert!(decode(&text(&Value::Object(rest))).is_err(), "{name} without {key}");
                }
            }
        }
    }

    #[test]
    fn accepts_a_binary_frame_and_refuses_one_that_is_not_utf8() {
        let ping = br#"{"type":"ping"}"#;

        assert_eq!(decode_cloud_message(&Frame::Binary(ping)), Ok(CloudMessage::Ping));
        assert_eq!(decode_cloud_message(&Frame::Binary(&[0xff, 0xfe])).unwrap_err().code, DecodeErrorCode::InvalidJson);
    }

    #[test]
    fn rejects_frames_over_the_caps() {
        let huge = format!(r#"{{"type":"ping","pad":"{}"}}"#, "x".repeat(LIMITS.max_frame_bytes));

        assert_eq!(decode_cloud_message(&Frame::Text(&huge)).unwrap_err().code, DecodeErrorCode::FrameTooLarge);

        let line = json!({ "type": "progress", "jobId": "job_1", "line": "x".repeat(LIMITS.max_line_bytes + 1) });
        let error = decode_box_message(&Frame::Text(&text(&line))).unwrap_err();

        assert_eq!((error.code, error.path.as_deref()), (DecodeErrorCode::InvalidMessage, Some("$.line")));

        let routes: Vec<Value> = (0..=LIMITS.max_routes).map(|index| json!({ "hostname": format!("h{index}.example.com"), "alias": "a" })).collect();
        let error = decode_cloud_message(&Frame::Text(&text(&json!({ "type": "routes", "table": routes })))).unwrap_err();

        assert_eq!(error.path.as_deref(), Some("$.table"));

        let crons: Vec<Value> = (0..=LIMITS.max_crons).map(|_| json!("* * * * *")).collect();
        let deploy = json!({ "type": "job", "jobId": "job_1", "job": { "kind": "deploy", "alias": "a", "deploymentId": "dep_1", "releaseUrl": "https://example.com/r", "vars": {}, "crons": crons } });

        assert_eq!(decode_cloud_message(&Frame::Text(&text(&deploy))).unwrap_err().path.as_deref(), Some("$.job.crons"));
    }

    #[test]
    fn refuses_to_encode_a_frame_the_peer_would_reject() {
        let error = encode_box_message(&BoxMessage::Progress { job_id: "job 1".into(), line: "x".into() }).unwrap_err();

        assert!(error.starts_with("$.jobId"), "{error}");
    }
}
