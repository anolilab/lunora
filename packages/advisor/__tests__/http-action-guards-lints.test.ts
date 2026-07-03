import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorHttpActionGuard } from "../src/http-action-guards";
import httpActionMissingAuthGuard from "../src/lints/static/http-action-missing-auth-guard";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const rows: AdvisorHttpActionGuard[] = [
    // httpAction that mutates without reading ctx.auth → flagged.
    { exportName: "webhook", file: "hook", kind: "httpAction", line: 3, readsAuth: false, sideEffect: "runMutation" },
    // httpAction that reads ctx.auth → not flagged.
    { exportName: "guarded", file: "guarded", kind: "httpAction", line: 5, readsAuth: true, sideEffect: "runMutation" },
    // typed httpRoute POST that writes to ctx.db without auth → flagged, carries the verb.
    { exportName: "submit", file: "route", kind: "httpRoute", line: 7, method: "POST", readsAuth: false, sideEffect: "db.insert" },
    // typed httpRoute that reads ctx.auth → not flagged.
    { exportName: "safe", file: "route", kind: "httpRoute", line: 12, method: "PUT", readsAuth: true, sideEffect: "runAction" },
];

describe("http_action_missing_auth_guard", () => {
    it("flags only the side-effecting handlers that never read ctx.auth", () => {
        expect.assertions(4);

        const findings = httpActionMissingAuthGuard.run({ httpActionGuards: rows, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings.map((finding) => finding.metadata?.exportName)).toStrictEqual(["webhook", "submit"]);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { exportName: "webhook", file: "hook", kind: "httpAction", line: 3, sideEffect: "runMutation" },
            name: "http_action_missing_auth_guard",
        });
        expect(findings[0]?.detail).toContain("ctx.auth");
    });

    it("carries the HTTP verb in metadata for a typed httpRoute finding", () => {
        expect.assertions(1);

        const findings = httpActionMissingAuthGuard.run({ httpActionGuards: rows, schema: schema() });

        expect(findings[1]?.metadata).toMatchObject({ exportName: "submit", kind: "httpRoute", method: "POST", sideEffect: "db.insert" });
    });

    it("returns [] when httpActionGuards is undefined", () => {
        expect.assertions(1);

        expect(httpActionMissingAuthGuard.run({ schema: schema() })).toHaveLength(0);
    });
});
