//! Deleting a fleet's data from the customer's bucket (plan 458 W4 `destroy`,
//! `deleteData`): every object under `fleets/{alias}/`. celld has no command
//! for it, so hostd lists and batch-deletes the prefix itself over the S3 API,
//! signed with the box's own bucket credentials (SigV4, presigned by
//! `rusty-s3`). Path-style URLs, which every S3-compatible store the box
//! supports answers.

use std::collections::BTreeMap;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use md5::{Digest, Md5};
use rusty_s3::actions::{DeleteObjects, ObjectIdentifier};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};

use super::config::BucketConfig;
use super::job_error::{JobError, codes};
use super::signed_fetch::describe_error;

/// S3's `DeleteObjects` takes at most this many keys per call.
const DELETE_BATCH: usize = 1000;

/// Listing pages before giving up — 1,000 keys each.
const MAX_PAGES: usize = 10_000;

/// How long a presigned request stays valid; each is signed just before it is sent.
const PRESIGN_FOR: Duration = Duration::from_secs(5 * 60);

fn failed(message: impl Into<String>) -> JobError {
    JobError::new(codes::BUCKET_FAILED, message)
}

/// Undo the five XML entities, in one pass (`&amp;lt;` is `&lt;`, not `<`).
fn decode_xml(text: &str) -> String {
    const ENTITIES: [(&str, &str); 5] = [("&amp;", "&"), ("&apos;", "'"), ("&gt;", ">"), ("&lt;", "<"), ("&quot;", "\"")];

    let mut decoded = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        rest = &rest[start..];

        match ENTITIES.iter().find(|(entity, _)| rest.starts_with(entity)) {
            Some((entity, character)) => {
                decoded.push_str(character);
                rest = &rest[entity.len()..];
            }
            None => {
                decoded.push('&');
                rest = &rest[1..];
            }
        }
    }

    decoded.push_str(rest);

    decoded
}

fn encode_xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Every `<{tag}>([^<]*)</{tag}>` in `text`, in order.
fn tag_values<'a>(text: &'a str, tag: &str) -> Vec<&'a str> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut values = Vec::new();
    let mut from = 0;

    while let Some(found) = text[from..].find(&open) {
        let start = from + found + open.len();
        let end = text[start..].find('<').map_or(text.len(), |offset| start + offset);

        if text[end..].starts_with(&close) {
            values.push(&text[start..end]);
        }

        from = start;
    }

    values
}

/// The bucket path-style: `{endpoint}/{bucket}`, the endpoint `https://s3.{region}.amazonaws.com` unless the config names one.
fn bucket_of(bucket: &BucketConfig) -> Result<Bucket, JobError> {
    let region = bucket.region.clone().unwrap_or_else(|| "us-east-1".to_owned());
    let endpoint = bucket.endpoint.clone().unwrap_or_else(|| format!("https://s3.{region}.amazonaws.com"));
    // A trailing `/`, so the bucket joins onto the endpoint's path instead of replacing its last segment.
    let base = format!("{}/", endpoint.trim_end_matches('/'));
    let parsed = url::Url::parse(&base).map_err(|_| failed(format!("the bucket endpoint {endpoint} is not a URL")))?;

    Bucket::new(parsed, UrlStyle::Path, bucket.name.clone(), region).map_err(|_| failed(format!("the bucket endpoint {endpoint} is not an http(s) URL")))
}

fn credentials_of(credentials: &BTreeMap<String, String>) -> Result<Credentials, JobError> {
    let (Some(key), Some(secret)) = (credentials.get("AWS_ACCESS_KEY_ID"), credentials.get("AWS_SECRET_ACCESS_KEY")) else {
        return Err(failed("no bucket credentials in the credentials file; hostd needs them to delete a fleet's data"));
    };

    Ok(match credentials.get("AWS_SESSION_TOKEN") {
        Some(token) => Credentials::new_with_token(key, secret, token),
        None => Credentials::new(key, secret),
    })
}

/// Send `request`; its body, or `BUCKET_FAILED` naming the status and the start of what the bucket said.
async fn send(request: reqwest::RequestBuilder, method: &str, path: &str) -> Result<String, JobError> {
    // The URL is presigned: its query holds the access key id, the session token and the signature. Never let it
    // into a message, which goes to the control plane in `result.error` and into the journal.
    let transport = |error: reqwest::Error| JobError::new(codes::JOB_FAILED, describe_error(&error.without_url()));
    let response = request.send().await.map_err(transport)?;
    let status = response.status();
    let body = response.text().await.map_err(transport)?;

    if !status.is_success() {
        let mut units = 0;
        let start: String = body
            .chars()
            .take_while(|character| {
                units += character.len_utf16();

                units <= 300
            })
            .collect();

        return Err(failed(format!("{method} {path} answered {}: {start}", status.as_u16())));
    }

    Ok(body)
}

