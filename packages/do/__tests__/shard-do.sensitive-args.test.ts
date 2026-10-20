import type { LogEventInput } from "@lunora/observability";
import { readRequestLog, SENSITIVE_ARG_MASK } from "@lunora/observability";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { encodeWire } from "@lunora/wire";
import { describe, expect, it } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import type { SensitiveScope, ShardDOState, TelemetrySink } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A `v.sensitive` argument is masked by what it IS, not what it is called. The
 * shard asks its function registry which argument names are marked; this suite
 * marks an innocuously named `value` argument and checks that no request-log row,
 * dev capture or error row carries the secret, while a sibling argument is logged
 * as usual.
 */
const SECRET = "hunter2-the-real-secret";
/** A marked value with a newline, a quote, a backslash and a tab: JSON writes each one as an escape. */
const TRICKY = 'line one\n"quoted"\tand \\ back';
const TRICKY_ESCAPED = JSON.stringify(TRICKY).slice(1, -1);

class SensitiveShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- test double: the dispatch result is fixed, no shard state is needed
    public override async handleRpc(functionPath: string, args: Record<string, unknown> = {}): Promise<unknown> {
        if (functionPath === "vault:fail") {
            throw new Error(`rejected ${String(args["value"])}`);
        }

        return { ok: true };
    }

    // eslint-disable-next-line class-methods-use-this -- test double: the marked names are fixed per path
    protected override sensitiveArgNames(functionPath: string): ReadonlySet<string> {
        return functionPath.startsWith("vault:") ? new Set(["value"]) : new Set();
    }
}

const makeState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

const rpc = (functionPath: string, args: Record<string, unknown>): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("shardDO request log masks v.sensitive arguments", () => {
    it("masks a marked argument named `value` and keeps its unmarked sibling", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new SensitiveShard(makeState(database), {});

            await shard.fetch(rpc("vault:store", { label: "primary", value: SECRET }));

            const [row] = readRequestLog(database.sql);

            expect(row?.redactedArgs).toStrictEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
            expect(JSON.stringify(readRequestLog(database.sql))).not.toContain(SECRET);
            expect(JSON.stringify(row)).toContain('"label":"primary"');
        } finally {
            database.close();
        }
    });

    it("keeps masking in a development environment, where raw capture is on", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new SensitiveShard(makeState(database), { ENVIRONMENT: "development" });

            await shard.fetch(rpc("vault:store", { label: "primary", value: SECRET }));

            const [row] = readRequestLog(database.sql);

            expect(row?.redactedArgs).toStrictEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
            expect(JSON.stringify(readRequestLog(database.sql))).not.toContain(SECRET);
        } finally {
            database.close();
        }
    });

    it("masks the marked argument on an error row, where the thrown message quotes it", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new SensitiveShard(makeState(database), {});

            await shard.fetch(rpc("vault:fail", { label: "primary", value: SECRET }));

            const [row] = readRequestLog(database.sql, { outcome: "error" });

            expect(row?.redactedArgs).toStrictEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
            expect(JSON.stringify(readRequestLog(database.sql))).not.toContain(SECRET);
        } finally {
            database.close();
        }
    });

    it("masks a marked boolean argument by its name in the request log, where a value match could not", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new SensitiveShard(makeState(database), {});

            await shard.fetch(rpc("vault:store", { label: "primary", value: true }));

            const [row] = readRequestLog(database.sql);

            expect(row?.redactedArgs).toStrictEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
            expect(JSON.stringify(readRequestLog(database.sql))).not.toContain("true");
        } finally {
            database.close();
        }
    });

    it("leaves an unmarked function's arguments exactly as sent", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const shard = new SensitiveShard(makeState(database), {});

            await shard.fetch(rpc("notes:save", { label: "primary", value: SECRET }));

            const [row] = readRequestLog(database.sql);

            expect(row?.redactedArgs).toStrictEqual({ label: "primary", value: SECRET });
        } finally {
            database.close();
        }
    });
});

