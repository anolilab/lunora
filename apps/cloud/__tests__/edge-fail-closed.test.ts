import { describe, expect, it, vi } from "vitest";

import type { EdgeRuleRow } from "../src/edge/rules";
import { runEdgeRuleSweep } from "../src/edge/rules";
import type { ControlPlaneDatabase } from "../src/store";
import { applyEdgeRule, buildEdgeRule, createEdgeProtection, EDGE_CALL_TIMEOUT_MS, edgeRuleRef } from "../src/targets/cloudflare-wfp/edge";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";

/**
 * The `cloudflare-wfp` edge driver and the reconciler must fail CLOSED: a
 * Cloudflare error, a timeout, or a malformed, partial or surprising answer is
 * a recorded failure and no further write — never "there is no rule", which
 * would skip a removal or create a duplicate, and never a success.
 */

const ZONE = "zone123";
const API = "https://api.cloudflare.com/client/v4";
const ENTRYPOINT = `${API}/zones/${ZONE}/rulesets/phases/ddos_l7/entrypoint`;
const REF = edgeRuleRef("ddos_l7", "org1");
const RULE = buildEdgeRule("org1", { kind: "ddos_l7", sensitivity: "low" }, ["shop.lunora.app"]);

type Answer = (init: RequestInit | undefined) => Response;

/** A scripted Cloudflare: each `METHOD url` has one answer; anything else is a 500. */
const scripted = (script: Record<string, Answer>) => {
    const calls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const key = `${init?.method ?? "GET"} ${input instanceof Request ? input.url : input.toString()}`;
        const answer = script[key];

        calls.push(key);

        return answer ? answer(init) : Response.json({ errors: [{ message: "unscripted" }], success: false }, { status: 500 });
    });

    return { calls, fetch };
};

const ok =
    (result: unknown): Answer =>
    () =>
        Response.json({ errors: [], result, success: true });
const notFound: Answer = () => Response.json({ errors: [{ message: "not found" }], success: false }, { status: 404 });
const writes = (calls: ReadonlyArray<string>) => calls.filter((call) => !call.startsWith("GET "));

const apply = (fetch: typeof globalThis.fetch, rule: typeof RULE | null) =>
    applyEdgeRule({ apiToken: "t", fetch }, { phase: "ddos_l7", ref: REF, rule, zoneId: ZONE });

describe("edge driver fails closed", () => {
    it.each([
        ["no result at all", undefined],
        ["a ruleset without an id", { rules: [] }],
        ["a rule list that is not a list", { id: "rs1", rules: "nope" }],
        ["a rule without an id", { id: "rs1", rules: [{ ref: REF }] }],
    ])("treats %s as a failure, not as an empty zone — no PUT that would replace the phase", async (_label, result) => {
        const zone = scripted({ [`GET ${ENTRYPOINT}`]: ok(result) });

        await expect(apply(zone.fetch, RULE)).rejects.toThrow("refusing to act on it");
        await expect(apply(zone.fetch, null)).rejects.toThrow("refusing to act on it");
        expect(writes(zone.calls)).toStrictEqual([]);
    });

    it("does not read a 404 on a zone that is gone as a removal that succeeded", async () => {
        const zone = scripted({ [`GET ${API}/zones/${ZONE}`]: notFound, [`GET ${ENTRYPOINT}`]: notFound });

        await expect(apply(zone.fetch, null)).rejects.toThrow("not found");
        await expect(apply(zone.fetch, RULE)).rejects.toThrow("not found");
        expect(writes(zone.calls)).toStrictEqual([]);
    });

    it("treats a failed read of the current rule as a failure, so neither a duplicate nor a skipped removal follows", async () => {
        const zone = scripted({ [`GET ${ENTRYPOINT}`]: () => Response.json({ errors: [{ message: "internal" }], success: false }, { status: 500 }) });

        await expect(apply(zone.fetch, RULE)).rejects.toThrow("internal");
        await expect(apply(zone.fetch, null)).rejects.toThrow("internal");
        expect(writes(zone.calls)).toStrictEqual([]);
    });

    it("confirms a removal with a fresh read, and fails if the rule is still there", async () => {
        const held = { id: "rs1", rules: [{ expression: RULE.expression, id: "r1", ref: REF }] };
        const zone = scripted({ [`DELETE ${API}/zones/${ZONE}/rulesets/rs1/rules/r1`]: ok(held), [`GET ${ENTRYPOINT}`]: ok(held) });

        await expect(apply(zone.fetch, null)).rejects.toThrow("still holds the rule");
    });

    it("fails a write whose answer does not hold the rule as written", async () => {
        const zone = scripted({
            [`GET ${ENTRYPOINT}`]: ok({ id: "rs1", rules: [] }),
            [`POST ${API}/zones/${ZONE}/rulesets/rs1/rules`]: ok({ id: "rs1", rules: [{ expression: "(true)", id: "r9", ref: REF }] }),
        });

        await expect(apply(zone.fetch, RULE)).rejects.toThrow("does not hold the rule as written");
    });

    it("fails a write whose answer is partial", async () => {
        const zone = scripted({ [`GET ${ENTRYPOINT}`]: ok({ id: "rs1", rules: [] }), [`POST ${API}/zones/${ZONE}/rulesets/rs1/rules`]: ok({ id: "rs1" }) });

        await expect(apply(zone.fetch, RULE)).rejects.toThrow("does not hold the rule as written");
    });

    it("bounds every call, so a hung Cloudflare fails the row instead of stalling the sweep", async () => {
        const signals: (AbortSignal | null | undefined)[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
            signals.push(init?.signal);

            throw new DOMException("The operation timed out.", "TimeoutError");
        });

        await expect(apply(fetch, RULE)).rejects.toThrow("timed out");
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(EDGE_CALL_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    });
});

