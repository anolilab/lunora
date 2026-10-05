/**
 * hostd's own logs, forwarded to Lunora Cloud (plan 458 W6, "Platform logs"):
 * the daemon's warnings and errors, each celld node's stderr (its filter is
 * `RUST_LOG=error,celld=warn`) and Caddy's error log, as OTLP log records
 * posted to `{endpoint}/v1/logs` with the organization's ingest key — both
 * from the control plane's `config` frame (protocol §5.2), held in memory
 * only.
 *
 * Every record is tagged `box` (the box's slug) and, for a fleet, `alias`;
 * `service.name` is `lunora-hostd` for hostd's and Caddy's lines and the alias
 * for a fleet's, which is how the control plane files them.
 *
 * Bounded and lossy by design: at most {@link MAX_BUFFERED} records wait —
 * while no endpoint is configured, while the control plane is unreachable —
 * and the oldest are dropped first, counted in a record of their own. A
 * failed post is retried with backoff (5 s doubling to 5 min); nothing here
 * ever blocks the daemon.
 *
 * Never a secret: each line is cut to {@link MAX_MESSAGE_BYTES}, and before
 * it leaves the box every value the forwarder knows to be secret (the ingest
 * key itself, the bucket credentials) and every shape that looks like one (a
 * bearer token, an `AWS_*=` assignment, an enrolment token, a private key) is
 * replaced with `[redacted]`. hostd's own failures to forward go to its local
 * log only, never into the buffer.
 */
import type { TelemetryConfig } from "../wire/types";
import { truncateUtf8 } from "./job-error";
import type { Logger } from "./log";

/** Records held while they cannot be sent; the oldest go first. */
const MAX_BUFFERED = 1000;

/** Records per post. */
const MAX_BATCH = 200;

/** Longest record body, in UTF-8 bytes. */
const MAX_MESSAGE_BYTES = 8192;

/** How often buffered records are posted. */
const FLUSH_INTERVAL_MS = 5000;

/** Retry backoff after a failed post: 5 s doubling to 5 min. */
const RETRY_BACKOFF = { maxMs: 300_000, minMs: 5000 } as const;

/** How long one post may take. */
const POST_TIMEOUT_MS = 10_000;

type LogSeverity = "error" | "info" | "warn";

/** Where a line came from. */
type LogSource = "caddy" | "celld" | "hostd";

/** One line to forward. */
interface ForwardedLog {
    /** The fleet a celld line belongs to. */
    alias?: string;
    atMs: number;
    message: string;
    severity: LogSeverity;
    source: LogSource;
}

/** OTLP severity numbers (logs data model): INFO 9, WARN 13, ERROR 17. */
const SEVERITY_NUMBER: Readonly<Record<LogSeverity, number>> = { error: 17, info: 9, warn: 13 };

const REDACTED = "[redacted]";

/** Shapes that are secrets whoever's they are. */
const SECRET_SHAPES: ReadonlyArray<RegExp> = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
    /\bbearer\s+\S+/giu,
    /\bauthorization\s*[:=]\s*\S+/giu,
    /\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)=\S+/gu,
    /\blbe_[\da-f]{16,}\b/gu,
];

/** Shorter values are never redacted by value: they would match ordinary words. */
const MIN_SECRET_LENGTH = 8;

/** `line` with every known secret value and every secret-shaped run replaced. */
const redactSecrets = (line: string, secrets: ReadonlyArray<string>): string => {
    let redacted = line;

    for (const secret of secrets) {
        if (secret.length >= MIN_SECRET_LENGTH) {
            redacted = redacted.split(secret).join(REDACTED);
        }
    }

    for (const shape of SECRET_SHAPES) {
        redacted = redacted.replaceAll(shape, REDACTED);
    }

    return redacted;
};

const CELLD_LEVEL = /\b(ERROR|WARN)\b/u;

/** The severity of a celld line (`… ERROR celld::…` / `… WARN …`); anything else celld prints on stderr counts as a warning. */
const celldSeverity = (line: string): LogSeverity => (CELLD_LEVEL.exec(line)?.[1] === "ERROR" ? "error" : "warn");

const CADDY_SEVERITIES: Readonly<Record<string, LogSeverity>> = { dpanic: "error", error: "error", fatal: "error", panic: "error", warn: "warn" };

