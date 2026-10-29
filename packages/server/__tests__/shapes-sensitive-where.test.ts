import { createSensitiveScope, SENSITIVE_ARG_MASK, sensitiveNames, sensitiveValues } from "@lunora/observability";
import { describe, expect, it } from "vitest";

import { v } from "../src/index";
import { defineShape } from "../src/shapes";

/** The ctx key the shard hands its scope under (see `admitSensitiveArgs`). */
const ADMIT_SENSITIVE_ARGS = Symbol.for("lunora.admitSensitiveArgs");

// Trims and lowercases, so the where-clause sees a different value from the raw argument.
const normalizeSchema = {
    "~standard": {
        validate: (value: unknown) =>
            typeof value === "string" ? { value: value.trim().toLowerCase() } : { issues: [{ message: "expected string", path: [] as PropertyKey[] }] },
        vendor: "test",
        version: 1 as const,
    },
};

const RAW = "  Hunter2-Token  ";

describe("a shape where-clause that throws a transformed marked argument", () => {
    it("names the transformed value only in a form the dispatch scope masks", () => {
        expect.assertions(3);

        // Opened from the raw args, as the shard opens it before the shape resolves.
        const scope = createSensitiveScope(sensitiveValues({ token: RAW }, new Set(["token"])), ["token"]);
        const context = {
            [ADMIT_SENSITIVE_ARGS]: (args: Record<string, unknown>, names: ReadonlySet<string>) => {
                scope.add(sensitiveValues(args, names), sensitiveNames(args, names));
            },
        };
        const shape = defineShape({
            args: { token: v.sensitive(v.from(normalizeSchema)) },
            table: "vault",
            where: (_ctx, args) => {
                throw new Error(`where rejected token ${args.token as string}`);
            },
        });

        let thrown: unknown;

        try {
            shape.compileWhere(context, { token: RAW });
        } catch (error) {
            thrown = error;
        }

        // The predicate saw the transformed value, not the raw one.
        expect((thrown as Error).message).toBe("where rejected token hunter2-token");
        // Admitted before the predicate ran, so the dispatch scope masks it wherever the message goes.
        expect(scope.text((thrown as Error).message)).toBe(`where rejected token ${SENSITIVE_ARG_MASK}`);
        expect(scope.text("hunter2-token")).toBe(SENSITIVE_ARG_MASK);
    });
});
