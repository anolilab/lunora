//! A throwaway certificate authority and a server certificate for 127.0.0.1
//! (and `localhost`), and an HTTPS server on it, for tests that serve release
//! artifacts to the daemon.
//!
//! A debug daemon adds `SSL_CERT_FILE` to its roots: point it at
//! [`TestTls::ca_file`]. A CA and a leaf, not one self-signed certificate:
//! `openssl req -x509` marks its certificate a CA, and webpki refuses a CA
//! certificate as a server's own.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::Full;
use hyper::Response;
use tokio_rustls::rustls;
use tokio_rustls::rustls::pki_types::pem::PemObject;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};

pub struct TestTls {
    /// The CA certificate (PEM), for `SSL_CERT_FILE`.
    pub ca_file: PathBuf,
    /// The server's certificate (PEM).
    pub cert: PathBuf,
    /// The server's private key (PEM).
    pub key: PathBuf,
}

/// Make the CA and the server certificate in `directory` with `openssl` (a path, or found on `PATH`).
pub fn create_test_tls(directory: &Path, openssl: &str) -> TestTls {
    let path = |name: &str| directory.join(name);
    let run = |args: &[&str]| {
        let status = Command::new(openssl).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().expect("openssl runs");

        assert!(status.success(), "openssl {args:?} failed");
    };
    let text = |name: &str| path(name).display().to_string();

    // The leaf's extensions: a server certificate for 127.0.0.1 and localhost, not a CA.
    std::fs::write(
        path("leaf.ext"),
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n",
    )
    .unwrap();
    run(&[
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        &text("ca.key"),
        "-out",
        &text("ca.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=lunora-hostd test CA",
    ]);
    run(&[
        "req",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        &text("tls.key"),
        "-out",
        &text("tls.csr"),
        "-subj",
        "/CN=127.0.0.1",
    ]);
    run(&[
        "x509",
        "-req",
        "-in",
        &text("tls.csr"),
        "-CA",
        &text("ca.pem"),
        "-CAkey",
        &text("ca.key"),
        "-CAcreateserial",
        "-out",
        &text("tls.pem"),
        "-days",
        "2",
        "-extfile",
        &text("leaf.ext"),
    ]);

    TestTls { ca_file: path("ca.pem"), cert: path("tls.pem"), key: path("tls.key") }
}

/// Files served by path (`/hostd-v9_9_9/caddy.gz`); anything else is a 404.
pub type Served = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// An HTTPS server for `tls` on 127.0.0.1, on a thread of its own; it stops when dropped.
pub struct ArtifactServer {
    /// `https://127.0.0.1:{port}`.
    pub origin: String,
    pub files: Served,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ArtifactServer {
    pub fn start(tls: &TestTls) -> Self {
        rustls::crypto::ring::default_provider().install_default().ok();

        let certificates: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(&tls.cert).unwrap().map(Result::unwrap).collect();
        let key = PrivateKeyDer::from_pem_file(&tls.key).unwrap();
        let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(certificates, key).unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("https://{}", listener.local_addr().unwrap());
        let files: Served = Arc::default();
        let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
        let served = Arc::clone(&files);

        listener.set_nonblocking(true).unwrap();

        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let accept = async move {
                    loop {
                        let Ok((stream, _)) = listener.accept().await else { continue };
                        let (acceptor, served) = (acceptor.clone(), Arc::clone(&served));

                        tokio::spawn(async move {
                            let Ok(stream) = acceptor.accept(stream).await else { return };
                            let service = hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                                let bytes = served.lock().unwrap().get(request.uri().path()).cloned();
                                let mut response = Response::new(Full::new(Bytes::from(bytes.clone().unwrap_or_default())));

                                *response.status_mut() = if bytes.is_some() { hyper::StatusCode::OK } else { hyper::StatusCode::NOT_FOUND };

                                async move { Ok::<_, Infallible>(response) }
                            });

                            let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream), service).await;
                        });
                    }
                };

                tokio::select! {
                    () = accept => {}
                    _ = stopped => {}
                }
            });
        });

        Self { origin, files, shutdown: Some(shutdown), thread: Some(thread) }
    }

    /// Serve `bytes` at `url` (a URL on this server).
    pub fn publish(&self, url: &str, bytes: Vec<u8>) {
        let path = url.strip_prefix(&self.origin).unwrap_or_else(|| panic!("{url} is not on {}", self.origin));

        self.files.lock().unwrap().insert(path.to_owned(), bytes);
    }
}

impl Drop for ArtifactServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }

        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