/**
 * The `ctx.*` telemetry of a dispatch that carries a `v.sensitive` argument. The
 * generated `buildCtx` wires these makers with the dispatch's scope, and so does
 * this double: it takes the scope from `handleRpc`'s sixth argument, which the
 * `/rpc` dispatch threads in by value. `vault:hold` parks on a gate the test
 * controls, so two dispatches can be interleaved on one instance.
 */
class TelemetryShard extends ShardDO {
    public sink: TelemetrySink = {};

    public captured: SensitiveScope | undefined;

    public retained: { info: (message: string, fields?: Record<string, unknown>) => void } | undefined;

    public release: Promise<void> = Promise.resolve();

    public override async handleRpc(
        functionPath: string,
        args: Record<string, unknown> = {},
        _headroom?: unknown,
        _scope?: unknown,
        _bookmarks?: unknown,
        sensitive?: SensitiveScope,
    ): Promise<unknown> {
        this.captured = sensitive;

        const anchor = this.resolveDispatchAnchor(false);
        const log = this.makeLogger(functionPath, this.sink, undefined, sensitive);

        if (functionPath === "vault:normalize") {
            // The validator trims and lowercases `value`, and the generated ctx hands the
            // parsed args back to the scope. The handler then logs, traces and throws the
            // transformed value, which the scope opened from the raw args does not match.
            const parsed = { label: args["label"], value: String(args["value"]).trim().toLowerCase() };

            this.admitSensitiveValues(sensitive, parsed, new Set(["value"]));

            const trace = this.makeTracer(functionPath, this.sink, anchor, sensitive);

            log.info(`normalized ${parsed.value}`, { label: parsed.label, normalized: parsed.value });
            await trace("step", () => undefined, { label: parsed.label as string, normalized: parsed.value });
            throw new Error(`rejected ${parsed.value}`);
        }

        if (functionPath === "vault:hook") {
            // A lifecycle hook that logs the marked value of the event it was handed.
            log.info(String(args["value"]));

            return { ok: true };
        }

        if (functionPath === "vault:fail") {
            // A recorded span is what gives the dispatch a root span to carry the failure.
            this.makeDispatchSpan(anchor, this.sink, sensitive).setAttribute("label", args["label"]);

            throw new Error(`rejected ${String(args["value"])}`);
        }

        if (functionPath === "vault:compose") {
            // A composed call runs inside this invocation: its marked argument is admitted
            // here, so the child's own records scrub it as well as the parent's.
            this.admitSensitiveArgs(sensitive, "vault:child", { value: args["child"] });

            log.info(`child saw ${String(args["child"])} and parent saw ${String(args["value"])}`, { value: args["child"] });

            return { ok: true };
        }

        if (functionPath === "vault:fields") {
            // The marked value used as a field name, beside an unmarked sibling key.
            log.info("named", { [String(args["value"])]: "x", label: args["label"] as string });

            return { ok: true };
        }

        if (functionPath === "vault:event") {
            // A key of the marked object, used as the event name.
            log.event(Object.keys(args["value"] as Record<string, unknown>)[0] ?? "");

            return { ok: true };
        }

        if (functionPath === "vault:composed") {
            // A marked key beside other words, which the rendered message joins.
            log.info("rejected", Object.keys(args["value"] as Record<string, unknown>)[0] ?? "");

            return { ok: true };
        }

        if (functionPath === "vault:message") {
            // A key of the marked object, written as a plain log message.
            log.info(Object.keys(args["value"] as Record<string, unknown>)[0] ?? "");

            return { ok: true };
        }

        if (functionPath === "vault:bytes") {
            // A marked byte value passed straight to the logger, where it renders as its numeric indices.
            log.info("got", args["value"]);

            return { ok: true };
        }

        if (functionPath === "vault:bytes-encoded") {
            // The same bytes, logged by a handler that encodes them to text itself.
            const bytes = args["value"] as Uint8Array;

            log.info(`hex ${Buffer.from(bytes).toString("hex")} base64 ${Buffer.from(bytes).toString("base64")}`);

            return { ok: true };
        }

        if (functionPath === "vault:serialize") {
            // A handler that quotes its whole argument bag, as JSON, in a log line and in a
            // failure: the marked value appears in its escaped spelling, not its raw one.
            const serialized = JSON.stringify(args);

            log.info(`sent ${serialized}`, { label: args["label"] as string });

            const trace = this.makeTracer(functionPath, this.sink, anchor, sensitive);

            await trace(
                "serialize",
                () => {
                    throw new Error(`rejected ${serialized}`);
                },
                { label: args["label"] as string },
            ).catch(() => undefined);

            // The dispatch itself fails with the same text, so the request-log row carries it too.
            throw new Error(`failed ${serialized}`);
        }

        if (functionPath === "vault:retain") {
            // A handler that keeps its logger and writes through it after it has returned.
            this.retained = log;

            return { ok: true };
        }

        if (functionPath === "vault:hold") {
            if (args["label"] === "first") {
                await this.release;
            }

            log.info(`${String(args["note"])} ${String(args["value"])}`, { label: args["label"], value: args["value"] });

            return { ok: true };
        }

        const trace = this.makeTracer(functionPath, this.sink, anchor, sensitive);
        const span = this.makeDispatchSpan(anchor, this.sink, sensitive);

        log.info("charged", { label: args["label"], value: args["value"] });
        span.setAttribute("value", args["value"]);
        span.setAttribute("label", args["label"]);
        span.addEvent("step", { value: args["value"] as string });
        await trace(
            "step",
            () => {
                throw new Error(`card ${String(args["value"])} declined`);
            },
            { label: args["label"] as string, value: args["value"] as string },
        ).catch(() => undefined);

        return { ok: true };
    }