const NOW = 1_700_000_000_000;
const SHOP = { hostname: "shop.lunora.app", projectId: "p1", rowId: "dep1", source: "deployment" as const };

const edgeRow = (overrides: Partial<EdgeRuleRow> = {}): EdgeRuleRow => {
    return {
        _id: "edge1",
        applied: false,
        attempts: 0,
        kind: "ddos_l7",
        organizationId: "org1",
        sensitivity: "low",
        status: "pending",
        targets: [],
        updatedAt: NOW - 1000,
        ...overrides,
    };
};

const tables = (row: EdgeRuleRow) => {
    return {
        deployments: [{ _id: "dep1", alias: "shop", organizationId: "org1", projectId: "p1", scriptName: "shop", status: "live" }],
        domains: [],
        edgeRules: [row],
        organizations: [{ _id: "org1" }],
        projects: [{ _id: "p1", name: "Shop", organizationId: "org1" }],
    };
};

/** A store whose `edgeRules` read can be swapped mid-pass, as a concurrent settings change would. */
const store = (data: Record<string, unknown[]>, spies: Partial<ControlPlaneDatabase>, edgeRuleRead?: () => unknown) => {
    return {
        ...fakeControlPlaneDb(data, spies),
        get: (id: string, table?: string) =>
            Promise.resolve(
                table === "edgeRules" && edgeRuleRead ? edgeRuleRead() : ((data[table ?? ""] ?? []).find((row) => (row as { _id: string })._id === id) ?? null),
            ),
    };
};

const sweepOptions = (fetch: typeof globalThis.fetch) => {
    return {
        appDomain: "lunora.app",
        budgets: { ddos_l7: 10, rate_limit: 10 },
        edge: createEdgeProtection({ credentials: { apiToken: "t", fetch }, zoneId: ZONE }),
        now: NOW,
        recheckUnavailable: false,
    };
};

describe("reconciler fails closed", () => {
    it("records a malformed Cloudflare answer as a failure, never as applied or removed", async () => {
        const zone = scripted({ [`GET ${ENTRYPOINT}`]: ok({ rules: [] }) });
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));

        await expect(runEdgeRuleSweep(store(tables(edgeRow()), { patch }), sweepOptions(zone.fetch))).resolves.toStrictEqual({ failed: 1 });
        expect(patch).toHaveBeenCalledWith("edge1", expect.objectContaining({ attempts: 1, status: "failed" }), "edgeRules");
        expect(patch).not.toHaveBeenCalledWith("edge1", expect.objectContaining({ applied: expect.anything() }), "edgeRules");
    });

    it("keeps an applied rule recorded as applied when its removal could not be confirmed", async () => {
        const held = { id: "rs1", rules: [{ expression: RULE.expression, id: "r1", ref: REF }] };
        const zone = scripted({ [`DELETE ${API}/zones/${ZONE}/rulesets/rs1/rules/r1`]: ok(held), [`GET ${ENTRYPOINT}`]: ok(held) });
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));

        await runEdgeRuleSweep(
            store(tables(edgeRow({ applied: true, sensitivity: "default", status: "pending", targets: [SHOP] })), { patch }),
            sweepOptions(zone.fetch),
        );

        expect(patch).toHaveBeenCalledWith("edge1", expect.objectContaining({ status: "failed" }), "edgeRules");
        expect(patch).not.toHaveBeenCalledWith("edge1", expect.objectContaining({ applied: false }), "edgeRules");
    });

    it("does not let an in-flight apply overwrite an intent recorded while it ran", async () => {
        const zone = scripted({
            [`GET ${API}/zones/${ZONE}`]: ok({ id: ZONE }),
            [`GET ${ENTRYPOINT}`]: notFound,
            [`PUT ${ENTRYPOINT}`]: (init) =>
                Response.json({
                    result: {
                        id: "rs1",
                        rules: [{ ...(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { rules: object[] }).rules[0], id: "r1" }],
                    },
                    success: true,
                }),
        });
        const row = edgeRow();
        const reads = [row, { ...row, sensitivity: "default", updatedAt: NOW }];
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));

        // First read (before the write) sees the planned row; the second (after it) sees
        // the owner's newer "default" intent.
        await runEdgeRuleSweep(
            store(tables(row), { patch }, () => reads.shift() ?? reads[0]),
            sweepOptions(zone.fetch),
        );

        expect(patch).toHaveBeenCalledWith("edge1", { applied: true, appliedAt: NOW, cloudflareRuleId: "r1", targets: [SHOP] }, "edgeRules");
        expect(patch).not.toHaveBeenCalledWith("edge1", expect.objectContaining({ status: expect.anything() }), "edgeRules");
    });
});