/// Delete every object under `prefix` (which must end in `/`); how many were deleted.
/// `BUCKET_FAILED` when the bucket refuses a list or a delete.
pub async fn delete_prefix(prefix: &str, bucket: &BucketConfig, credentials: &BTreeMap<String, String>, client: &reqwest::Client) -> Result<u64, JobError> {
    if !prefix.ends_with('/') || prefix == "/" {
        return Err(failed(format!("refusing to delete prefix {}: it must name a directory", serde_json::to_string(prefix).unwrap_or_default())));
    }

    let credentials = credentials_of(credentials)?;
    let bucket = bucket_of(bucket)?;
    let path = bucket.base_url().path().trim_end_matches('/').to_owned();
    let mut deleted = 0;
    let mut token: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let mut list = bucket.list_objects_v2(Some(&credentials));

        // Keys come back as XML text, which is all this reads.
        list.query_mut().remove("encoding-type");
        list.with_prefix(prefix);

        if let Some(token) = &token {
            list.with_continuation_token(token.as_str());
        }

        let listing = send(client.get(list.sign(PRESIGN_FOR)), "GET", &path).await?;
        let keys: Vec<String> = tag_values(&listing, "Key").into_iter().map(decode_xml).collect();

        for batch in keys.chunks(DELETE_BATCH) {
            let objects: String = batch.iter().map(|key| format!("<Object><Key>{}</Key></Object>", encode_xml(key))).collect();
            let body = format!("<Delete><Quiet>true</Quiet>{objects}</Delete>");
            // S3 requires Content-MD5 on DeleteObjects as an integrity check of the body, not for security.
            let content_md5 = STANDARD.encode(Md5::digest(body.as_bytes()));
            let mut delete = DeleteObjects::new(&bucket, Some(&credentials), std::iter::empty::<&ObjectIdentifier>());

            delete.headers_mut().insert("content-md5", content_md5.clone());
            delete.headers_mut().insert("content-type", "application/xml");

            let request = client.post(delete.sign(PRESIGN_FOR)).header("content-md5", content_md5).header("content-type", "application/xml").body(body);

            send(request, "POST", &path).await?;
            deleted += batch.len() as u64;
        }

        token = listing
            .contains("<IsTruncated>true</IsTruncated>")
            .then(|| decode_xml(tag_values(&listing, "NextContinuationToken").first().copied().unwrap_or_default()));

        if token.as_deref().is_none_or(str::is_empty) {
            return Ok(deleted);
        }
    }

    Err(failed(format!("{prefix} has more objects than one destroy deletes; run it again")))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::super::signed_fetch::test_server::{Recorded, TestServer, respond, serve};
    use super::*;

    const PAGE: usize = 1200;

    fn credentials() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("AWS_ACCESS_KEY_ID".to_owned(), "test-key".to_owned()),
            ("AWS_SECRET_ACCESS_KEY".to_owned(), "test-secret".to_owned()),
            ("AWS_SESSION_TOKEN".to_owned(), "test-token".to_owned()),
        ])
    }

    fn query_of(request: &Recorded) -> BTreeMap<String, String> {
        url::Url::parse(&format!("http://s3{}", request.target)).unwrap().query_pairs().into_owned().collect()
    }

    /// A bucket at `{origin}/s3/customer-bucket` listing `PAGE` keys a page, checking each delete's body and MD5.
    async fn fake_s3(objects: Vec<String>) -> (TestServer, Arc<Mutex<Vec<String>>>) {
        let objects = Arc::new(Mutex::new(objects));
        let store = Arc::clone(&objects);
        let server = serve(move |request| {
            let query = query_of(request);
            let mut objects = store.lock().unwrap();

            assert!(request.target.starts_with("/s3/customer-bucket/?"), "{}", request.target);
            assert_eq!(query.get("X-Amz-Security-Token").map(String::as_str), Some("test-token"));

            if request.method == "POST" {
                let body = std::str::from_utf8(&request.body).unwrap();
                let md5 = request.headers.get("content-md5").unwrap().to_str().unwrap();

                assert!(query.contains_key("delete"));
                assert_eq!(md5, STANDARD.encode(Md5::digest(&request.body)));
                assert!(body.starts_with("<Delete><Quiet>true</Quiet><Object><Key>"), "{body}");

                let keys: Vec<String> = tag_values(body, "Key").into_iter().map(decode_xml).collect();

                assert!(keys.len() <= DELETE_BATCH);
                objects.retain(|key| !keys.contains(key));

                return respond(200, "<DeleteResult/>");
            }

            let prefix = query.get("prefix").cloned().unwrap_or_default();
            // The token is the last key listed, as opaque to the client as S3's own.
            let after = query.get("continuation-token").cloned().unwrap_or_default();
            let mut matching: Vec<&String> = objects.iter().filter(|key| key.starts_with(&prefix) && **key > after).collect();

            matching.sort();

            let page = &matching[..PAGE.min(matching.len())];
            let contents: String = page.iter().map(|key| format!("<Contents><Key>{}</Key><Size>1</Size></Contents>", encode_xml(key))).collect();
            let truncated = PAGE < matching.len();
            let next = if truncated { format!("<NextContinuationToken>{}</NextContinuationToken>", encode_xml(page[PAGE - 1])) } else { String::new() };

            respond(200, format!("<?xml version=\"1.0\"?><ListBucketResult><Name>customer-bucket</Name>{contents}<IsTruncated>{truncated}</IsTruncated>{next}</ListBucketResult>"))
        })
        .await;

        (server, objects)
    }

    fn bucket(server: &TestServer) -> BucketConfig {
        BucketConfig { name: "customer-bucket".into(), endpoint: Some(format!("{}/s3/", server.origin)), region: None }
    }

    #[tokio::test]
    async fn never_puts_the_presigned_url_in_an_error() {
        let mut credentials = credentials();

        credentials.insert("AWS_SESSION_TOKEN".to_owned(), "the-session-token".to_owned());

        // Nothing listens on port 1: the request fails in transport, where reqwest names the URL.
        let bucket = BucketConfig { name: "customer-bucket".into(), endpoint: Some("http://127.0.0.1:1".into()), region: None };
        let error = delete_prefix("fleets/my-app/", &bucket, &credentials, &reqwest::Client::new()).await.unwrap_err();

        assert!(!error.message.contains("the-session-token") && !error.message.contains("test-key") && !error.message.contains("X-Amz"), "{}", error.message);
    }

    #[tokio::test]
    async fn deletes_exactly_the_prefix_page_by_page_in_batches() {
        let mut objects: Vec<String> = (0..1500).map(|index| format!("fleets/my-app/cells/{index}.db")).collect();

        objects.extend(["fleets/my-app/a&b <c>.json".to_owned(), "fleets/my-app-2/keep.json".to_owned(), "fleets/other/keep.json".to_owned()]);

        let (server, remaining) = fake_s3(objects).await;
        let deleted = delete_prefix("fleets/my-app/", &bucket(&server), &credentials(), &crate::daemon::http::client()).await.unwrap();

        assert_eq!(deleted, 1501);
        assert_eq!(*remaining.lock().unwrap(), ["fleets/my-app-2/keep.json", "fleets/other/keep.json"]);

        let requests = server.requests.lock().unwrap();
        let methods: Vec<&str> = requests.iter().map(|request| request.method.as_str()).collect();

        // Two pages; the first takes two deletes (1,000 + 200 keys), the second one.
        assert_eq!(methods, ["GET", "POST", "POST", "GET", "POST"]);
        assert_eq!(query_of(&requests[0]).get("list-type").map(String::as_str), Some("2"));
        assert!(!query_of(&requests[0]).contains_key("encoding-type"));
        assert!(query_of(&requests[3]).get("continuation-token").is_some_and(|token| token.starts_with("fleets/my-app/")));
    }

    #[tokio::test]
    async fn names_the_status_and_what_the_bucket_said() {
        let server = serve(|_| respond(403, format!("<Error><Code>AccessDenied</Code></Error>{}", "x".repeat(400)))).await;
        let error = delete_prefix("fleets/my-app/", &bucket(&server), &credentials(), &crate::daemon::http::client()).await.unwrap_err();

        assert_eq!(error.code, codes::BUCKET_FAILED);
        assert!(error.message.starts_with("GET /s3/customer-bucket answered 403: <Error><Code>AccessDenied</Code></Error>xxx"), "{}", error.message);
        assert_eq!(error.message.len(), "GET /s3/customer-bucket answered 403: ".len() + 300);
    }

    #[tokio::test]
    async fn refuses_a_prefix_that_is_not_a_directory_and_missing_credentials() {
        let config = BucketConfig { name: "b".into(), endpoint: None, region: None };
        let client = crate::daemon::http::client();

        for prefix in ["fleets/my-app", "/"] {
            assert_eq!(
                delete_prefix(prefix, &config, &credentials(), &client).await.unwrap_err(),
                failed(format!("refusing to delete prefix \"{prefix}\": it must name a directory"))
            );
        }

        assert_eq!(
            delete_prefix("fleets/my-app/", &config, &BTreeMap::new(), &client).await.unwrap_err(),
            failed("no bucket credentials in the credentials file; hostd needs them to delete a fleet's data")
        );
    }

    #[test]
    fn defaults_to_the_regional_aws_endpoint_path_style() {
        let at = |region: Option<&str>| {
            bucket_of(&BucketConfig { name: "b".into(), endpoint: None, region: region.map(str::to_owned) }).unwrap().base_url().to_string()
        };

        assert_eq!(at(None), "https://s3.us-east-1.amazonaws.com/b/");
        assert_eq!(at(Some("eu-west-1")), "https://s3.eu-west-1.amazonaws.com/b/");
    }

    #[test]
    fn reads_tags_and_entities_as_the_patterns_do() {
        assert_eq!(tag_values("<Key>a</Key><Key>b<x/></Key><Key></Key>", "Key"), ["a", ""]);
        assert_eq!(decode_xml("a&amp;lt;b&quot;&unknown;"), "a&lt;b\"&unknown;");
        assert_eq!(encode_xml("<a & 'b'>"), "&lt;a &amp; &apos;b&apos;&gt;");
    }
}
