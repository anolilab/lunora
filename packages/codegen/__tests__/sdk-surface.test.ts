/**
 * The `sdk-surface` fixture: one function per shape a model backend renders
 * differently, whose emitted `openrpc.json` is the second spec
 * `sdks/generated-check.sh` compiles and runs every SDK target against.
 *
 * Two layers. The golden keeps that spec the emitter's real output — a
 * hand-written spec is how a stale `v.bigint()` schema kept every SDK test green
 * while each generated SDK sent a bigint as a plain string. The named assertions
 * pin each generator defect this spec exposed, so a regression reports the
 * defect here, in seconds, before the toolchain legs run.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toJsonSchema, v } from "@lunora/values";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";
import type { OpenRpcDocument } from "../src/sdk";
import { generateSdk, SDK_TARGETS } from "../src/sdk";
import { hasUnrepresentableWireType } from "../src/sdk/spec";
import { makeFixtureWorkdir } from "./golden-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "sdk-surface");
const committedSpec = join(fixtureRoot, "expected", "_generated", "openrpc.json");

const spec = JSON.parse(readFileSync(committedSpec, "utf8")) as OpenRpcDocument;

/** Every generated file for one target, joined, plus the surface alone (models excluded). */
const generate = async (language: string): Promise<{ all: string; files: Record<string, string>; surface: string }> => {
    const { files } = await generateSdk(spec, SDK_TARGETS[language]!);
    const generated = Object.entries(files);

    return {
        all: generated.map(([, contents]) => contents).join("\n"),
        files,
        surface: generated
            .filter(([path]) => !/models/iu.test(path))
            .map(([, contents]) => contents)
            .join("\n"),
    };
};

