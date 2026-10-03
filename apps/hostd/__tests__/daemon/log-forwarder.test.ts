/**
 * Forwarding hostd's own logs (plan 458 W6): the OTLP payload and its tags,
 * the bounded drop-oldest buffer, retries, the http refusal — and that no
 * secret ever leaves the box.
 */
import { describe, expect, it } from "vitest";

import { silentLogger } from "../../src/daemon/log";
import type { LogSeverity } from "../../src/daemon/log-forwarder";
import { caddyLog, celldSeverity, forwardingLogger, LogForwarder, MAX_BUFFERED, redactSecrets } from "../../src/daemon/log-forwarder";

const TELEMETRY = { endpoint: "https://ingest.example/otlp/", token: ["production:org_1", "ingest-key-0123456789"].join("|") };

type Posted = {
    authorization: string | null;
    body: { resourceLogs: { resource: { attributes: Attribute[] }; scopeLogs: { logRecords: LogRecord[] }[] }[] };
    url: string;
};

type Attribute = { key: string; value: { stringValue: string } };

type LogRecord = { attributes: Attribute[]; body: { stringValue: string }; severityNumber: number; severityText: string; timeUnixNano: string };

/** A forwarder posting to a fake endpoint that answers `status`, and the clock it reads. */
const forwarderWith = (status: () => number = () => 200, secrets: string[] = []) => {
    const posted: Posted[] = [];
    const warnings: string[] = [];
    const clock = { now: 1_790_000_000_000 };
    const forwarder = new LogForwarder({
        boxSlug: "b7k2m9",
        controlPlane: "https://cloud.example",
        fetch: async (input, init) => {
            posted.push({
                authorization: new Headers(init?.headers).get("authorization"),
                body: JSON.parse(init?.body as string) as Posted["body"],
                url: input instanceof Request ? input.url : input.toString(),
            });

            return new Response(null, { status: status() });
        },
        logger: { ...silentLogger, warn: (message) => warnings.push(message) },
        now: () => clock.now,
        secrets: () => secrets,
    });

    return { clock, forwarder, posted, warnings };
};

/** Every record posted, flattened, with its resource's `service.name`. */
const records = (posted: Posted[]) => {
    const flat: { attributes: Record<string, string>; body: string; service: string | undefined; severity: string }[] = [];

    for (const resource of posted.flatMap((post) => post.body.resourceLogs)) {
        const service = resource.resource.attributes.find((entry) => entry.key === "service.name")?.value.stringValue;

        for (const record of resource.scopeLogs.flatMap((scope) => scope.logRecords)) {
            flat.push({
                attributes: Object.fromEntries(record.attributes.map((entry) => [entry.key, entry.value.stringValue])),
                body: record.body.stringValue,
                service,
                severity: record.severityText,
            });
        }
    }

    return flat;
};

