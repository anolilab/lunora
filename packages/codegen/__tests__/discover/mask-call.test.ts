/**
 * The four syntactic primitives every masked-column consumer is built on:
 * `discoverMaskProcedures`, `discoverMaskMetadata`, `discoverMaskStrategies`
 * and the non-literal-policy guard all reduce to `maskCallsInChain` →
 * `memberName` → `strategyOf`, and `run-codegen`'s `assertNoMaskedShapeTable`
 * gates a security invariant on the result.
 *
 * Every failure mode here is silent. A `mask(...)` call the chain walk misses
 * makes a procedure read `usesMask: false` — the masking lint never fires,
 * nothing errors, and the generated `LUNORA_MASK_METADATA` simply omits the
 * column. A member `memberName` names WRONGLY is worse than one it refuses to
 * name, because `has-non-literal-policy` only fails closed on the members
 * `memberName` refuses. So the accept/reject boundary is pinned here directly,
 * rather than through whichever top-level discoverer happens to reach it.
 */
import type { Node as TsNode, ObjectLiteralElementLike } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";
import { beforeEach, describe, expect, it } from "vitest";

import { isMaskCall, maskCallsInChain, memberName, strategyOf } from "../../src/discover/mask-procedures/internal/mask-call";

let project: Project;

/** The initializer expression of `const subject = …;` in `source` — the node each primitive is handed. */
const subjectOf = (source: string): TsNode =>
    project.createSourceFile("subject.ts", source, { overwrite: true }).getVariableDeclarationOrThrow("subject").getInitializerOrThrow();

/** The members of the object literal `literal`, in source order. */
const membersOf = (literal: string): ObjectLiteralElementLike[] =>
    subjectOf(`const subject = ${literal};`).asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperties();

describe("isMaskCall", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    it("accepts a bare `mask(policies)` call", () => {
        expect.assertions(1);

        expect(isMaskCall(subjectOf(`const subject = mask({ users: { email: "redact" } });`))).toBe(true);
    });

    it("accepts a namespaced `maskModule.mask(policies)` call", () => {
        expect.assertions(1);

        expect(isMaskCall(subjectOf(`const subject = maskModule.mask({ users: { email: "redact" } });`))).toBe(true);
    });

    it("rejects a bare `mask` reference that is never called", () => {
        expect.assertions(1);

        // `.use(mask)` passes the factory itself, not a policy — there is no
        // policies argument to enumerate, so it must not read as a mask call.
        expect(isMaskCall(subjectOf(`const subject = mask;`))).toBe(false);
    });

    it("rejects a call to a differently named callee, bare or namespaced", () => {
        expect.assertions(2);

        expect(isMaskCall(subjectOf(`const subject = notMask({ users: {} });`))).toBe(false);
        expect(isMaskCall(subjectOf(`const subject = policies.masked({ users: {} });`))).toBe(false);
    });

    it("rejects `new mask(...)` — a construct is not a call expression", () => {
        expect.assertions(1);

        expect(isMaskCall(subjectOf(`const subject = new mask({ users: {} });`))).toBe(false);
    });

    it("recognises an aliased import through its exported name", () => {
        expect.assertions(1);

        // The name match alone missed this, so `import { mask as m }` masked
        // columns codegen never recorded — no metadata, no PII strategy lint,
        // and the shape guard cleared a table it should have refused.
        expect(
            isMaskCall(
                subjectOf(`import { mask as m } from "@lunora/server";
                           const subject = m({ users: { email: "redact" } });`),
            ),
        ).toBe(true);
    });

    it("still rejects an unimported identifier that merely looks like an alias", () => {
        expect.assertions(1);

        // No import to resolve, so there is nothing tying `m` to `mask`. The
        // alias hop only ever trusts a real import specifier.
        expect(isMaskCall(subjectOf(`const subject = m({ users: { email: "redact" } });`))).toBe(false);
    });

    it("rejects callee spellings that are neither an identifier nor a property access", () => {
        expect.assertions(2);

        // Element access and a parenthesised callee both resolve to `mask` at
        // runtime, but neither node kind is matched.
        expect(isMaskCall(subjectOf(`const subject = maskModule["mask"]({ users: {} });`))).toBe(false);
        expect(isMaskCall(subjectOf(`const subject = (mask)({ users: {} });`))).toBe(false);
    });

    it("accepts the optional-call and optional-chain spellings", () => {
        expect.assertions(2);

        expect(isMaskCall(subjectOf(`const subject = mask?.({ users: {} });`))).toBe(true);
        expect(isMaskCall(subjectOf(`const subject = maskModule?.mask({ users: {} });`))).toBe(true);
    });
});