describe("sdk-surface fixture", () => {
    let workdir: string;
    let openRpc: string;

    beforeAll(() => {
        workdir = makeFixtureWorkdir(fixtureRoot);
        openRpc = runCodegen({ lint: false, projectRoot: workdir }).generated.openRpc;
    }, 300_000);

    afterAll(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("openrpc.json matches the committed golden", () => {
        expect.assertions(1);

        expect(openRpc).toBe(readFileSync(committedSpec, "utf8"));
    });
});

describe("generated SDKs over the sdk-surface spec", () => {
    it.each([
        ["top level", v.bigint()],
        ["nested object", v.object({ a: v.object({ b: v.bigint() }) })],
        ["array element", v.array(v.object({ amount: v.bigint() }))],
        ["record value", v.record(v.string(), v.bigint())],
        ["nullable", v.union(v.bigint(), v.null())],
        ["optional field", v.object({ limit: v.optional(v.bigint()) })],
    ])("finds a v.bigint() at the %s position", (_, validator) => {
        expect.assertions(1);

        expect(hasUnrepresentableWireType(toJsonSchema(validator))).toBe(true);
    });

    it.each(Object.keys(SDK_TARGETS))("%s: generates no typed model for a bigint argument or result", async (language) => {
        expect.assertions(2);

        const { unrepresentable } = await generateSdk(spec, SDK_TARGETS[language]!);
        const { surface } = await generate(language);

        expect(unrepresentable).toStrictEqual(["ledger:balances", "ledger:charge"]);
        expect(surface).not.toMatch(/Ledger(?:Charge|Balances)(?:Args|Result)/u);
    });

    it("ruby: calls from_dynamic!/to_dynamic only on object structs", async () => {
        expect.assertions(4);

        const { surface } = await generate("ruby");

        // Non-struct results come back decoded, `{}` args go through as a Hash.
        expect(surface).toContain(`@client.query("items:count", args, shard_key)`);
        expect(surface).not.toMatch(/Items(?:Count|Create|Clear|Tags|Stats|Page|Pick)Result\.from_dynamic!/u);
        // The object result is still typed.
        expect(surface).toContain("ItemsSummaryResult.from_dynamic!(");
        // And the nullable object's predicted name — declared only in a usage
        // comment — is not referenced at all.
        expect(surface).not.toMatch(/\bItemsFindResult\b/u);
    });

    it("ruby: leaves untyped any model that reaches a scalar union at any depth", async () => {
        expect.assertions(2);

        const { surface } = await generate("ruby");

        // `detail` is an object whose `value` field is `string | number`: its
        // struct's `from_dynamic!` calls the union's, which dry-struct rejects.
        expect(surface).toContain(`@client.query("items:detail", args, shard_key)`);
        expect(surface).not.toMatch(/ItemsDetail\w*\.from_dynamic!/u);
    });

    it.each(["python", "ruby", "rust"])("%s: rejects two functions whose emitted member names collide", async (language) => {
        expect.assertions(1);

        // Distinct PascalCase (`GetURL`, `GetUrl`), so the language-neutral check
        // passes them — but snake_case folds both to `get_url`.
        const method = (name: string): OpenRpcDocument["methods"][number] => {
            return { name, params: [{ name: "args", schema: { properties: {}, type: "object" } }], "x-lunora-function-kind": "query" };
        };

        await expect(generateSdk({ methods: [method("things:getURL"), method("things:getUrl")] }, SDK_TARGETS[language]!)).rejects.toThrow(
            /both generate the \w+ member "get_url"/u,
        );
    });

    it("keeps a typed model for a plain number a hand-written spec annotates int64", () => {
        expect.assertions(3);

        expect(hasUnrepresentableWireType({ format: "int64", type: "number" })).toBe(false);
        expect(hasUnrepresentableWireType({ format: "int64", type: "integer" })).toBe(false);
        expect(hasUnrepresentableWireType({ format: "int64" })).toBe(true);
    });

    it("dart: fails generation when a declared model has no decoder by the expected name", () => {
        expect.assertions(1);

        const namespaces = [
            {
                methods: [
                    {
                        argsNullPaths: { nullable: [], optional: [] },
                        argsType: undefined,
                        functionName: "get",
                        functionPath: "things:get",
                        namespace: "things",
                        resultType: "ThingsGetResult",
                        summary: "query: things:get",
                        takesArgs: false,
                        verb: "query" as const,
                    },
                ],
                name: "things",
            },
        ];
        // A decoder spelled any other way than `thingsGetResultFromJson`.
        const models = "ThingsGetResult ThingsGetResultFromJson(String str) => ThingsGetResult.fromJson(json.decode(str));\n\nclass ThingsGetResult {}\n";

        expect(() => SDK_TARGETS["dart"]!.render({ models, namespaces })).toThrow(/no top-level decoder "thingsGetResultFromJson"/u);
    });

    it("swift: emits no per-shape convenience extension and no comment-only type", async () => {
        expect.assertions(3);

        const { all, surface } = await generate("swift");

        expect(all).not.toMatch(/extension (?:Array|Dictionary) where/u);
        expect(all).not.toContain("init(data: Data)");
        expect(surface).not.toMatch(/\bItemsFindResult\b/u);
    });

    it("dart: decodes with fromJson only where the result is that object", async () => {
        expect.assertions(3);

        const { surface } = await generate("dart");

        expect(surface).toContain("ItemsSummaryResult.fromJson(");
        expect(surface).not.toContain("ItemsPageResult.fromJson(");
        expect(surface).not.toContain("ItemsFindResult.fromJson(");
    });

    it("rust: never emits a raw identifier rustc refuses, nor one inside a derived name", async () => {
        expect.assertions(4);

        const { surface } = await generate("rust");

        expect(surface).not.toMatch(/r#(?:self|Self|crate|super)\b/u);
        expect(surface).not.toContain("subscribe_r#");
        expect(surface).toContain("pub fn self_(");
        expect(surface).toContain("pub fn subscribe_match(");
    });

    it("go: leaves a scalar-union result untyped rather than undecodable", async () => {
        expect.assertions(1);

        const { surface } = await generate("go");

        expect(surface).toContain("func (a *ItemsAPI) Pick(args ItemsPickArgs, shardKey string) (any, error)");
    });

    it("kotlin: reads a model's own field inside buildList, not the list's", async () => {
        expect.assertions(1);

        const { all } = await generate("kotlin");

        expect(all).toContain("WireValue.Num(this@ItemsSummaryResult.size)");
    });
});
