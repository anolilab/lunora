import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorFailOpenGuard } from "../src/fail-open-guards";
import ratelimitMiddlewareFailOpen from "../src/lints/static/ratelimit-middleware-fail-open";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const rows: AdvisorFailOpenGuard[] = [
    // fail-open rateLimit on a sign-in flow (sensitive by limitName) → flagged.
    { callee: "rateLimit", exportName: "signIn", failOpen: true, file: "signin", limitName: "signin", line: 3 },
    // fail-open Turnstile guard on a sensitive export name (register) → flagged.
    { callee: "verifyTurnstileMiddleware", exportName: "registerUser", failOpen: true, file: "register", limitName: "", line: 5 },
    // fail-open guard on a NON-sensitive procedure → not flagged (narrow subset).
    { callee: "rateLimit", exportName: "listPosts", failOpen: true, file: "posts", limitName: "list", line: 7 },
    // sensitive procedure but fail-CLOSED (default) → not flagged.
    { callee: "rateLimit", exportName: "signInStrict", failOpen: false, file: "signin", limitName: "signin", line: 9 },
];

describe("ratelimit_middleware_fail_open", () => {
    it("flags only fail-open guards on auth/payment-sensitive procedures", () => {
        expect.assertions(4);

        const findings = ratelimitMiddlewareFailOpen.run({ failOpenGuards: rows, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { callee: "rateLimit", exportName: "signIn", limitName: "signin" },
            name: "ratelimit_middleware_fail_open",
        });
        expect(findings[1]).toMatchObject({ metadata: { callee: "verifyTurnstileMiddleware", exportName: "registerUser" } });
        expect(findings[0]?.detail).toContain("failOpen: true");
    });

    it("matches a sensitive token regardless of casing or separators", () => {
        expect.assertions(1);

        const findings = ratelimitMiddlewareFailOpen.run({
            failOpenGuards: [{ callee: "verifyTurnstileMiddleware", exportName: "resetPassword", failOpen: true, file: "reset", limitName: "", line: 1 }],
            schema: schema(),
        });

        expect(findings).toHaveLength(1);
    });

    it("does not flag a benign procedure that merely spells a sensitive token inside a word", () => {
        expect.assertions(1);

        // `updatePresets` contains "reset"; `snapshotPrune` and
        // `listSlotProfiles` contain "otp". None is an auth/payment flow, and a
        // lint documenting itself as high-precision must not claim they are.
        const findings = ratelimitMiddlewareFailOpen.run({
            failOpenGuards: [
                { callee: "rateLimit", exportName: "updatePresets", failOpen: true, file: "presets", limitName: "presets", line: 1 },
                { callee: "rateLimit", exportName: "snapshotPrune", failOpen: true, file: "snapshots", limitName: "snapshots", line: 2 },
                { callee: "rateLimit", exportName: "listSlotProfiles", failOpen: true, file: "slots", limitName: "slots", line: 3 },
            ],
            schema: schema(),
        });

        expect(findings).toHaveLength(0);
    });

    it("still flags a sensitive word inside a longer camelCase or one-word name", () => {
        expect.assertions(1);

        const findings = ratelimitMiddlewareFailOpen.run({
            failOpenGuards: [
                { callee: "rateLimit", exportName: "signInWithEmail", failOpen: true, file: "auth", limitName: "", line: 1 },
                { callee: "rateLimit", exportName: "loginHandler", failOpen: true, file: "auth", limitName: "", line: 2 },
                { callee: "rateLimit", exportName: "createCheckoutSession", failOpen: true, file: "billing", limitName: "", line: 3 },
                { callee: "rateLimit", exportName: "start", failOpen: true, file: "auth", limitName: "otp-start", line: 4 },
            ],
            schema: schema(),
        });

        expect(findings).toHaveLength(4);
    });

    it("returns [] when failOpenGuards is undefined", () => {
        expect.assertions(1);

        expect(ratelimitMiddlewareFailOpen.run({ schema: schema() })).toHaveLength(0);
    });
});