    // eslint-disable-next-line class-methods-use-this -- test double: the marked names are fixed per path
    protected override sensitiveArgNames(functionPath: string): ReadonlySet<string> {
        return functionPath.startsWith("vault:") ? new Set(["value"]) : new Set();
    }
}

const telemetryRpc = (functionPath: string, args: Record<string, unknown>): Request => rpc(functionPath, args);

/** A request whose args go through the wire codec, the only way a byte value reaches a handler. */
const wireRpc = (functionPath: string, args: Record<string, unknown>): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: encodeWire(args), functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

/** Bytes that are not valid UTF-8, with the marked secret after the bad lead byte. */
const RAW_SECRET_BYTES = new Uint8Array([0xff, ...new TextEncoder().encode(SECRET)]);

describe("shardDO scrubs a v.sensitive value from every record a dispatch writes", () => {
    it("masks the marked value in ctx.log, ctx.trace, the wide event and the root span, and keeps the sibling", async () => {
        expect.assertions(5);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];
        const spans: SpanEvent[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event), onSpan: (span) => spans.push(span) };

            await shard.fetch(telemetryRpc("vault:record", { label: "primary", value: SECRET }));

            const charged = logs.find((event) => event.message === "charged");
            const wide = logs.find((event) => event.eventName === "lunora.dispatch");
            const step = spans.find((span) => span.name === "step");

            expect(charged?.fields).toStrictEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
            expect(wide?.fields).toEqual(expect.objectContaining({ label: "primary", value: SENSITIVE_ARG_MASK }));
            expect(step?.attributes).toStrictEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
            expect(step?.error?.message).toBe(`card ${SENSITIVE_ARG_MASK} declined`);
            expect(JSON.stringify([logs, spans])).not.toContain(SECRET);
        } finally {
            database.close();
        }
    });

    it("masks a marked value used as a log field name, and keeps the sibling key", async () => {
        expect.assertions(2);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event), onSpan: () => undefined };

            await shard.fetch(telemetryRpc("vault:fields", { label: "primary", value: SECRET }));

            const named = logs.find((event) => event.message === "named");

            expect(named?.fields).toStrictEqual({ [SENSITIVE_ARG_MASK]: "x", label: "primary" });
            expect(JSON.stringify(logs)).not.toContain(SECRET);
        } finally {
            database.close();
        }
    });

    it("masks a marked key that a log call joins into its message beside other words", async () => {
        expect.assertions(3);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event), onSpan: () => undefined };

            await shard.fetch(telemetryRpc("vault:composed", { label: "primary", value: { "ops-mailbox": 1 } }));

            const rejected = logs.find((event) => event.message.startsWith("rejected"));

            expect(rejected?.message).toBe(`rejected ${SENSITIVE_ARG_MASK}`);
            expect(JSON.stringify(logs)).not.toContain("ops-mailbox");
            expect(logs.length).toBeGreaterThan(0);
        } finally {
            database.close();
        }
    });

    it("masks a key of a marked object written as a plain log message", async () => {
        expect.assertions(2);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event), onSpan: () => undefined };

            await shard.fetch(telemetryRpc("vault:message", { label: "primary", value: { "ops-mailbox": 1 } }));

            expect(logs.length).toBeGreaterThan(0);
            expect(JSON.stringify(logs)).not.toContain("ops-mailbox");
        } finally {
            database.close();
        }
    });

    it("masks a key of a marked object used as an event name, in the logs", async () => {
        expect.assertions(2);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event), onSpan: () => undefined };

            await shard.fetch(telemetryRpc("vault:event", { label: "primary", value: { "ops-mailbox": 1 } }));

            expect(logs.length).toBeGreaterThan(0);
            expect(JSON.stringify(logs)).not.toContain("ops-mailbox");
        } finally {
            database.close();
        }
    });

    it("masks a marked value that a handler logs as JSON, in the log line, the span error and the request log", async () => {
        expect.assertions(4);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];
        const spans: SpanEvent[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event), onSpan: (span) => spans.push(span) };

            await shard.fetch(telemetryRpc("vault:serialize", { label: "primary", value: TRICKY }));

            const sent = logs.find((event) => event.message.startsWith("sent "));
            const serialize = spans.find((span) => span.name === "serialize");
            const [row] = readRequestLog(database.sql, { outcome: "error" });
            const masked = JSON.stringify({ label: "primary", value: SENSITIVE_ARG_MASK });

            expect(sent?.message).toBe(`sent ${masked}`);
            expect(serialize?.error?.message).toBe(`rejected ${masked}`);
            expect(row?.errorMessage).toBe(`failed ${masked}`);
            expect(JSON.stringify([readRequestLog(database.sql), logs, spans])).not.toContain(TRICKY_ESCAPED);
        } finally {
            database.close();
        }
    });

    it("masks the marked value on the root span's error message when the handler throws", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new TelemetryShard(makeState(database), {});

            await shard.fetch(telemetryRpc("vault:fail", { label: "primary", value: SECRET }));

            const root = shard["spans"].entries().find((span) => span.dispatch === true);

            expect(root?.error?.message).toBe(`rejected ${SENSITIVE_ARG_MASK}`);
            expect(JSON.stringify(shard["spans"].entries())).not.toContain(SECRET);
        } finally {
            database.close();
        }
    });

    it("keeps two concurrent dispatches' values apart", async () => {
        expect.assertions(3);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});
            let openFirst: () => void = () => undefined;

            shard.release = new Promise<void>((resolve) => {
                openFirst = resolve;
            });
            shard.sink = { onLog: (event) => logs.push(event) };

            const first = shard.fetch(telemetryRpc("vault:hold", { label: "first", note: "first saw", value: "first-secret-value" }));
            // The second dispatch runs to completion while the first is parked, and
            // quotes the first's value in its own text: it must come through intact.
            await shard.fetch(telemetryRpc("vault:hold", { label: "second", note: "second saw first-secret-value and", value: "second-secret-value" }));
            openFirst();
            await first;

            const second = logs.find((event) => event.message.startsWith("second saw"));
            const firstLine = logs.find((event) => event.message.startsWith("first saw"));

            expect(second?.message).toBe(`second saw first-secret-value and ${SENSITIVE_ARG_MASK}`);
            expect(firstLine?.message).toBe(`first saw ${SENSITIVE_ARG_MASK}`);
            expect(firstLine?.message).not.toContain("second-secret-value");
        } finally {
            database.close();
        }
    });

    it("scrubs a composed call's marked argument from the caller's invocation", async () => {
        expect.assertions(2);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event) };

            await shard.fetch(telemetryRpc("vault:compose", { child: "child-secret-value", value: SECRET }));

            const line = logs.find((event) => event.message.startsWith("child saw"));

            expect(line?.message).toBe(`child saw ${SENSITIVE_ARG_MASK} and parent saw ${SENSITIVE_ARG_MASK}`);
            expect(JSON.stringify(logs)).not.toContain("child-secret-value");
        } finally {
            database.close();
        }
    });

    it("masks a marked value that a retained ctx.log writes after the handler has returned", async () => {
        expect.assertions(3);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event) };

            await shard.fetch(telemetryRpc("vault:retain", { label: "primary", value: SECRET }));

            shard.retained?.info(`late ${SECRET}`, { label: "primary", value: SECRET });

            const late = logs.find((event) => event.message.startsWith("late "));

            expect(late?.message).toBe(`late ${SENSITIVE_ARG_MASK}`);
            expect(late?.fields).toStrictEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
            expect(JSON.stringify(logs)).not.toContain(SECRET);
        } finally {
            database.close();
        }
    });
});

