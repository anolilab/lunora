//! Running a one-shot child to completion: the isolation probe, `find`
//! emptying a fleet's directory, `celld deploy` / `diagnose`, `nft`, each
//! binary's `--version`. Long-lived children (nodes, Caddy) are supervised
//! instead (`process.rs`).
//!
//! One set of semantics for all of them: the child starts under a
//! [`ChildLaunch`] with exactly the environment given — never the daemon's —
//! its output is collected per stream (bounded) and handed line by line to
//! `on_line` as it arrives, and past the timeout it is killed and the result
//! says so. A non-zero exit is not an error here; only a child that cannot be
//! started at all is.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};

use super::capabilities::ChildLaunch;

/// Output kept per stream: a chatty child cannot grow the daemon without bound.
const MAX_CAPTURED_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stream {
    Stdout,
    Stderr,
}

pub type OnLine = Arc<dyn Fn(&str, Stream) + Send + Sync>;

pub struct RunOptions {
    pub cwd: Option<String>,
    /// The child's whole environment.
    pub env: BTreeMap<String, String>,
    pub on_line: Option<OnLine>,
    /// Written to the child's stdin, which is then closed (at once, without it).
    pub stdin: Option<String>,
    pub timeout: Duration,
}

impl RunOptions {
    pub fn new(env: BTreeMap<String, String>, timeout: Duration) -> Self {
        Self { cwd: None, env, on_line: None, stdin: None, timeout }
    }
}

/// How a child ended, and what it printed.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ChildResult {
    /// `None` when a signal ended it.
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub stderr: String,
    pub stdout: String,
    pub timed_out: bool,
}

/// Longest line kept; the rest of a longer one is dropped up to its newline, so a child printing without newlines
/// cannot grow the daemon either.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Read one line (without its `\n`) into `line`, keeping at most `max` bytes of it and discarding the rest.
/// Returns how many bytes it consumed: 0 at the end of the stream.
pub async fn read_bounded_line(reader: &mut (impl AsyncBufReadExt + Unpin), line: &mut Vec<u8>, max: usize) -> std::io::Result<usize> {
    let mut consumed = 0;

    line.clear();

    loop {
        let available = reader.fill_buf().await?;

        if available.is_empty() {
            return Ok(consumed);
        }

        let (chunk, done) = match available.iter().position(|byte| *byte == b'\n') {
            Some(newline) => (&available[..newline], Some(newline + 1)),
            None => (available, None),
        };
        let room = max.saturating_sub(line.len());

        line.extend_from_slice(&chunk[..chunk.len().min(room)]);

        let used = done.unwrap_or(available.len());

        reader.consume(used);
        consumed += used;

        if done.is_some() {
            return Ok(consumed);
        }
    }
}

/// One line as text: invalid UTF-8 replaced, a trailing `\r` dropped.
pub fn line_text(line: &[u8]) -> String {
    String::from_utf8_lossy(line).trim_end_matches('\r').to_owned()
}

/// Read `stream` line by line into a bounded buffer, handing each line on as it arrives.
async fn collect(stream: impl AsyncRead + Unpin, kind: Stream, on_line: Option<OnLine>) -> String {
    let mut reader = BufReader::new(stream);
    let mut captured = String::new();
    let mut line = Vec::new();

    loop {
        match read_bounded_line(&mut reader, &mut line, MAX_LINE_BYTES).await {
            Ok(0) | Err(_) => return captured,
            Ok(_) => {
                let text = line_text(&line);

                if captured.len() + text.len() < MAX_CAPTURED_BYTES {
                    captured.push_str(&text);
                    captured.push('\n');
                }

                if let Some(on_line) = &on_line {
                    on_line(&text, kind);
                }
            }
        }
    }
}

