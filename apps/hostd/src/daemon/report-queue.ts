/**
 * Reports waiting to be sent (plan 458 W6): while the box is offline its
 * closed minute windows queue here — at most a day of them, the oldest the
 * control plane still records — and drain a few at a time once it is back,
 * well under the control plane's per-minute cap.
 */
import type { ReportMessage } from "../wire/types";
import { MINUTE_MS } from "./reports";

/** Reports kept while the box cannot send: a day of minutes, the oldest the control plane still records. */
const MAX_PENDING = 1440;

/** Reports sent per drain. Drained every ten seconds, that is 30 a minute, half the control plane's cap. */
const REPORTS_PER_DRAIN = 5;

/** Reports waiting to be sent, oldest first: bounded, and drained under the control plane's per-minute cap. */
class ReportQueue {
    private readonly pending: ReportMessage[] = [];

    public get size(): number {
        return this.pending.length;
    }

    public push(reports: ReadonlyArray<ReportMessage>): void {
        this.pending.push(...reports);

        if (this.pending.length > MAX_PENDING) {
            this.pending.splice(0, this.pending.length - MAX_PENDING);
        }
    }

    /**
     * Send up to {@link REPORTS_PER_DRAIN} reports with `send`, dropping any
     * older than a day (the control plane refuses them). A report `send`
     * refuses stays queued.
     */
    public drain(send: (report: ReportMessage) => boolean, now: number): number {
        while (this.pending.length > 0 && (this.pending[0]?.windowStart ?? now) < now - 24 * 60 * MINUTE_MS) {
            this.pending.shift();
        }

        let sent = 0;

        while (sent < REPORTS_PER_DRAIN && this.pending.length > 0) {
            const report = this.pending[0] as ReportMessage;

            if (!send(report)) {
                break;
            }

            this.pending.shift();
            sent += 1;
        }

        return sent;
    }
}

export { MAX_PENDING, ReportQueue, REPORTS_PER_DRAIN };