/** Exposes the lifecycle dispatch, and names one hook, so a test can drive it. */
class LifecycleShard extends TelemetryShard {
    public runLifecycle(event: Record<string, unknown>): Promise<void> {
        return this.dispatchLifecycle("disconnect", { event, identity: null, ip: undefined, userId: undefined } as never);
    }

    // eslint-disable-next-line class-methods-use-this -- test double: the hook paths are fixed
    protected override lifecycleHookPaths(event: "connect" | "disconnect" | "init" | "reactor" | "whisper"): ReadonlyArray<string> {
        return event === "disconnect" ? ["vault:hook"] : [];
    }
}

describe("shardDO scrubs a marked value that a validator transforms before the handler", () => {
    it("masks the transformed value in the handler's log line, span attribute, error and request log", async () => {
        expect.assertions(5);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];
        const spans: SpanEvent[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event), onSpan: (span) => spans.push(span) };

            await shard.fetch(telemetryRpc("vault:normalize", { label: "primary", value: "  Hunter2-Token  " }));

            const normalized = logs.find((event) => event.message.startsWith("normalized"));
            const step = spans.find((span) => span.name === "step");
            const [row] = readRequestLog(database.sql, { outcome: "error" });

            // The logged and traced key is not the marked name, so only the admitted spelling can mask it.
            expect.soft(normalized?.message).toBe(`normalized ${SENSITIVE_ARG_MASK}`);
            expect.soft(normalized?.fields).toStrictEqual({ label: "primary", normalized: SENSITIVE_ARG_MASK });
            expect.soft(step?.attributes).toStrictEqual({ label: "primary", normalized: SENSITIVE_ARG_MASK });
            expect.soft(row?.errorMessage).toBe(`rejected ${SENSITIVE_ARG_MASK}`);
            expect.soft(JSON.stringify([logs, spans, readRequestLog(database.sql)])).not.toContain("hunter2-token");
        } finally {
            database.close();
        }
    });
});

