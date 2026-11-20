//! What the fake celld and Caddy share. Each fake is run through a script the
//! test box writes (`tests/support/fakes.rs`), whose shebang names the fake and
//! the record directory, and whose second line is the version the fake prints:
//!
//! ```text
//! #!/…/fake-celld /…/records
//! celld 0.6.0
//! ```
//!
//! The kernel runs that as `fake-celld /…/records /…/script args…`: no shell
//! in between to add `PWD` or `SHLVL` to the environment a test asserts, the
//! script's pid is the fake's, and the record directory survives the empty
//! environment the daemon gives a fleet.

// Each fake compiles this module on its own and reads only part of it.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response};

/// How a fake was run: its record directory, the version it prints and the arguments it was given.
pub struct Invocation {
    pub records: PathBuf,
    pub version: String,
    pub args: Vec<String>,
}

/// Read the invocation and append it to `{records}/{log}` as one JSON line: argv, cwd, env, pid.
pub fn invocation(log: &str) -> Invocation {
    let mut argv = std::env::args().skip(1);
    let records = PathBuf::from(argv.next().expect("the record directory, from the script's shebang"));
    let script = argv.next().expect("the script the kernel ran");
    let version = std::fs::read_to_string(&script).ok().and_then(|text| text.lines().nth(1).map(str::to_owned)).unwrap_or_default();
    let args: Vec<String> = argv.collect();
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let cwd = std::env::current_dir().map(|path| path.display().to_string()).unwrap_or_default();
    let line = serde_json::json!({ "argv": args, "cwd": cwd, "env": env, "pid": std::process::id() });

    append_line(&records.join(log), &line.to_string());

    Invocation { records, version, args }
}

/// Append `line` and a newline in one write, so concurrent fakes never interleave.
pub fn append_line(path: &Path, line: &str) {
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("the record directory is writable");

    file.write_all(format!("{line}\n").as_bytes()).expect("the record directory is writable");
}

/// The value after `flag` in `args`.
pub fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter().position(|arg| arg == flag).and_then(|index| args.get(index + 1)).map(String::as_str)
}

/// One request as the handlers see it.
pub struct Received {
    pub method: String,
    pub path: String,
    pub headers: hyper::HeaderMap,
    pub body: Bytes,
}

pub fn respond(status: u16, body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(body.into()));

    *response.status_mut() = hyper::StatusCode::from_u16(status).expect("a valid status");

    response
}

/// Serve HTTP/1 on `address` with `handler`, forever.
pub async fn serve(address: SocketAddr, handler: impl Fn(Received) -> Response<Full<Bytes>> + Send + Sync + 'static) {
    let listener = tokio::net::TcpListener::bind(address).await.expect("the fake's port is free");
    let handler = Arc::new(handler);

    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let handler = Arc::clone(&handler);
        let service = hyper::service::service_fn(move |request: Request<hyper::body::Incoming>| {
            let handler = Arc::clone(&handler);

            async move {
                let (parts, body) = request.into_parts();
                let body = body.collect().await.map(http_body_util::Collected::to_bytes).unwrap_or_default();

                Ok::<_, Infallible>(handler(Received { method: parts.method.to_string(), path: parts.uri.to_string(), headers: parts.headers, body }))
            }
        });

        tokio::spawn(async move {
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream), service).await;
        });
    }
}

/// `host:port` as a socket address.
pub fn address_of(text: &str) -> SocketAddr {
    text.parse().unwrap_or_else(|_| panic!("{text} is not host:port"))
}

pub fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime")
}
