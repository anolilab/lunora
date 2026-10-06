//! Request counts for the studio (plan 458 W6, on-box half): hostd tails
//! Caddy's JSON access log, counts requests per alias per whole minute —
//! requests, errors (status ≥ 500) and the median latency — and sends one
//! `report` per closed minute.
//!
//! The control plane records a window only when it starts on a whole minute,
//! once per box and window, and at most an hour long and a day old (protocol
//! §5.1), so only CLOSED minute windows are ever sent, and a window resent
//! after a reconnect is harmless. Reports wait in a bounded queue while the box
//! is offline and drain a few at a time, under the control plane's per-minute
//! cap. Displayed, never billed (D12).

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use crate::wire::LIMITS;
use crate::wire::types::{AliasReport, ReportMessage, RouteEntry};

pub const MINUTE_MS: u64 = 60_000;

/// How long after a minute ends its window is closed: late access-log lines still land in it.
pub const CLOSE_GRACE_MS: u64 = 5000;

/// Latency samples kept per alias per minute; beyond it the median is of the first ones.
const MAX_SAMPLES: usize = 10_000;

#[derive(Default)]
struct AliasCounts {
    durations: Vec<f64>,
    errors: u64,
    requests: u64,
}

/// One access-log line, reduced to what a report counts.
#[derive(Clone, Debug, PartialEq)]
pub struct AccessEntry {
    /// Epoch ms.
    pub at: i64,
    pub duration_ms: f64,
    pub host: String,
    pub status: f64,
}

/// `Math.round`: halves round up, towards positive infinity.
fn js_round(value: f64) -> f64 {
    let rounded = value.round();

    if value - rounded == 0.5 { rounded + 1.0 } else { rounded }
}

/// A Host header may carry a port (`:\d+$`); the routing table never does.
fn strip_port(host: &str) -> &str {
    match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) => name,
        _ => host,
    }
}

/// Parse one Caddy JSON access-log line; `None` for anything else.
pub fn parse_access_line(line: &str) -> Option<AccessEntry> {
    let parsed: Value = serde_json::from_str(line).ok()?;
    let ts = parsed.get("ts")?.as_f64()?;
    let status = parsed.get("status")?.as_f64()?;
    let duration = parsed.get("duration")?.as_f64()?;
    let host = parsed.get("request")?.get("host")?.as_str()?;

    // Saturates on an absurd timestamp, which then lands in no window anyone reports.
    #[allow(clippy::cast_possible_truncation)]
    let at = js_round(ts * 1000.0) as i64;

    Some(AccessEntry { at, duration_ms: (duration * 1000.0).max(0.0), host: strip_port(&host.to_lowercase()).to_owned(), status })
}

/// The median, rounded to two decimals.
fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();

    sorted.sort_by(f64::total_cmp);

    let middle = sorted.len() / 2;
    let value = if sorted.is_empty() {
        0.0
    } else if sorted.len().is_multiple_of(2) {
        f64::midpoint(sorted[middle - 1], sorted[middle])
    } else {
        sorted[middle]
    };

    js_round(value * 100.0) / 100.0
}

/// Counts access-log entries into minute windows and hands out the closed ones.
#[derive(Default)]
pub struct ReportAggregator {
    windows: BTreeMap<i64, HashMap<String, AliasCounts>>,
    /// Windows starting before this were already reported; a late line for one is dropped.
    closed_before: i64,
    host_to_alias: HashMap<String, String>,
}

