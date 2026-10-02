import { CELLD_CAPABILITIES } from "@lunora/platform";
import { describe, expect, it } from "vitest";

import { bindingRefusal, CELLD_PITR_NOTE, refusedBindings, TARGET_OPTIONS, targetLabel, targetLimitations } from "../src/client/target-capabilities";
import { BINDING_SUPPORT, TARGET_IDS, UNSUPPORTED_REASONS } from "../src/provision-contract";

const byName = (a: string, b: string): number => a.localeCompare(b, "en");

/**
 * The studio's capability gating (plan 458 W9) must say exactly what the deploy
 * path enforces — no more, no less — so it is pinned against the contract
 * tables rather than against copies of them.
 */
describe(bindingRefusal, () => {
    it("answers the contract's own reason for a binding the target refuses", () => {
        expect(bindingRefusal("celld-vps", "ai")).toBe(UNSUPPORTED_REASONS["celld-vps"].ai);
        expect(bindingRefusal("celld-vps", "vectorize")).toBe(UNSUPPORTED_REASONS["celld-vps"].vectorize);
    });

    it("maps the graph's wrangler kinds onto contract types", () => {
        expect(bindingRefusal("celld-vps", "analytics")).toBe(UNSUPPORTED_REASONS["celld-vps"].analytics_engine);
        expect(bindingRefusal("celld-vps", "queue")).toBeUndefined();
    });

    it("answers undefined for a binding the target provides, or a kind it does not rate", () => {
        expect(bindingRefusal("celld-vps", "d1")).toBeUndefined();
        expect(bindingRefusal("celld-vps", "workflow")).toBeUndefined();
        expect(bindingRefusal("cloudflare-wfp", "ai")).toBeUndefined();
        expect(bindingRefusal("celld-vps", "var")).toBeUndefined();
        expect(bindingRefusal("celld-vps", "secret")).toBeUndefined();
    });

    it("gates per target: a workflow is refused on Cloudflare and provided on a box", () => {
        expect(bindingRefusal("cloudflare-wfp", "workflow")).toBe(UNSUPPORTED_REASONS["cloudflare-wfp"].workflow);
    });
});

describe(refusedBindings, () => {
    it.each(TARGET_IDS)("lists every type %s rates unsupported, each with a reason", (target) => {
        const expected = Object.entries(BINDING_SUPPORT[target])
            .filter(([, support]) => support === "unsupported")
            .map(([type]) => type)
            .toSorted(byName);

        const listed = refusedBindings(target);

        expect(listed.map((entry) => entry.type).toSorted(byName)).toStrictEqual(expected);
        expect(listed.every((entry) => entry.reason.length > 0 && entry.label.length > 0)).toBe(true);
    });
});

describe(targetLimitations, () => {
    it("says a box has no per-plan runtime limits and no point-in-time recovery, citing celld's note", () => {
        const limitations = targetLimitations("celld-vps");

        expect(limitations.map((entry) => entry.id)).toStrictEqual(["runtimeLimits", "pitr"]);
        expect(limitations.find((entry) => entry.id === "pitr")?.reason).toBe(CELLD_PITR_NOTE);
    });

    it("quotes celld's point-in-time-recovery note verbatim from the capability matrix", () => {
        expect(CELLD_PITR_NOTE).toBe(CELLD_CAPABILITIES.features.pointInTimeRecovery?.note);
        expect(CELLD_CAPABILITIES.features.pointInTimeRecovery?.level).toBe("unsupported");
    });

    it("has nothing to add for Cloudflare", () => {
        expect(targetLimitations("cloudflare-wfp")).toStrictEqual([]);
    });
});

describe(targetLabel, () => {
    it("names both targets as the selector does", () => {
        expect(targetLabel("cloudflare-wfp")).toBe("Lunora Cloud (Cloudflare)");
        expect(targetLabel("celld-vps")).toBe("Your own server");
        expect(TARGET_OPTIONS.map((option) => option.id).toSorted(byName)).toStrictEqual([...TARGET_IDS].toSorted(byName));
    });
});
