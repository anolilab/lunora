//! A job's failure as the box reports it in `result.error` (protocol §5.1): a
//! machine-readable code and a human message.

use crate::wire::types::ErrorDetail;
use crate::wire::{LIMITS, truncate_utf8};

/// Every code a job of this box fails with.
pub mod codes {
    pub const ALIAS_BUSY: &str = "ALIAS_BUSY";
    pub const ARTIFACT_INVALID: &str = "ARTIFACT_INVALID";
    pub const BUCKET_FAILED: &str = "BUCKET_FAILED";
    pub const CELLD_FAILED: &str = "CELLD_FAILED";
    pub const FETCH_FAILED: &str = "FETCH_FAILED";
    pub const HEALTH_TIMEOUT: &str = "HEALTH_TIMEOUT";
    pub const ISOLATION_FAILED: &str = "ISOLATION_FAILED";
    pub const JOB_FAILED: &str = "JOB_FAILED";
    pub const NO_FLEET: &str = "NO_FLEET";
    pub const ORIGIN_REFUSED: &str = "ORIGIN_REFUSED";
    pub const PORTS_EXHAUSTED: &str = "PORTS_EXHAUSTED";
    pub const RELEASE_INVALID: &str = "RELEASE_INVALID";
    pub const UPGRADE_REFUSED: &str = "UPGRADE_REFUSED";
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

impl JobError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    /// `result.error`, its message held to the protocol's cap.
    pub fn detail(&self) -> ErrorDetail {
        ErrorDetail { code: self.code.to_owned(), message: truncate_utf8(&self.message, LIMITS.max_error_message_bytes) }
    }
}

impl std::fmt::Display for JobError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for JobError {}

/// Anything else that fails inside a job is a `JOB_FAILED`.
impl From<std::io::Error> for JobError {
    fn from(error: std::io::Error) -> Self {
        Self::new(codes::JOB_FAILED, error.to_string())
    }
}

impl From<String> for JobError {
    fn from(message: String) -> Self {
        Self::new(codes::JOB_FAILED, message)
    }
}