/** A Caddy log line worth forwarding — a JSON line at warn or above — or `undefined`. */
const caddyLog = (line: string): { message: string; severity: LogSeverity } | undefined => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(line);
    } catch {
        return undefined;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return undefined;
    }

    const { level } = parsed as { level?: unknown };
    const severity = typeof level === "string" ? CADDY_SEVERITIES[level] : undefined;

    return severity === undefined ? undefined : { message: line, severity };
};

/** `{endpoint}/v1/logs`, whether or not the endpoint ends in a slash. */
const logsUrlOf = (endpoint: string): string => {
    let base = endpoint;

    while (base.endsWith("/")) {
        base = base.slice(0, -1);
    }

    return `${base}/v1/logs`;
};

type KeyValue = { key: string; value: { stringValue: string } };

const attribute = (key: string, value: string): KeyValue => {
    return { key, value: { stringValue: value } };
};

/** The OTLP/JSON logs export for `records`: one resource per `service.name`. */
const otlpLogsPayload = (records: ReadonlyArray<ForwardedLog>, boxSlug: string): Record<string, unknown> => {
    const byService = new Map<string, ForwardedLog[]>();

    for (const record of records) {
        const service = record.source === "celld" && record.alias !== undefined ? record.alias : "lunora-hostd";

        byService.set(service, [...(byService.get(service) ?? []), record]);
    }

    return {
        resourceLogs: [...byService.entries()].map(([service, entries]) => {
            return {
                resource: { attributes: [attribute("service.name", service), attribute("box", boxSlug)] },
                scopeLogs: [
                    {
                        logRecords: entries.map((entry) => {
                            return {
                                attributes: [
                                    attribute("box", boxSlug),
                                    ...(entry.alias === undefined ? [] : [attribute("alias", entry.alias)]),
                                    attribute("source", entry.source),
                                ],
                                body: { stringValue: entry.message },
                                severityNumber: SEVERITY_NUMBER[entry.severity],
                                severityText: entry.severity.toUpperCase(),
                                timeUnixNano: `${String(entry.atMs)}000000`,
                            };
                        }),
                        scope: { name: "lunora-hostd" },
                    },
                ],
            };
        }),
    };
};

interface LogForwarderOptions {
    /** The box's slug (the first label of its hostname), on every record. */
    boxSlug: string;
    /** The control plane's origin: an `http:` endpoint is accepted only when it is `http:` itself (a development box). */
    controlPlane: string;
    /** Injected for tests. */
    fetch?: typeof fetch;
    /** hostd's local log, for the forwarder's own failures — never forwarded. */
    logger: Logger;
    now?: () => number;
    /** Values never to send (the bucket credentials), read at each post. */
    secrets: () => ReadonlyArray<string>;
}

/** Buffers hostd's, celld's and Caddy's log lines and posts them as OTLP logs. */
class LogForwarder {
    /** Records dropped since the last post, oldest first, for a buffer that overflowed. */
    private dropped = 0;

    private failures = 0;

    private flushing: Promise<void> | undefined;

    private nextAttemptAt = 0;

    private readonly records: ForwardedLog[] = [];

    private telemetry: TelemetryConfig | undefined;

    private timer: ReturnType<typeof setInterval> | undefined;

    private readonly options: LogForwarderOptions;

    public constructor(options: LogForwarderOptions) {
        this.options = options;
    }

    /** Records waiting to be posted. */
    public get pending(): number {
        return this.records.length;
    }

    /** Where to post, from the control plane's `config`; `undefined` stops forwarding (records still wait, bounded). */
    public configure(telemetry: TelemetryConfig | undefined): void {
        if (telemetry !== undefined && new URL(telemetry.endpoint).protocol === "http:" && new URL(this.options.controlPlane).protocol !== "http:") {
            this.options.logger.warn("not forwarding logs: the control plane named a plain-http log endpoint, which would expose its ingest key");
            this.telemetry = undefined;

            return;
        }

        this.telemetry = telemetry;
        this.failures = 0;
        this.nextAttemptAt = 0;
    }

    /** Queue one line; the oldest is dropped when the buffer is full. */
    public push(log: Omit<ForwardedLog, "atMs" | "message"> & { atMs?: number; message: string }): void {
        const message = log.message.trim();

        if (message === "") {
            return;
        }

        this.records.push({ ...log, atMs: log.atMs ?? (this.options.now ?? Date.now)(), message });

        while (this.records.length > MAX_BUFFERED) {
            this.records.shift();
            this.dropped += 1;
        }
    }