describe("lifecycle hooks run under the sensitive scope of their event", () => {
    it("masks a marked event value that a lifecycle hook logs", async () => {
        expect.assertions(2);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new LifecycleShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event), onSpan: () => undefined };

            await shard.runLifecycle({ value: SECRET });

            expect(logs.length).toBeGreaterThan(0);
            expect(JSON.stringify(logs)).not.toContain(SECRET);
        } finally {
            database.close();
        }
    });
});

describe("run-as dispatches under the sensitive scope of their arguments", () => {
    it("masks a marked argument that the run-as target logs", async () => {
        expect.assertions(3);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), { LUNORA_ADMIN_TOKEN: "run-as-admin" });

            shard.sink = { onLog: (event) => logs.push(event), onSpan: () => undefined };

            const response = await shard.fetch(
                new Request("https://shard.invalid/rpc", {
                    body: JSON.stringify({
                        args: { args: { value: SECRET }, functionPath: "vault:hook", userId: "victim" },
                        functionPath: ADMIN_FUNCTIONS.runAs,
                    }),
                    headers: { authorization: "Bearer run-as-admin", "content-type": "application/json" }, // gitleaks:allow -- fixture token, matched against the env value above
                    method: "POST",
                }),
            );

            expect(response.status).toBe(200);
            expect(logs.length).toBeGreaterThan(0);
            expect(JSON.stringify(logs)).not.toContain(SECRET);
        } finally {
            database.close();
        }
    });
});

