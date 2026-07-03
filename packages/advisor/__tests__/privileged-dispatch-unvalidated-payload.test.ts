import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import privilegedDispatchUnvalidatedPayload from "../src/lints/static/privileged-dispatch-unvalidated-payload";
import type { AdvisorPrivilegedDispatch } from "../src/privileged-dispatches";
import type { AdvisorRlsProcedure } from "../src/rls-procedures";

const schema = () => fromServerSchema(defineSchema({ messages: defineTable({ text: v.string() }) }));

const dispatch = (overrides: Partial<AdvisorPrivilegedDispatch> = {}): AdvisorPrivilegedDispatch => {
    return {
        dispatchKind: "workflow",
        file: "workflows",
        handlerExport: "onboard",
        line: 4,
        targetExport: "send",
        targetFile: "messages",
        ...overrides,
    };
};

const procedure = (overrides: Partial<AdvisorRlsProcedure> = {}): AdvisorRlsProcedure => {
    return {
        exportName: "send",
        file: "messages",
        rlsTables: ["messages"],
        tablesRead: [],
        tablesWritten: ["messages"],
        usesRls: true,
        visibility: "public",
        ...overrides,
    };
};

describe("privileged_dispatch_unvalidated_payload", () => {
    it("flags an ERROR when a payload-derived dispatch targets an RLS-gated function", () => {
        expect.assertions(3);

        const findings = privilegedDispatchUnvalidatedPayload.run({
            privilegedDispatches: [dispatch()],
            rlsProcedures: [procedure()],
            schema: schema(),
        });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            // eslint-disable-next-line no-secrets/no-secrets -- an advisor cache-key assertion, not a secret
            cacheKey: "privileged_dispatch_unvalidated_payload:workflows:4",
            level: "ERROR",
            metadata: { dispatchKind: "workflow", targetExport: "send", targetFile: "messages" },
            name: "privileged_dispatch_unvalidated_payload",
        });
        expect(findings[0]?.detail).toContain("messages.send");
    });

    it("does not flag when the dispatched target does not enforce RLS", () => {
        expect.assertions(1);

        const findings = privilegedDispatchUnvalidatedPayload.run({
            privilegedDispatches: [dispatch()],
            rlsProcedures: [procedure({ rlsTables: [], usesRls: false })],
            schema: schema(),
        });

        expect(findings).toHaveLength(0);
    });

    it("does not flag when the target is not found in the RLS-procedure evidence", () => {
        expect.assertions(1);

        const findings = privilegedDispatchUnvalidatedPayload.run({
            privilegedDispatches: [dispatch({ targetExport: "unknown" })],
            rlsProcedures: [procedure()],
            schema: schema(),
        });

        expect(findings).toHaveLength(0);
    });

    it("matches on both file and export so a same-named export in another file is not confused", () => {
        expect.assertions(1);

        const findings = privilegedDispatchUnvalidatedPayload.run({
            privilegedDispatches: [dispatch({ targetFile: "channels" })],
            rlsProcedures: [procedure({ file: "messages" })],
            schema: schema(),
        });

        expect(findings).toHaveLength(0);
    });

    it("describes a queue dispatch with the queue-specific payload wording", () => {
        expect.assertions(1);

        const findings = privilegedDispatchUnvalidatedPayload.run({
            privilegedDispatches: [dispatch({ dispatchKind: "queue", file: "queues", handlerExport: "emailQueue" })],
            rlsProcedures: [procedure()],
            schema: schema(),
        });

        expect(findings[0]?.detail).toContain("queue message body");
    });

    it("finds nothing when the feeder supplies no dispatch evidence", () => {
        expect.assertions(2);

        expect(privilegedDispatchUnvalidatedPayload.run({ schema: schema() })).toHaveLength(0);
        expect(privilegedDispatchUnvalidatedPayload.run({ privilegedDispatches: [], rlsProcedures: [procedure()], schema: schema() })).toHaveLength(0);
    });
});
