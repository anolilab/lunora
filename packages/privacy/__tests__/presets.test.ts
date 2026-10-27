import { describe, expect, it } from "vitest";

import { germany, legalClaimsHold } from "../src/de";
import { eu } from "../src/eu";

const STATUTE_MARK = /§/u;

/**
 * The honest record of what the legal review still blocks. Every rule and policy
 * value that ships with `reviewRequired: true` appears here. When counsel signs a
 * rule off, flip its flag and remove it from this list in the same change.
 */
const PENDING_LEGAL_OR_TAX_REVIEW = [
    "de.books",
    "de.voucher",
    "de.voucher.regulated",
    "de.correspondence",
    "de.legalClaims",
    "policy.responseMonths",
    "policy.extensionMonths",
    "policy.erasureGraceDays",
];

describe("the EU preset", () => {
    it("sets a one-month response with a two-month extension and a 14-day erasure grace", () => {
        expect(eu().policy).toStrictEqual({ erasureGraceDays: 14, extensionMonths: 2, responseMonths: 1, reviewRequired: true });
    });

    it("names no retention rules, because the EU sets none", () => {
        expect(eu().retention).toStrictEqual([]);
    });
});

describe("the German preset", () => {
    it("names the four mandatory HGB and AO periods", () => {
        expect(germany().retention.map((rule) => [rule.id, rule.years])).toStrictEqual([
            ["de.books", 10],
            ["de.voucher", 8],
            ["de.voucher.regulated", 10],
            ["de.correspondence", 6],
        ]);
    });

    it("cites a statute for every rule", () => {
        for (const rule of germany().retention) {
            expect(rule.citation).toMatch(STATUTE_MARK);
        }
    });

    it("keeps the legal-claims hold out of the default set, as an opt-in", () => {
        expect(germany().retention.map((rule) => rule.id)).not.toContain(legalClaimsHold.id);
        expect(legalClaimsHold).toMatchObject({ id: "de.legalClaims", years: 3 });
    });

    it("marks every rule as pending review", () => {
        const rules = [...germany().retention, legalClaimsHold];

        expect(rules.every((rule) => rule.reviewRequired)).toBe(true);
    });
});

describe("the pending-review record", () => {
    it("lists every rule and policy value that still awaits legal or tax review", () => {
        const pendingRules = germany().retention.filter((rule) => rule.reviewRequired);
        const policyKeys = Object.keys(eu().policy ?? {}).filter((key) => key !== "reviewRequired");
        const pending = [...pendingRules.map((rule) => rule.id), legalClaimsHold.id, ...policyKeys.map((key) => `policy.${key}`)];

        expect(pending.toSorted((a, b) => a.localeCompare(b))).toStrictEqual([...PENDING_LEGAL_OR_TAX_REVIEW].toSorted((a, b) => a.localeCompare(b)));
    });
});
