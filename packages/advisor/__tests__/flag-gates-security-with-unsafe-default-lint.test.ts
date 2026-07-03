import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorFlagSecurityDefault } from "../src/flag-security-defaults";
import flagGatesSecurityWithUnsafeDefault from "../src/lints/static/flag-gates-security-with-unsafe-default";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const row = (key: string, defaultValue: boolean, line: number): AdvisorFlagSecurityDefault => {
    return {
        defaultValue,
        exportName: "handler",
        file: "flags",
        key,
        line,
    };
};

const rows: AdvisorFlagSecurityDefault[] = [
    // protection key defaulting false → unsafe (protection disabled on outage).
    row("enforceRls", false, 1),
    // protection key defaulting true → safe.
    row("enforceRls", true, 2),
    // permission key defaulting true → unsafe (permission granted on outage).
    row("bypassAuth", true, 3),
    // permission key defaulting false → safe.
    row("allowGuestCheckout", false, 4),
    // indeterminate-polarity key (bare auth/admin) → not flagged.
    row("adminPanel", false, 5),
    // benign non-security key → not flagged.
    row("darkMode", true, 6),
    // benign key containing the substring "gate" as part of another word → not flagged (token-level match).
    row("aggregateEvents", false, 7),
];

describe("flag_gates_security_with_unsafe_default", () => {
    it("flags only security-shaped keys whose default selects the permissive branch", () => {
        expect.assertions(4);

        const findings = flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: rows, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings.map((finding) => finding.metadata.key)).toStrictEqual(["enforceRls", "bypassAuth"]);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { defaultValue: false, key: "enforceRls" },
            name: "flag_gates_security_with_unsafe_default",
        });
        expect(findings[1]?.detail).toContain("granting the guarded permission");
    });

    it("does not flag a permission key that defaults to the restrictive branch", () => {
        expect.assertions(1);

        const findings = flagGatesSecurityWithUnsafeDefault.run({
            flagSecurityDefaults: [row("permitUpload", false, 1)],
            schema: schema(),
        });

        expect(findings).toHaveLength(0);
    });

    it("returns [] when flagSecurityDefaults is undefined", () => {
        expect.assertions(1);

        expect(flagGatesSecurityWithUnsafeDefault.run({ schema: schema() })).toHaveLength(0);
    });
});
