//! The daemon's own log: one `lunora-hostd {level}: {message}` line per event
//! on stderr, which systemd hands to the journal. Never given a token, a key or
//! a bucket credential — callers log ids, paths and outcomes only. Warnings and
//! errors can also be handed on (to the log forwarder, W6) with [`Logger::tee`].

use std::io::Write;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

type Sink = Arc<dyn Fn(Level, &str) + Send + Sync>;

#[derive(Clone)]
pub struct Logger {
    sink: Sink,
}

impl Logger {
    /// Lines on stderr.
    pub fn stderr() -> Self {
        Self::new(|level, message| {
            let _ = writeln!(std::io::stderr(), "lunora-hostd {}: {message}", level.as_str());
        })
    }

    /// Drops everything.
    pub fn silent() -> Self {
        Self::new(|_, _| {})
    }

    pub fn new(sink: impl Fn(Level, &str) + Send + Sync + 'static) -> Self {
        Self { sink: Arc::new(sink) }
    }

    /// This logger, with its warnings and errors also handed to `also`.
    pub fn tee(&self, also: impl Fn(Level, &str) + Send + Sync + 'static) -> Self {
        let sink = Arc::clone(&self.sink);

        Self::new(move |level, message| {
            sink(level, message);

            if level != Level::Info {
                also(level, message);
            }
        })
    }

    pub fn info(&self, message: &str) {
        (self.sink)(Level::Info, message);
    }

    pub fn warn(&self, message: &str) {
        (self.sink)(Level::Warn, message);
    }

    pub fn error(&self, message: &str) {
        (self.sink)(Level::Error, message);
    }
}

/// A logger that records its lines, for tests.
#[cfg(test)]
pub fn recording() -> (Logger, Arc<std::sync::Mutex<Vec<String>>>) {
    let lines = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = Arc::clone(&lines);

    (Logger::new(move |level, message| sink.lock().unwrap().push(format!("{}: {message}", level.as_str()))), lines)
}
