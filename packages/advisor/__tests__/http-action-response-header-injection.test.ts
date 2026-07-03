import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorHttpHeaderWrite } from "../src/http-header-writes";
import httpActionResponseHeaderInjection from "../src/lints/static/http-action-response-header-injection";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const rows: AdvisorHttpHeaderWrite[] = [
    { exportName: "echo", file: "echo", headerName: "x-host", line: 3, via: "response-init" },
    { exportName: "go", file: "redirect", headerName: "location", line: 4, via: "headers-set" },
];

describe("http_action_response_header_injection", () => {
    it("emits one WARN finding per request-tainted header write", () => {
        expect.assertions(4);

        const findings = httpActionResponseHeaderInjection.run({ httpHeaderWrites: rows, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { exportName: "echo", file: "echo", headerName: "x-host", line: 3, via: "response-init" },
            name: "http_action_response_header_injection",
        });
        expect(findings[0]?.cacheKey).toBe("http_action_response_header_injection:echo:3");
        expect(findings[1]?.detail).toContain("location");
    });

    it("names 'a response header' when the header key is not a string literal", () => {
        expect.assertions(1);

        const findings = httpActionResponseHeaderInjection.run({
            httpHeaderWrites: [{ exportName: "dyn", file: "dyn", headerName: "", line: 2, via: "headers-append" }],
            schema: schema(),
        });

        expect(findings[0]?.detail).toContain("a response header");
    });

    it("returns [] when httpHeaderWrites is undefined", () => {
        expect.assertions(1);

        expect(httpActionResponseHeaderInjection.run({ schema: schema() })).toHaveLength(0);
    });
});
