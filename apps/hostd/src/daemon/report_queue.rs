//! Reports waiting to be sent (plan 458 W6): while the box is offline its
//! closed minute windows queue here — at most a day of them, the oldest the
//! control plane still records — and drain a few at a time once it is back,
//! well under the control plane's per-minute cap.

use std::collections::VecDeque;

use super::reports::MINUTE_MS;
use crate::wire::types::ReportMessage;

/// Reports kept while the box cannot send: a day of minutes, the oldest the control plane still records.
pub const MAX_PENDING: usize = 1440;

/// Reports sent per drain. Drained every ten seconds, that is 30 a minute, half the control plane's cap.
pub const REPORTS_PER_DRAIN: usize = 5;

/// Reports waiting to be sent, oldest first: bounded, and drained under the control plane's per-minute cap.
#[derive(Default)]
pub struct ReportQueue {
    pending: VecDeque<ReportMessage>,
}

impl ReportQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn push(&mut self, reports: impl IntoIterator<Item = ReportMessage>) {
        self.pending.extend(reports);

        if self.pending.len() > MAX_PENDING {
            self.pending.drain(..self.pending.len() - MAX_PENDING);
        }
    }

    /// Send up to [`REPORTS_PER_DRAIN`] reports with `send`, dropping any
    /// older than a day (the control plane refuses them). A report `send`
    /// refuses stays queued.
    pub fn drain(&mut self, mut send: impl FnMut(&ReportMessage) -> bool, now_ms: u64) -> usize {
        let oldest = now_ms.saturating_sub(24 * 60 * MINUTE_MS);

        while self.pending.front().is_some_and(|report| report.window_start < oldest) {
            self.pending.pop_front();
        }

        let mut sent = 0;

        while sent < REPORTS_PER_DRAIN {
            let Some(report) = self.pending.front() else {
                break;
            };

            if !send(report) {
                break;
            }

            self.pending.pop_front();
            sent += 1;
        }

        sent
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: u64 = 60_000;
    /// A whole minute.
    const T0: u64 = 1_790_000_040_000;

    fn report(window_start: u64) -> ReportMessage {
        ReportMessage { per_alias: vec![], window_end: window_start + MINUTE, window_start }
    }

    #[test]
    fn drains_a_few_reports_at_a_time_oldest_first_and_keeps_what_could_not_be_sent() {
        let mut queue = ReportQueue::new();
        let mut sent = Vec::new();

        queue.push((0..8).map(|index| report(T0 + index * MINUTE)));

        assert_eq!(
            queue.drain(
                |message| {
                    sent.push(message.window_start);
                    true
                },
                T0 + 10 * MINUTE
            ),
            REPORTS_PER_DRAIN
        );
        assert_eq!(queue.drain(|_| false, T0 + 10 * MINUTE), 0);
        assert_eq!(queue.len(), 8 - REPORTS_PER_DRAIN);
        assert_eq!(sent, (0..REPORTS_PER_DRAIN as u64).map(|index| T0 + index * MINUTE).collect::<Vec<_>>());
    }

    #[test]
    fn forgets_windows_older_than_a_day() {
        let mut queue = ReportQueue::new();

        queue.push([report(T0)]);
        queue.drain(|_| false, T0 + 25 * 60 * MINUTE);

        assert!(queue.is_empty());
    }

    #[test]
    fn keeps_at_most_a_day_of_reports() {
        let mut queue = ReportQueue::new();

        queue.push((0..MAX_PENDING as u64 + 10).map(|index| report(T0 + index * MINUTE)));

        assert_eq!(queue.len(), MAX_PENDING);
        assert_eq!(queue.pending.front().map(|report| report.window_start), Some(T0 + 10 * MINUTE));
    }
}