describe("shardDO masks a marked byte value in every form a handler logs it", () => {
    it("masks a UTF-8 byte value passed straight to the logger, instead of writing its numeric indices", async () => {
        expect.assertions(2);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event) };

            await shard.fetch(wireRpc("vault:bytes", { value: new TextEncoder().encode(SECRET) }));

            const got = logs.find((event) => event.message.startsWith("got"));

            expect(got?.message).toBe(`got ${SENSITIVE_ARG_MASK}`);
            expect(JSON.stringify(logs)).not.toContain("104,117,110");
        } finally {
            database.close();
        }
    });

    it("masks a non-UTF-8 byte value passed straight to the logger", async () => {
        expect.assertions(2);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event) };

            await shard.fetch(wireRpc("vault:bytes", { value: RAW_SECRET_BYTES }));

            const got = logs.find((event) => event.message.startsWith("got"));

            expect(got?.message).toBe(`got ${SENSITIVE_ARG_MASK}`);
            expect(JSON.stringify(logs)).not.toContain("255,104");
        } finally {
            database.close();
        }
    });

    it("masks the hex and base64 text a handler encodes a non-UTF-8 byte value to", async () => {
        expect.assertions(2);

        const database = createSqliteExec();
        const logs: LogEventInput[] = [];

        try {
            const shard = new TelemetryShard(makeState(database), {});

            shard.sink = { onLog: (event) => logs.push(event) };

            await shard.fetch(wireRpc("vault:bytes-encoded", { value: RAW_SECRET_BYTES }));

            const encoded = logs.find((event) => event.message.startsWith("hex"));

            expect(encoded?.message).toBe(`hex ${SENSITIVE_ARG_MASK} base64 ${SENSITIVE_ARG_MASK}`);
            expect(JSON.stringify(logs)).not.toContain(Buffer.from(RAW_SECRET_BYTES).toString("hex"));
        } finally {
            database.close();
        }
    });
});

/** A socket that records the frames it is sent and keeps its attachment across calls, as a hibernating socket does. */
class SensitiveSocket {
    public readonly frames: unknown[] = [];
    private attachment: unknown;

    public constructor(initial: unknown) {
        this.attachment = initial;
    }

    // eslint-disable-next-line class-methods-use-this -- test double: a close is not observed by these assertions
    public close(): void {}

    public deserializeAttachment(): unknown {
        return this.attachment;
    }

    public send(data: string): void {
        this.frames.push(JSON.parse(data));
    }

    public serializeAttachment(value: unknown): void {
        this.attachment = value;
    }
}

/**
 * Each failure site admits a validator-transformed marked value into its dispatch's scope, then throws
 * the transformed value. The raw value is not a substring of the transformed one, so only the admitted
 * spelling can mask it: a message scrubbed by a scope rebuilt from the raw args leaks the lowercased text.
 */
class TransformFailureShard extends ShardDO {
    public constructor(
        state: ShardDOState,
        private readonly rooms: Record<string, string>,
        private readonly whisperPaths: string[],
    ) {
        super(state, {});
    }

    public runDisconnect(event: Record<string, unknown>): Promise<void> {
        return this.dispatchLifecycle("disconnect", { event, identity: null, ip: undefined, userId: undefined } as never);
    }

