//! Box-signed HTTP requests to the control plane (plan 458 D6, protocol §6.2):
//! how the box fetches a stored release or a `lunora-hostd` release manifest.
//!
//! Every request carries the box id, a fresh nonce, the current time and an
//! Ed25519 signature over the protocol's request payload — the timestamp is
//! mandatory, so a captured request goes stale in five minutes. A URL whose
//! origin is not the control plane the box enrolled with is refused before
//! anything is signed: otherwise a job could make the box sign requests for a
//! third party. Redirects are refused for the same reason: the client never
//! follows one ([`super::http::no_redirect_client`]), so a 3xx comes back as the
//! response, and every caller refuses a status but 200.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::identity::Identity;
use super::job_error::{JobError, codes};
use crate::wire::signing::{HEADER_BOX_ID, HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP, request_payload};

type Nonce = Box<dyn Fn() -> Result<String, JobError> + Send + Sync>;

type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

/// Signs `GET`s for the one control plane the box enrolled with.
pub struct SignedFetch {
    box_id: String,
    /// The enrolled control plane's origin; the only one requests are signed for. `None`: it does not parse, so none is.
    origin: Option<url::Origin>,
    identity: Identity,
    client: reqwest::Client,
    nonce: Nonce,
    now: Clock,
}

/// 24 random bytes, base64url: a fresh request nonce.
fn random_nonce() -> Result<String, JobError> {
    let mut bytes = [0_u8; 24];

    getrandom::fill(&mut bytes).map_err(|error| JobError::new(codes::JOB_FAILED, format!("no randomness for a request nonce: {error}")))?;

    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// A transport failure in one line, with the causes `reqwest` keeps behind its own message.
pub fn describe_error(error: &(dyn std::error::Error + 'static)) -> String {
    let mut message = error.to_string();
    let mut source = error.source();

    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }

    message
}

impl SignedFetch {
    /// `client` must be [`super::http::no_redirect_client`]: a redirect would hand the signed request to another origin.
    pub fn new(box_id: impl Into<String>, control_plane: &str, identity: Identity, client: reqwest::Client) -> Self {
        Self {
            box_id: box_id.into(),
            origin: url::Url::parse(control_plane).ok().map(|url| url.origin()),
            identity,
            client,
            nonce: Box::new(random_nonce),
            now: Box::new(super::now_ms),
        }
    }

    /// Replace the nonce source and the clock (epoch ms), for tests.
    #[must_use]
    pub fn with_nonce_and_clock(mut self, nonce: impl Fn() -> String + Send + Sync + 'static, now: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        self.nonce = Box::new(move || Ok(nonce()));
        self.now = Box::new(now);

        self
    }

    /// A signed `GET` of `url` on the control plane, given up after `timeout` (the body included).
    /// `ORIGIN_REFUSED` before anything is signed for a URL elsewhere; any other failure is a `JOB_FAILED`.
    pub async fn get(&self, url: &str, timeout: Duration) -> Result<reqwest::Response, JobError> {
        let Ok(target) = url::Url::parse(url) else {
            return Err(JobError::new(codes::ORIGIN_REFUSED, "the control plane named a URL that does not parse"));
        };
        let origin = target.origin();

        if self.origin.as_ref() != Some(&origin) || !target.username().is_empty() || target.password().is_some() {
            let enrolled = self.origin.as_ref().map_or_else(|| "null".to_owned(), url::Origin::ascii_serialization);

            return Err(JobError::new(
                codes::ORIGIN_REFUSED,
                format!("refusing to sign a request for {}: this box only talks to {enrolled}", origin.ascii_serialization()),
            ));
        }

        let timestamp = (self.now)();
        let nonce = (self.nonce)()?;
        let path = match target.query() {
            Some(query) if !query.is_empty() => format!("{}?{query}", target.path()),
            _ => target.path().to_owned(),
        };
        let payload = request_payload("GET", &path, &self.box_id, timestamp, &nonce).map_err(|message| JobError::new(codes::JOB_FAILED, message))?;
        let signature = self.identity.sign(&payload);

        self.client
            .get(target)
            .header(HEADER_BOX_ID, &self.box_id)
            .header(HEADER_NONCE, nonce)
            .header(HEADER_SIGNATURE, signature)
            .header(HEADER_TIMESTAMP, timestamp.to_string())
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| JobError::new(codes::JOB_FAILED, describe_error(&error)))
    }
}

/// A local HTTP server for the tests of the modules that fetch: it records every request and answers with `handler`.
#[cfg(test)]
pub(crate) mod test_server {
    use std::sync::{Arc, Mutex};

    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::{Request, Response};

    #[derive(Clone, Debug)]
    pub struct Recorded {
        pub method: String,
        /// The request target: path and query.
        pub target: String,
        pub headers: hyper::HeaderMap,
        pub body: Bytes,
    }

    type Handler = Arc<dyn Fn(&Recorded) -> Response<Full<Bytes>> + Send + Sync>;

    pub struct TestServer {
        pub origin: String,
        pub requests: Arc<Mutex<Vec<Recorded>>>,
    }

    pub fn respond(status: u16, body: impl Into<Bytes>) -> Response<Full<Bytes>> {
        let mut response = Response::new(Full::new(body.into()));

        *response.status_mut() = hyper::StatusCode::from_u16(status).unwrap();

        response
    }

