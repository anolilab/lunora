import { createSensitiveScope, SENSITIVE_ARG_MASK, sensitiveNames, sensitiveValues } from "@lunora/observability";
import { describe, expect, it, vi } from "vitest";

import type { MutationCtx as MutationContext } from "../src/index";
import { initLunora, v } from "../src/index";

const { mutation } = initLunora.dataModel().create();

/** The ctx key the shard hands its dispatch scope under (see `admitSensitiveArgs`). */
const ADMIT_SENSITIVE_ARGS = Symbol.for("lunora.admitSensitiveArgs");

// Trims and lowercases, the way a parser normalises a value before the handler sees it.
const normalizeSchema = {
    "~standard": {
        validate: (value: unknown) =>
            typeof value === "string" ? { value: value.trim().toLowerCase() } : { issues: [{ message: "expected string", path: [] as PropertyKey[] }] },
        vendor: "test",
        version: 1 as const,
    },
};

const RAW = "  Hunter2-Token  ";

/** A ctx whose admit hook writes into a real observability scope, as the generated shard ctx does. */
const makeContext = (scope: ReturnType<typeof createSensitiveScope>): MutationContext =>
    ({
        [ADMIT_SENSITIVE_ARGS]: (args: Record<string, unknown>, names: ReadonlySet<string>) => {
            scope.add(sensitiveValues(args, names), sensitiveNames(args, names));
        },
        auth: { getIdentity: async () => null, userId: null },
        newId: () => "test-id",
        db: {} as MutationContext["db"],
        log: {} as MutationContext["log"],
        metrics: { count: () => undefined, gauge: () => undefined, record: () => undefined },
        now: 0,
        runMutation: vi.fn<(...args: never[]) => unknown>() as unknown as MutationContext["runMutation"],
        runQuery: vi.fn<(...args: never[]) => unknown>() as unknown as MutationContext["runQuery"],
        scheduler: {} as MutationContext["scheduler"],
        secrets: { get: async () => "secret" },
        storage: {} as MutationContext["storage"],
        trace: (async (_name: string, fn: (t: unknown) => unknown) => fn(undefined)) as MutationContext["trace"],
        vectors: {} as MutationContext["vectors"],
        workflows: {} as MutationContext["workflows"],
    }) as unknown as MutationContext;

describe("a validator's transform of a marked argument reaches the dispatch scope", () => {
    it("masks the transformed value wherever the handler writes it", async () => {
        expect.assertions(2);

        // Opened from the raw args, as the shard opens it before the validator runs.
        const scope = createSensitiveScope(sensitiveValues({ token: RAW }, new Set(["token"])), ["token"]);
        const send = mutation.input({ token: v.sensitive(v.from(normalizeSchema)) }).mutation(async ({ args }) => scope.text(`saw ${args.token as string}`));

        const result = await send.handler(makeContext(scope), { token: RAW });

        expect(result).toBe(`saw ${SENSITIVE_ARG_MASK}`);
        expect(scope.text("hunter2-token")).toBe(SENSITIVE_ARG_MASK);
    });

    it("hands the validator's output and the marked names to the dispatch, and nothing for an unmarked function", async () => {
        expect.assertions(2);

        const admit = vi.fn<(...args: unknown[]) => void>();
        const context = { [ADMIT_SENSITIVE_ARGS]: admit } as unknown as MutationContext;
        const marked = mutation.input({ label: v.string(), token: v.sensitive(v.from(normalizeSchema)) }).mutation(async ({ args }) => args.token);
        const plain = mutation.input({ label: v.string() }).mutation(async () => "ok");

        await marked.handler(context, { label: "primary", token: RAW });
        await plain.handler(context, { label: "primary" });

        expect(admit).toHaveBeenCalledTimes(1);
        expect(admit).toHaveBeenCalledWith({ label: "primary", token: "hunter2-token" }, new Set(["token"]));
    });
});