describe(LogForwarder, () => {
    it("posts OTLP logs to {endpoint}/v1/logs with the ingest key, tagged with the box and the alias", async () => {
        expect.assertions(4);

        const { forwarder, posted } = forwarderWith();

        forwarder.configure(TELEMETRY);
        forwarder.push({ message: "isolation: egress policy: nft is missing", severity: "warn", source: "hostd" });
        forwarder.pushCelld("shop", "2026-10-03T00:00:00Z ERROR celld::node: bucket write failed");
        await forwarder.flush();

        expect(posted.map((post) => [post.url, post.authorization])).toStrictEqual([["https://ingest.example/otlp/v1/logs", `Bearer ${TELEMETRY.token}`]]);
        expect(records(posted)).toStrictEqual([
            {
                attributes: { box: "b7k2m9", source: "hostd" },
                body: "isolation: egress policy: nft is missing",
                service: "lunora-hostd",
                severity: "WARN",
            },
            {
                attributes: { alias: "shop", box: "b7k2m9", source: "celld" },
                body: "2026-10-03T00:00:00Z ERROR celld::node: bucket write failed",
                service: "shop",
                severity: "ERROR",
            },
        ]);
        expect(posted[0]?.body.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]).toMatchObject({ severityNumber: 13, timeUnixNano: "1790000000000000000" });
        expect(forwarder.pending).toBe(0);
    });

    it("holds records until the control plane names an endpoint, and forwards nothing to a plain-http one", async () => {
        expect.assertions(4);

        const { forwarder, posted, warnings } = forwarderWith();

        forwarder.push({ message: "before the config", severity: "error", source: "hostd" });
        await forwarder.flush();

        expect(posted).toStrictEqual([]);

        forwarder.configure({ ...TELEMETRY, endpoint: "http://ingest.example" });
        await forwarder.flush();

        expect([posted.length, warnings]).toStrictEqual([
            0,
            ["not forwarding logs: the control plane named a plain-http log endpoint, which would expose its ingest key"],
        ]);

        forwarder.configure(TELEMETRY);
        await forwarder.flush();

        expect(records(posted).map((record) => record.body)).toStrictEqual(["before the config"]);
        expect(forwarder.pending).toBe(0);
    });

    it("keeps at most MAX_BUFFERED records, dropping the oldest, and says how many it dropped", async () => {
        expect.assertions(3);

        const { forwarder, posted } = forwarderWith();

        for (let index = 0; index < MAX_BUFFERED + 5; index += 1) {
            forwarder.push({ message: `line ${String(index)}`, severity: "warn", source: "hostd" });
        }

        expect(forwarder.pending).toBe(MAX_BUFFERED);

        forwarder.configure(TELEMETRY);
        await forwarder.flush();

        const [first, second] = records(posted);

        expect(first?.body).toBe("5 log records were dropped: the buffer was full");
        expect(second?.body).toBe("line 5");
    });

    it("keeps a batch the endpoint refused, and retries it after a backoff", async () => {
        expect.assertions(5);

        let status = 503;
        const { clock, forwarder, posted, warnings } = forwarderWith(() => status);

        forwarder.configure(TELEMETRY);
        forwarder.push({ message: "kept", severity: "error", source: "hostd" });
        await forwarder.flush();

        expect([posted.length, forwarder.pending]).toStrictEqual([1, 1]);
        expect(warnings).toStrictEqual(["could not forward logs to the control plane (HTTP 503); retrying with backoff"]);

        // Within the backoff: nothing is sent.
        await forwarder.flush();

        expect(posted).toHaveLength(1);

        status = 200;
        clock.now += 5000;
        await forwarder.flush();

        expect(records(posted.slice(1)).map((record) => record.body)).toStrictEqual(["kept"]);
        expect(forwarder.pending).toBe(0);
    });

    it("never sends a secret: the ingest key, the bucket credentials, or anything shaped like one", async () => {
        expect.assertions(2);

        const { forwarder, posted } = forwarderWith(() => 200, ["AKIAEXAMPLEKEYID", "bucket-secret-value"]);
        const lines = [
            `posting with ${TELEMETRY.token}`,
            "celld: credentials AKIAEXAMPLEKEYID / bucket-secret-value refused",
            `env ${["AWS_SECRET_ACCESS_KEY", "whatever123"].join("=")} leaked`,
            ["header Authorization:", "Bearer", "abc.def.ghi"].join(" "),
            `token lbe_${"ab".repeat(32)} in a line`,
            "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI\n-----END PRIVATE KEY-----",
        ];

        forwarder.configure(TELEMETRY);

        for (const message of lines) {
            forwarder.push({ message, severity: "error", source: "hostd" });
        }

        await forwarder.flush();

        const bodies = JSON.stringify(posted.map((post) => post.body));

        expect(
            ["ingest-key-0123456789", "AKIAEXAMPLEKEYID", "bucket-secret-value", "whatever123", "abc.def.ghi", "abab", "MC4CAQAw"].filter((secret) =>
                bodies.includes(secret),
            ),
        ).toStrictEqual([]);
        expect(records(posted).map((record) => record.body)).toStrictEqual([
            "posting with [redacted]",
            "celld: credentials [redacted] / [redacted] refused",
            "env [redacted] leaked",
            "header [redacted]",
            "token [redacted] in a line",
            "[redacted]",
        ]);
    });
});

describe("what is forwarded", () => {
    it("reads a celld line's level, counting anything else on its stderr as a warning", () => {
        expect.assertions(1);

        expect(["2026 ERROR celld: x", "2026  WARN celld: y", "panicked at src/main.rs"].map((line) => celldSeverity(line))).toStrictEqual<LogSeverity[]>([
            "error",
            "warn",
            "warn",
        ]);
    });

    it("forwards Caddy's warnings and errors, not its info lines or anything that is not its JSON log", () => {
        expect.assertions(1);

        expect(
            [
                '{"level":"info","logger":"http","msg":"server running"}',
                '{"level":"error","logger":"http.log.error","msg":"dial tcp 127.0.0.1:20000: connect: connection refused"}',
                '{"level":"warn","msg":"tls: no certificate"}',
                "plain text",
            ].map((line) => caddyLog(line)?.severity),
        ).toStrictEqual([undefined, "error", "warn", undefined]);
    });

    it("forwards hostd's warnings and errors, never its info lines", async () => {
        expect.assertions(1);

        const { forwarder, posted } = forwarderWith();
        const logger = forwardingLogger(silentLogger, forwarder);

        logger.info("connected to the control plane");
        logger.warn("caddy exited (code 1); restarting in 1000 ms");
        logger.error("isolation self-check failed");
        forwarder.configure(TELEMETRY);
        await forwarder.flush();

        expect(records(posted).map((record) => [record.severity, record.body])).toStrictEqual([
            ["WARN", "caddy exited (code 1); restarting in 1000 ms"],
            ["ERROR", "isolation self-check failed"],
        ]);
    });

    it("redacts known values and secret shapes, and leaves ordinary words alone", () => {
        expect.assertions(1);

        expect(redactSecrets("short key abc is kept; longsecretvalue is not", ["abc", "longsecretvalue"])).toBe("short key abc is kept; [redacted] is not");
    });
});