    public override handleRpc(
        functionPath: string,
        args: Record<string, unknown>,
        _headroom?: unknown,
        _scope?: unknown,
        _bookmarks?: unknown,
        sensitive?: SensitiveScope,
    ): Promise<unknown> {
        if (functionPath === "vault:hook") {
            const parsed = String(args["value"]).trim().toLowerCase();

            this.admitSensitiveValues(sensitive, { value: parsed }, new Set(["value"]));

            return Promise.reject(new Error(`hook rejected ${parsed}`));
        }

        if (functionPath === "whisper:authorize") {
            const parsed = String(args["topic"]).trim().toLowerCase();

            this.admitSensitiveValues(sensitive, { topic: parsed }, new Set(["topic"]));

            return Promise.reject(new Error(`authorizer rejected ${parsed}`));
        }

        if (functionPath === "rooms:chat" && args["kind"] === "message") {
            const parsed = String(args["message"]).trim().toLowerCase();

            this.admitSensitiveValues(sensitive, { message: parsed }, new Set(["message"]));

            return Promise.reject(new Error(`room rejected ${parsed}`));
        }

        return Promise.resolve(undefined);
    }

    // eslint-disable-next-line class-methods-use-this -- test double: the marked names are fixed per path
    protected override sensitiveArgNames(functionPath: string): ReadonlySet<string> {
        if (functionPath === "vault:hook") {
            return new Set(["value"]);
        }

        if (functionPath === "whisper:authorize") {
            return new Set(["topic"]);
        }

        return functionPath === "rooms:chat" ? new Set(["message"]) : new Set();
    }

    protected override lifecycleHookPaths(event: "connect" | "disconnect" | "init" | "reactor" | "whisper"): ReadonlyArray<string> {
        if (event === "disconnect") {
            return ["vault:hook"];
        }

        return event === "whisper" ? this.whisperPaths : [];
    }

    protected override roomHandlerPath(topic: string): string | undefined {
        return this.rooms[topic];
    }
}

const transformShard = (sockets: SensitiveSocket[], whisperPaths: string[] = []): TransformFailureShard => {
    const state = {
        acceptWebSocket() {},
        getWebSockets: () => sockets,
        storage: { sql: {} },
    } as unknown as ShardDOState;

    return new TransformFailureShard(state, { "room:chat": "rooms:chat" }, whisperPaths);
};

const logEntries = (shard: ShardDO): { functionPath?: string; message: string }[] =>
    (shard as unknown as { logs: { entries: () => { functionPath?: string; message: string }[] } }).logs.entries();

const errorLogs = (shard: ShardDO, functionPath: string): string[] =>
    logEntries(shard)
        .filter((entry) => entry.functionPath === functionPath)
        .map((entry) => entry.message);

describe("failure messages are scrubbed by the scope their dispatch was using", () => {
    it("masks a transformed marked value that a lifecycle hook throws", async () => {
        expect.assertions(2);

        const shard = transformShard([]);

        await shard.runDisconnect({ value: "  Hunter2-Token  " });

        expect(errorLogs(shard, "vault:hook")).toStrictEqual([`hook rejected ${SENSITIVE_ARG_MASK}`]);
        expect(JSON.stringify(logEntries(shard))).not.toContain("hunter2-token");
    });

    it("masks a transformed marked value that a whisper authorizer throws", async () => {
        expect.assertions(2);

        const socket = new SensitiveSocket({ subs: {}, userId: "member" });
        const shard = transformShard([socket], ["whisper:authorize"]);

        await shard.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ topic: "Hunter2-Token", type: "whisper_subscribe" }));

        expect(errorLogs(shard, "whisper:authorize")).toStrictEqual([`authorizer rejected ${SENSITIVE_ARG_MASK}`]);
        expect(JSON.stringify(logEntries(shard))).not.toContain("hunter2-token");
    });

    it("masks a transformed marked value that a room handler throws on a message, in the refusal's record", async () => {
        expect.assertions(2);

        const socket = new SensitiveSocket({ subs: {}, userId: "member" });
        const shard = transformShard([socket]);

        await shard.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ topic: "room:chat", type: "whisper_subscribe" }));
        await shard.webSocketMessage(
            socket as unknown as WebSocket,
            JSON.stringify({ data: encodeWire("  Hunter2-Token  "), topic: "room:chat", type: "whisper" }),
        );

        expect(errorLogs(shard, "rooms:chat")).toStrictEqual([`room rejected ${SENSITIVE_ARG_MASK}`]);
        expect(JSON.stringify(logEntries(shard))).not.toContain("hunter2-token");
    });
});