/// Run `program args` under `launch` to completion. Errs only when the child cannot be started.
pub async fn run_child(launch: &ChildLaunch, program: &str, args: &[String], options: RunOptions) -> Result<ChildResult, String> {
    use std::os::unix::process::ExitStatusExt;

    let mut command = launch.command(program, args);

    command.envs(&options.env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }

    let mut child = command.spawn().map_err(|error| format!("could not run {program}: {error}"))?;
    let stdout = tokio::spawn(collect(child.stdout.take().expect("piped"), Stream::Stdout, options.on_line.clone()));
    let stderr = tokio::spawn(collect(child.stderr.take().expect("piped"), Stream::Stderr, options.on_line.clone()));

    if let Some(mut stdin) = child.stdin.take() {
        // A child that exits without reading its input is not the caller's failure.
        let _ = stdin.write_all(options.stdin.unwrap_or_default().as_bytes()).await;
        drop(stdin);
    }

    let (status, timed_out) = match tokio::time::timeout(options.timeout, child.wait()).await {
        Ok(status) => (status.map_err(|error| format!("could not run {program}: {error}"))?, false),
        Err(_) => {
            let _ = child.start_kill();

            (child.wait().await.map_err(|error| format!("could not run {program}: {error}"))?, true)
        }
    };
    // A grandchild may still hold a pipe open: once the child is gone, give the streams a moment, then stop reading.
    let drain = |task: tokio::task::JoinHandle<String>| async move {
        let abort = task.abort_handle();

        match tokio::time::timeout(Duration::from_secs(if timed_out { 0 } else { 5 }), task).await {
            Ok(Ok(text)) => text,
            _ => {
                abort.abort();

                String::new()
            }
        }
    };

    Ok(ChildResult { code: status.code(), signal: status.signal(), stdout: drain(stdout).await, stderr: drain(stderr).await, timed_out })
}

/// A signal's name, as Node reports one (`SIGKILL`).
pub fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGQUIT => "SIGQUIT".into(),
        libc::SIGILL => "SIGILL".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGBUS => "SIGBUS".into(),
        libc::SIGFPE => "SIGFPE".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        libc::SIGTERM => "SIGTERM".into(),
        other => format!("signal {other}"),
    }
}

/// A child's failure in one line: how it ended, and the start of what it printed on stderr (or stdout).
pub fn describe_failure(command: &str, result: &ChildResult, max_length: usize) -> String {
    let status = result.code.map_or_else(|| result.signal.map_or_else(|| "on a signal".to_owned(), signal_name), |code| code.to_string());
    let ending = if result.timed_out { "timed out".to_owned() } else { format!("exited {status}") };
    let printed = if result.stderr.trim().is_empty() { result.stdout.trim() } else { result.stderr.trim() };
    let printed: String = printed.chars().take(max_length).collect();

    if printed.is_empty() { format!("{command} {ending}") } else { format!("{command} {ending}: {printed}") }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::daemon::fleet_env::path_only;

    fn sh(script: &str) -> Vec<String> {
        vec!["-c".into(), script.into()]
    }

    #[tokio::test]
    async fn runs_a_child_with_exactly_its_environment_and_streams_its_lines() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let mut options = RunOptions::new(BTreeMap::from([("ONLY".into(), "this".into())]), Duration::from_secs(10));

        options.on_line = Some(Arc::new(move |line, stream| sink.lock().unwrap().push((line.to_owned(), stream))));
        options.stdin = Some("from stdin".into());

        let result = run_child(&ChildLaunch::DIRECT, "/bin/sh", &sh("echo \"$ONLY $HOME\"; cat; echo oops >&2; exit 3"), options).await.unwrap();

        assert_eq!(result.code, Some(3));
        assert_eq!(result.stdout, "this \nfrom stdin\n");
        assert_eq!(result.stderr, "oops\n");
        assert!(seen.lock().unwrap().contains(&("oops".to_owned(), Stream::Stderr)));
        assert_eq!(describe_failure("sh", &result, 300), "sh exited 3: oops");
    }

    #[tokio::test]
    async fn kills_a_child_that_outlives_its_timeout() {
        let result = run_child(&ChildLaunch::DIRECT, "/bin/sh", &sh("sleep 30"), RunOptions::new(path_only(), Duration::from_millis(200))).await.unwrap();

        assert!(result.timed_out);
        assert_eq!(result.signal, Some(libc::SIGKILL));
        assert_eq!(describe_failure("sleep", &result, 300), "sleep timed out");
    }

    #[tokio::test]
    async fn bounds_a_line_that_never_ends() {
        let result = run_child(
            &ChildLaunch::DIRECT,
            "/bin/sh",
            &sh("head -c 300000 /dev/zero | tr '\\0' x; echo; echo after"),
            RunOptions::new(path_only(), Duration::from_secs(10)),
        )
        .await
        .unwrap();
        let lines: Vec<&str> = result.stdout.lines().collect();

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), MAX_LINE_BYTES);
        assert_eq!(lines[1], "after");
    }

    #[tokio::test]
    async fn fails_only_when_the_child_cannot_start() {
        let error = run_child(&ChildLaunch::DIRECT, "/nonexistent/binary", &[], RunOptions::new(path_only(), Duration::from_secs(1))).await.unwrap_err();

        assert!(error.starts_with("could not run /nonexistent/binary"), "{error}");
    }
}
