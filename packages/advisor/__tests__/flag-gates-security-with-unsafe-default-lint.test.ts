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

    // The kill-switch spelling is the common one, and it inverts the polarity:
    // `disableRls: true` leaves RLS OFF for every request the flag backend can't
    // be reached for. Scoring these off the un-negated token flagged the SAFE
    // spelling and handed the user a remediation that creates the hole.
    it.each([
        ["disableRls", true],
        ["rlsDisabled", true],
        ["skipEnforcement", true],
        ["disable_rls", true],
        ["noGate", true],
    ] as const)("flags the negated protection key %s defaulting %s", (key, defaultValue) => {
        expect.assertions(2);

        const findings = flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row(key, defaultValue, 1)], schema: schema() });

        expect(findings).toHaveLength(1);
        // Every key here names a PROTECTION being switched off, so the harm is
        // that the protection is disabled — nothing is granted. (This assertion
        // previously read "granting the guarded permission", which was the
        // implementation's own inverted clause written back as an expectation.)
        expect(findings[0]?.detail).toContain("disabling the guarded protection");
    });

    it.each([["disableRls"], ["rlsDisabled"], ["skipEnforcement"], ["disable_rls"], ["noGate"]] as const)(
        "does not flag the negated protection key %s defaulting false",
        (key) => {
            expect.assertions(1);

            expect(flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row(key, false, 1)], schema: schema() })).toHaveLength(0);
        },
    );

    // A negation only inverts when it negates the WHOLE key. Mid-name it qualifies
    // the noun beside it: `allowWithoutAuth` still GRANTS access (without auth),
    // so it is a permission key and `true` is the unsafe default. Counting every
    // position made these compute a safe default of `true` — suppressing the real
    // finding AND telling the user to write the value that opens the hole.
    it.each([["allowWithoutAuth"], ["allowNoAuth"], ["permitWithoutReview"], ["bypassNoLimit"]] as const)(
        "flags the permission key %s defaulting true, despite a mid-name qualifier",
        (key) => {
            expect.assertions(2);

            const findings = flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row(key, true, 1)], schema: schema() });

            expect(findings).toHaveLength(1);
            expect(findings[0]?.detail).toContain("default it to `false`");
        },
    );

    it.each([["allowWithoutAuth"], ["allowNoAuth"], ["permitWithoutReview"], ["bypassNoLimit"]] as const)(
        "does not flag the permission key %s defaulting false",
        (key) => {
            expect.assertions(1);

            expect(flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row(key, false, 1)], schema: schema() })).toHaveLength(0);
        },
    );

    // A double negation lands back on the un-negated polarity.
    it("scores a doubly-negated key as un-negated", () => {
        expect.assertions(2);

        expect(flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row("disableSkipRls", false, 1)], schema: schema() })).toHaveLength(1);
        expect(flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row("disableSkipRls", true, 1)], schema: schema() })).toHaveLength(0);
    });

    // `enforce` alone never matched the words teams actually write.
    it.each([["skipEnforcement"], ["enforcementDisabled"], ["enforcedChecks"]] as const)("recognises the %s spelling of the enforce token", (key) => {
        expect.assertions(1);

        const flagged = [true, false].filter(
            (defaultValue) => flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row(key, defaultValue, 1)], schema: schema() }).length > 0,
        );

        expect(flagged).toHaveLength(1);
    });

    // `disallow*` names a restriction, so it scores as a protection: default it
    // `false` and the thing it disallows is allowed on every provider outage.
    it("treats disallow* as a protection key", () => {
        expect.assertions(2);

        expect(flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row("disallowUploads", false, 1)], schema: schema() })).toHaveLength(1);
        expect(flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row("disallowUploads", true, 1)], schema: schema() })).toHaveLength(0);
    });

    // The remediation is the finding's whole value; on a negated key "default it
    // to `true`" is the instruction that opens the hole.
    it("names the safe default in the finding detail", () => {
        expect.assertions(2);

        const [negated] = flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row("disableRls", true, 1)], schema: schema() });
        const [plain] = flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row("enforceRls", false, 1)], schema: schema() });

        expect(negated?.detail).toContain("default it to `false`");
        expect(plain?.detail).toContain("default it to `true`");
    });

    // A security linter whose explanation contradicts its own remediation is the
    // defect this rule exists to catch. Which harm the outage causes follows the
    // key's FAMILY (protection vs permission), not the unsafe value: `disableRls:
    // true` turns RLS off — it grants nothing — while `noBypass: false` leaves
    // the bypass on and grants everything.
    it.each([
        ["disableRls", true, "disabling the guarded protection", "granting the guarded permission"],
        ["enforceRls", false, "disabling the guarded protection", "granting the guarded permission"],
        ["noBypass", false, "granting the guarded permission", "disabling the guarded protection"],
        ["permitUpload", true, "granting the guarded permission", "disabling the guarded protection"],
    ])("describes the harm from the key family, not the default value (%s)", (key, defaultValue, expected, wrong) => {
        expect.assertions(2);

        const [finding] = flagGatesSecurityWithUnsafeDefault.run({ flagSecurityDefaults: [row(key, defaultValue, 1)], schema: schema() });

        expect(finding?.detail).toContain(expected);
        expect(finding?.detail).not.toContain(wrong);
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
