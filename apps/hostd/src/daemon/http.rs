//! The daemon's HTTP clients and the session's TLS: rustls on ring with the
//! system's roots (the box's `ca-certificates`; `SSL_CERT_FILE` replaces them,
//! which only the tests' lane does), one client that follows redirects (release artifacts
//! live behind GitHub's redirect to its object store) and one that never does
//! (a signed request, the enrolment, the log forwarder: a redirect would hand
//! a box-signed request or the ingest key to another origin).

use std::sync::Once;
use std::time::Duration;

/// Installs ring as rustls' process-wide provider, once; every TLS client relies on it.
pub fn install_crypto() {
    static INSTALL: Once = Once::new();

    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn builder() -> reqwest::ClientBuilder {
    install_crypto();

    let builder = reqwest::Client::builder();

    // Debug builds only (the black-box tests): `SSL_CERT_FILE` is added to the roots on every platform, macOS
    // included, whose verifier ignores it. A release build trusts exactly the system's roots.
    #[cfg(debug_assertions)]
    let builder =
        match std::env::var("SSL_CERT_FILE").ok().and_then(|path| std::fs::read(path).ok()).and_then(|pem| reqwest::Certificate::from_pem_bundle(&pem).ok()) {
            Some(certificates) => builder.tls_certs_merge(certificates),
            None => builder,
        };

    builder.connect_timeout(Duration::from_secs(30)).user_agent(concat!("lunora-hostd/", env!("LUNORA_HOSTD_VERSION")))
}

/// The TLS configuration of the control session's WebSocket: the same system roots the HTTP clients verify with.
pub fn websocket_connector() -> Result<tokio_tungstenite::Connector, String> {
    use rustls_platform_verifier::ConfigVerifierExt;

    install_crypto();

    rustls::ClientConfig::with_platform_verifier()
        .map(|config| tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(config)))
        .map_err(|error| error.to_string())
}

/// Follows redirects (up to ten, as fetch does).
pub fn client() -> reqwest::Client {
    builder().build().expect("the TLS configuration is static")
}

/// Never follows a redirect: the 3xx comes back as the response, which callers refuse.
pub fn no_redirect_client() -> reqwest::Client {
    builder().redirect(reqwest::redirect::Policy::none()).build().expect("the TLS configuration is static")
}