impl ReportAggregator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Use `routes` to tell which alias a hostname belongs to.
    pub fn set_routes(&mut self, routes: &[RouteEntry]) {
        self.host_to_alias = routes.iter().map(|route| (route.hostname.clone(), route.alias.clone())).collect();
    }

    /// Count one access-log line. Lines for unrouted hosts, and late lines for closed windows, are dropped.
    pub fn ingest(&mut self, line: &str) {
        let Some(entry) = parse_access_line(line) else {
            return;
        };
        let Some(alias) = self.host_to_alias.get(&entry.host) else {
            return;
        };
        #[allow(clippy::cast_possible_wrap)]
        let window_start = entry.at.div_euclid(MINUTE_MS as i64) * MINUTE_MS as i64;

        if window_start < self.closed_before {
            return;
        }

        let counts = self.windows.entry(window_start).or_default().entry(alias.clone()).or_default();

        counts.requests += 1;
        counts.errors += u64::from(entry.status >= 500.0);

        if counts.durations.len() < MAX_SAMPLES {
            counts.durations.push(entry.duration_ms);
        }
    }

    /// The reports of every window closed by `now_ms`, oldest first; they are forgotten here.
    pub fn close(&mut self, now_ms: u64) -> Vec<ReportMessage> {
        let mut reports = Vec::new();

        while let Some(entry) = self.windows.first_entry() {
            // Every window start is at least `closed_before`, so never negative.
            let window_start = u64::try_from(*entry.key()).unwrap_or_default();

            if window_start + MINUTE_MS + CLOSE_GRACE_MS > now_ms {
                break;
            }

            let mut per_alias: Vec<(String, AliasCounts)> = entry.remove().into_iter().collect();

            per_alias.sort_by(|(a, left), (b, right)| right.requests.cmp(&left.requests).then_with(|| a.cmp(b)));
            per_alias.truncate(LIMITS.max_report_aliases);

            let window_end = window_start + MINUTE_MS;

            self.closed_before = i64::try_from(window_end).unwrap_or(i64::MAX);
            reports.push(ReportMessage {
                per_alias: per_alias
                    .into_iter()
                    .map(|(alias, counts)| AliasReport { alias, errors: counts.errors, p50_ms: Some(median(&counts.durations)), requests: counts.requests })
                    .collect(),
                window_end,
                window_start,
            });
        }

        reports
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const MINUTE: u64 = 60_000;
    /// A whole minute.
    const T0: u64 = 1_790_000_040_000;

    #[allow(clippy::cast_precision_loss)]
    fn line(at: u64, host: &str, status: u16, duration_seconds: f64) -> String {
        json!({ "duration": duration_seconds, "logger": "http.log.access.lunora", "request": { "host": host, "method": "GET" }, "status": status, "ts": at as f64 / 1000.0 }).to_string()
    }

    fn routes() -> Vec<RouteEntry> {
        vec![
            RouteEntry { alias: "shop".into(), hostname: "shop.bx.boxes.test".into() },
            RouteEntry { alias: "docs".into(), hostname: "docs.bx.boxes.test".into() },
        ]
    }

    #[test]
    fn reads_time_host_status_and_duration() {
        assert_eq!(
            parse_access_line(&line(T0 + 1500, "Shop.BX.boxes.test:443", 502, 0.25)),
            Some(AccessEntry { at: 1_790_000_041_500, duration_ms: 250.0, host: "shop.bx.boxes.test".into(), status: 502.0 })
        );
        assert_eq!(parse_access_line("not json"), None);
        assert_eq!(parse_access_line(r#"{"ts":1,"status":200,"duration":0,"request":"x"}"#), None);
    }

    #[test]
    fn reports_only_closed_whole_minute_windows_per_alias() {
        let mut aggregator = ReportAggregator::new();

        aggregator.set_routes(&routes());
        aggregator.ingest(&line(T0 + 1000, "shop.bx.boxes.test", 200, 0.01));
        aggregator.ingest(&line(T0 + 2000, "shop.bx.boxes.test", 500, 0.03));
        aggregator.ingest(&line(T0 + 3000, "shop.bx.boxes.test", 200, 0.02));
        aggregator.ingest(&line(T0 + 4000, "docs.bx.boxes.test", 200, 0.01));
        aggregator.ingest(&line(T0 + MINUTE + 1000, "docs.bx.boxes.test", 200, 0.01));

        // The first minute has not closed (grace included) — nothing yet.
        assert_eq!(aggregator.close(T0 + MINUTE + 1000), vec![]);
        assert_eq!(
            aggregator.close(T0 + MINUTE + 6000),
            vec![ReportMessage {
                per_alias: vec![
                    AliasReport { alias: "shop".into(), errors: 1, p50_ms: Some(20.0), requests: 3 },
                    AliasReport { alias: "docs".into(), errors: 0, p50_ms: Some(10.0), requests: 1 },
                ],
                window_end: T0 + MINUTE,
                window_start: T0,
            }]
        );
    }

    #[test]
    fn drops_unrouted_hosts_and_late_lines_for_a_reported_window() {
        let mut aggregator = ReportAggregator::new();

        aggregator.set_routes(&routes());
        aggregator.ingest(&line(T0 + 1000, "unknown.example", 200, 0.01));
        aggregator.ingest(&line(T0 + 1000, "shop.bx.boxes.test", 200, 0.01));

        assert_eq!(aggregator.close(T0 + 2 * MINUTE).len(), 1);

        aggregator.ingest(&line(T0 + 2000, "shop.bx.boxes.test", 200, 0.01));

        assert_eq!(aggregator.close(T0 + 3 * MINUTE), vec![]);
    }

    #[test]
    fn caps_a_report_at_the_protocols_500_aliases_busiest_first() {
        let mut aggregator = ReportAggregator::new();
        let routes: Vec<RouteEntry> = (0..520).map(|index| RouteEntry { alias: format!("a{index}"), hostname: format!("a{index}.bx.test") }).collect();

        aggregator.set_routes(&routes);

        for (index, route) in routes.iter().enumerate() {
            for _ in 0..=index % 3 {
                aggregator.ingest(&line(T0 + 1000, &route.hostname, 200, 0.01));
            }
        }

        let reports = aggregator.close(T0 + 2 * MINUTE);

        assert_eq!(reports[0].per_alias.len(), 500);
        assert_eq!(reports[0].per_alias[0].requests, 3);
    }

    #[test]
    fn rounds_the_median_to_two_decimals() {
        assert!((median(&[1.0, 2.0]) - 1.5).abs() < f64::EPSILON);
        assert!((median(&[0.123_456, 9.0, 0.001]) - 0.12).abs() < f64::EPSILON);
    }
}