    pub async fn serve(handler: impl Fn(&Recorded) -> Response<Full<Bytes>> + Send + Sync + 'static) -> TestServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Handler = Arc::new(handler);
        let log = Arc::clone(&requests);

        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (handler, log) = (Arc::clone(&handler), Arc::clone(&log));
                let service = hyper::service::service_fn(move |request: Request<hyper::body::Incoming>| {
                    let (handler, log) = (Arc::clone(&handler), Arc::clone(&log));

                    async move {
                        let (parts, body) = request.into_parts();
                        let body = body.collect().await.map(http_body_util::Collected::to_bytes).unwrap_or_default();
                        let recorded = Recorded { method: parts.method.to_string(), target: parts.uri.to_string(), headers: parts.headers, body };
                        let response = handler(&recorded);

                        log.lock().unwrap().push(recorded);

                        Ok::<_, std::convert::Infallible>(response)
                    }
                });

                tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream), service).await;
                });
            }
        });

        TestServer { origin, requests }
    }
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::Verifier;

    use super::test_server::{TestServer, respond, serve};
    use super::*;
    use crate::daemon::http::no_redirect_client;
    use crate::daemon::identity::generate_identity;

    const NONCE: &str = "cmVxdWVzdC1ub25jZS0wMTIzNDU2Nzg5";

    fn identity() -> (Identity, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();

        (generate_identity(&directory.path().join("box.key")).unwrap(), directory)
    }

    async fn plane() -> TestServer {
        serve(|request| if request.target == "/moved" { respond(302, "") } else { respond(200, "{}") }).await
    }

    #[tokio::test]
    async fn signs_a_get_with_box_id_nonce_timestamp_and_an_ed25519_signature() {
        let server = plane().await;
        let (identity, _directory) = identity();
        let verifying = identity.verifying_key();
        let fetch = SignedFetch::new("box_1", &server.origin, identity, no_redirect_client()).with_nonce_and_clock(|| NONCE.to_owned(), || 1_790_000_000_000);
        let response = fetch.get(&format!("{}/v1/boxes/releases/dep_1?attempt=2", server.origin), Duration::from_secs(10)).await.unwrap();

        assert_eq!(response.status(), 200);

        let requests = server.requests.lock().unwrap();
        let headers = &requests[0].headers;
        let header = |name: &str| headers.get(name).unwrap().to_str().unwrap().to_owned();

        assert_eq!(requests[0].method, "GET");
        assert_eq!(header(HEADER_TIMESTAMP), "1790000000000");
        assert_eq!(header(HEADER_BOX_ID), "box_1");
        assert_eq!(header(HEADER_NONCE), NONCE);

        let payload = request_payload("GET", "/v1/boxes/releases/dep_1?attempt=2", "box_1", 1_790_000_000_000, NONCE).unwrap();
        let signature: [u8; 64] = URL_SAFE_NO_PAD.decode(header(HEADER_SIGNATURE)).unwrap().try_into().unwrap();

        assert!(verifying.verify(&payload, &ed25519_dalek::Signature::from_bytes(&signature)).is_ok());
    }

    #[tokio::test]
    async fn hands_back_a_redirect_instead_of_following_it() {
        let server = plane().await;
        let (identity, _directory) = identity();
        let fetch = SignedFetch::new("box_1", &server.origin, identity, no_redirect_client());
        let response = fetch.get(&format!("{}/moved", server.origin), Duration::from_secs(10)).await.unwrap();

        assert_eq!(response.status(), 302);
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn uses_a_fresh_nonce_for_every_request() {
        let server = plane().await;
        let (identity, _directory) = identity();
        let fetch = SignedFetch::new("box_1", &server.origin, identity, no_redirect_client());

        for _ in 0..2 {
            fetch.get(&format!("{}/a", server.origin), Duration::from_secs(10)).await.unwrap();
        }

        let requests = server.requests.lock().unwrap();
        let nonces: Vec<_> = requests.iter().map(|request| request.headers.get(HEADER_NONCE).unwrap().to_str().unwrap().to_owned()).collect();

        assert_eq!(nonces[0].len(), 32);
        assert_ne!(nonces[0], nonces[1]);
    }

    #[tokio::test]
    async fn refuses_another_origin_without_signing_or_sending_anything() {
        let server = plane().await;
        let (identity, _directory) = identity();
        let fetch = SignedFetch::new("box_1", &server.origin, identity, no_redirect_client());
        let host = server.origin.trim_start_matches("http://");
        let port: u16 = host.rsplit(':').next().unwrap().parse().unwrap();
        let refused = [
            "http://evil.example/v1/boxes/releases/dep_1".to_owned(),
            format!("https://{host}/v1/boxes/releases/dep_1"),
            format!("http://127.0.0.1:{}/v1/boxes/releases/dep_1", port.wrapping_add(1)),
            format!("http://someone@{host}/v1/boxes/releases/dep_1"),
            "not a url".to_owned(),
        ];

        for url in &refused {
            assert_eq!(fetch.get(url, Duration::from_secs(10)).await.unwrap_err().code, codes::ORIGIN_REFUSED, "{url}");
        }

        assert!(server.requests.lock().unwrap().is_empty());
        assert_eq!(
            fetch.get("http://evil.example/x", Duration::from_secs(10)).await.unwrap_err().message,
            format!("refusing to sign a request for http://evil.example: this box only talks to {}", server.origin)
        );
    }
}