describe("maskCallsInChain", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    it("finds a `.use(mask(...))` step directly on the receiver", () => {
        expect.assertions(2);

        const calls = maskCallsInChain(subjectOf(`const subject = c.query.use(mask({ users: { email: "redact" } }));`));

        expect(calls).toHaveLength(1);
        expect(calls[0]?.getText()).toBe(`mask({ users: { email: "redact" } })`);
    });

    it("finds a `.use(mask(...))` step several links deep, past unrelated steps", () => {
        expect.assertions(1);

        const calls = maskCallsInChain(subjectOf(`const subject = c.query.input(args).use(rls(policies)).use(mask({ users: {} }));`));

        expect(calls.map((call) => call.getText())).toStrictEqual([`mask({ users: {} })`]);
    });

    it("collects every `.use(mask(...))` in one chain, walking leftward from the receiver", () => {
        expect.assertions(1);

        // The walk is right-to-left, so the LAST `.use(mask(...))` in source is
        // the first collected. Consumers flat-map these, so the order decides
        // which duplicate `(table, column)` wins `discoverMaskMetadata`'s dedupe.
        const calls = maskCallsInChain(subjectOf(`const subject = c.query.use(mask({ a: {} })).use(rls(p)).use(mask({ b: {} }));`));

        expect(calls.map((call) => call.getText())).toStrictEqual([`mask({ b: {} })`, `mask({ a: {} })`]);
    });

    it("keeps walking past a chain root that is a plain function call", () => {
        expect.assertions(1);

        expect(maskCallsInChain(subjectOf(`const subject = builderFor(table).use(mask({ users: {} }));`))).toHaveLength(1);
    });

    it("returns nothing for a builder chain with no `.use(...)` at all", () => {
        expect.assertions(2);

        expect(maskCallsInChain(subjectOf(`const subject = c.query.input(args);`))).toStrictEqual([]);
        expect(maskCallsInChain(subjectOf(`const subject = c.query;`))).toStrictEqual([]);
    });

    it("returns nothing when `.use(...)` carries a middleware that is not a mask call", () => {
        expect.assertions(1);

        expect(maskCallsInChain(subjectOf(`const subject = c.query.use(rls(policies));`))).toStrictEqual([]);
    });

    it("returns nothing for a `mask(...)` passed to a step that is not named `use`", () => {
        expect.assertions(1);

        expect(maskCallsInChain(subjectOf(`const subject = c.query.middleware(mask({ users: { email: "redact" } }));`))).toStrictEqual([]);
    });

    it("returns nothing for a `mask(...)` wrapped in another call inside `.use(...)`", () => {
        expect.assertions(1);

        // Only a bare `mask(...)` as the FIRST argument is collected — a
        // composed middleware hides the policy from every consumer.
        expect(maskCallsInChain(subjectOf(`const subject = c.query.use(withRoles(mask({ users: {} })));`))).toStrictEqual([]);
    });

    it("only inspects the first argument of a `.use(...)` step", () => {
        expect.assertions(2);

        expect(maskCallsInChain(subjectOf(`const subject = c.query.use(mask({ a: {} }), rls(p));`))).toHaveLength(1);
        expect(maskCallsInChain(subjectOf(`const subject = c.query.use(rls(p), mask({ a: {} }));`))).toStrictEqual([]);
    });

    it("returns nothing for a bare `use(mask(...))` call with no property-access callee", () => {
        expect.assertions(1);

        expect(maskCallsInChain(subjectOf(`const subject = use(mask({ users: {} }));`))).toStrictEqual([]);
    });
});