    /** A celld node's stderr line. */
    public pushCelld(alias: string, line: string): void {
        this.push({ alias, message: line, severity: celldSeverity(line), source: "celld" });
    }

    /** A Caddy log line: forwarded at warn and above only. */
    public pushCaddy(line: string): void {
        const log = caddyLog(line);

        if (log !== undefined) {
            this.push({ message: log.message, severity: log.severity, source: "caddy" });
        }
    }

    /** Post buffered records every few seconds. */
    public start(intervalMs: number = FLUSH_INTERVAL_MS): void {
        this.timer ??= setInterval(() => {
            this.flush().catch(() => undefined);
        }, intervalMs);
        this.timer.unref();
    }

    /** Stop posting, after one last attempt (bounded by the post timeout). */
    public async stop(): Promise<void> {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }

        this.nextAttemptAt = 0;
        await this.flush().catch(() => undefined);
    }

    /** Post one batch now, when an endpoint is configured and no retry is pending. Never rejects. */
    public async flush(): Promise<void> {
        this.flushing ??= this.post().finally(() => {
            this.flushing = undefined;
        });

        await this.flushing;
    }

    private async post(): Promise<void> {
        const { telemetry } = this;
        const now = (this.options.now ?? Date.now)();

        if (telemetry === undefined || (this.records.length === 0 && this.dropped === 0) || now < this.nextAttemptAt) {
            return;
        }

        const batch = this.records.splice(0, MAX_BATCH);
        const { dropped } = this;
        const secrets = [telemetry.token, ...this.options.secrets()];
        const outgoing = [
            ...(dropped === 0
                ? []
                : [
                      {
                          atMs: now,
                          message: `${String(dropped)} log records were dropped: the buffer was full`,
                          severity: "warn" as const,
                          source: "hostd" as const,
                      },
                  ]),
            ...batch,
        ].map((record) => {
            return { ...record, message: truncateUtf8(redactSecrets(record.message, secrets), MAX_MESSAGE_BYTES) };
        });

        this.dropped = 0;

        let status = 0;

        try {
            const response = await (this.options.fetch ?? globalThis.fetch)(logsUrlOf(telemetry.endpoint), {
                body: JSON.stringify(otlpLogsPayload(outgoing, this.options.boxSlug)),
                headers: { authorization: `Bearer ${telemetry.token}`, "content-type": "application/json" },
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(POST_TIMEOUT_MS),
            });

            status = response.status;
            await response.body?.cancel();
        } catch {
            // Unreachable: status stays 0.
        }

        if (status >= 200 && status < 300) {
            if (this.failures > 0) {
                this.options.logger.info("forwarding logs to the control plane again");
            }

            this.failures = 0;

            return;
        }

        // Back in front, oldest first, still bounded; what does not fit is counted as dropped.
        this.records.unshift(...batch);
        this.dropped += dropped;

        while (this.records.length > MAX_BUFFERED) {
            this.records.shift();
            this.dropped += 1;
        }

        if (this.failures === 0) {
            this.options.logger.warn(
                `could not forward logs to the control plane (${status === 0 ? "unreachable" : `HTTP ${String(status)}`}); retrying with backoff`,
            );
        }

        this.nextAttemptAt = now + Math.min(RETRY_BACKOFF.maxMs, RETRY_BACKOFF.minMs * 2 ** Math.min(this.failures, 16));
        this.failures += 1;
    }
}

/** `logger`, with its warnings and errors also handed to `forwarder`. */
const forwardingLogger = (logger: Logger, forwarder: LogForwarder): Logger => {
    return {
        error: (message) => {
            logger.error(message);
            forwarder.push({ message, severity: "error", source: "hostd" });
        },
        info: (message) => {
            logger.info(message);
        },
        warn: (message) => {
            logger.warn(message);
            forwarder.push({ message, severity: "warn", source: "hostd" });
        },
    };
};

export type { ForwardedLog, LogForwarderOptions, LogSeverity, LogSource };
export { caddyLog, celldSeverity, forwardingLogger, LogForwarder, MAX_BATCH, MAX_BUFFERED, MAX_MESSAGE_BYTES, otlpLogsPayload, redactSecrets };