describe("memberName", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    it("names the four member kinds it accepts and refuses the rest", () => {
        expect.assertions(1);

        const names = membersOf(`{ email: "redact", phone, note() {}, get ssn() { return ""; }, set name(_value: string) {}, ...shared }`).map((member) =>
            memberName(member),
        );

        // The two `undefined`s (set accessor, spread) are what
        // `has-non-literal-policy`'s `isUnnameableMember` mirrors by construction.
        expect(names).toStrictEqual(["email", "phone", "note", "ssn", undefined, undefined]);
    });

    it("returns the BRACKETED SOURCE TEXT for a computed key, not undefined", () => {
        expect.assertions(1);

        // This is precisely why `has-non-literal-policy.ts` checks
        // `isComputedPropertyName` independently instead of leaning on
        // `memberName` returning `undefined`: it does not. The extractors would
        // otherwise record a table literally named `[tableName]`.
        expect(membersOf(`{ [tableName]: { email: "redact" } }`).map((member) => memberName(member))).toStrictEqual(["[tableName]"]);
    });

    it("unquotes a string-literal key so it matches the real table name", () => {
        expect.assertions(3);

        // `getName()` renders the name node's SOURCE TEXT, quotes included, so
        // reading it directly recorded `mask({ "users": … })` under a table
        // named `"users"` — quote characters and all, matching no real table.
        // That silently defeated `assertNoMaskedShapeTable`, whose lookup is
        // keyed on the unquoted `ShapeIR.table`, and left the fail-closed guard
        // passing a shape that replicates a masked column raw.
        expect(membersOf(`{ "users": { "email": "redact" } }`).map((member) => memberName(member))).toStrictEqual(["users"]);
        expect(membersOf(`{ 'users': { 'email': "redact" } }`).map((member) => memberName(member))).toStrictEqual(["users"]);
        // An escape inside the literal resolves to the character it denotes,
        // which is what the table name actually is.
        expect(membersOf(String.raw`{ "we\"ird": { email: "redact" } }`).map((member) => memberName(member))).toStrictEqual([String.raw`we"ird`]);
    });

    it("renders a numeric key as its digits", () => {
        expect.assertions(1);

        expect(membersOf(`{ 42: { email: "redact" } }`).map((member) => memberName(member))).toStrictEqual(["42"]);
    });
});

describe("strategyOf", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    it("recognises the two statically known strategies", () => {
        expect.assertions(1);

        expect(membersOf(`{ email: "redact", ssn: "hash" }`).map((member) => strategyOf(member))).toStrictEqual(["redact", "hash"]);
    });

    it("recognises them through a single-quoted literal too", () => {
        expect.assertions(1);

        expect(membersOf(`{ email: 'redact' }`).map((member) => strategyOf(member))).toStrictEqual(["redact"]);
    });

    it("falls back to `custom` for a function, a reference, or an unknown literal", () => {
        expect.assertions(1);

        expect(membersOf(`{ a: (value) => value, b: STRATEGY, c: "sha256", d: "HASH", e: null }`).map((member) => strategyOf(member))).toStrictEqual([
            "custom",
            "custom",
            "custom",
            "custom",
            "custom",
        ]);
    });

    it("falls back to `custom` for a template literal spelling `hash`", () => {
        expect.assertions(1);

        // A no-substitution template is not a `StringLiteral` — fail closed
        // rather than let a lookalike spelling claim a known strategy.
        expect(membersOf("{ email: `hash` }").map((member) => strategyOf(member))).toStrictEqual(["custom"]);
    });

    it("falls back to `custom` for every member kind that is not a property assignment", () => {
        expect.assertions(1);

        expect(
            membersOf(`{ phone, note() {}, get ssn() { return "redact"; }, set name(_value: string) {}, ...shared }`).map((member) => strategyOf(member)),
        ).toStrictEqual(["custom", "custom", "custom", "custom", "custom"]);
    });
});
