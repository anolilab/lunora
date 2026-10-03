import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markerLine } from "../call-site-fixture";
import { createOwnerFieldFixture, expectReported, insert, ownerMutator, rowAt } from "./owner-field-writes-fixture";

describe("discoverOwnerFieldWrites: calls handed the verified args", () => {
    const { discover, setUp, tearDown } = createOwnerFieldFixture();

    beforeEach(setUp);
    afterEach(tearDown);

    // These only read, serialize or copy `args`, so the verified owner stays verified.
    it.each([
        ["`console.log`", `console.log("createPost", args);`],
        ["`JSON.stringify`", `const raw = JSON.stringify(args);`],
        ["a `ctx.*` call", `await ctx.scheduler.runAfter(0, "notify", args);`],
        ["a spread into a new object", `await ctx.db.insert("audit", { payload: { ...args } });`],
        ["an untagged template", `const key = \`\${args}\`;`],
        ["`Object.keys`", `const keys = Object.keys(args);`],
        ["a copy via `Object.assign({}, args)`", `const copy = Object.assign({}, args);`],
        // Freezing cannot rewrite a member, so `args` may sit in any position.
        ["`Object.freeze(args)`", `Object.freeze(args);`],
        ["`Object.isFrozen(args)`", `if (!Object.isFrozen(args)) throw new Error("mutable");`],
        // Enumerating the keys reads them; it cannot rewrite a member.
        ["a `for…in` over `args`", `for (const key in args) console.log(key);`],
    ])("keeps the owner write owner-scoped next to %s", (_label, statement) => {
        expect.assertions(1);

        const source = ownerMutator(`        ${statement}
        await ${insert("args.userId")}; // @write`);

        expect(rowAt(discover(source), markerLine(source, "write"))).toMatchObject({ ownerScoped: true });
    });

    // A validator whose body this can read, and which only reads what it is
    // handed, leaves `args` verified. Anything it cannot read stays fail-closed.
    const validators = `import { checkShape } from "./validation";
function assertValid(input) {
    if (typeof input.title !== "string" || input.title.length === 0) throw new Error("title");
    checkLimits(input);
}
const checkLimits = (input) => {
    if (JSON.stringify(input).length > 1000) throw new Error("too large");
};
function sanitize(input) { input.userId = input.targetUserId; }
const identity = (input) => input;
function relay(input) { checkShape(input); }
function store(input) { cache.last = input; }
const cache = {};
function overloaded(input: string): void;
function overloaded(input: { title: string }): void;
function overloaded(input) { if (!input) throw new Error("missing"); }
function typed(input) { const copy: typeof input = { ...input }; return copy.title; }
function redeclared(input) { var input = { userId: "x" }; return input; }
`;

    it.each([
        ["a local `function` validator", `assertValid(args);`],
        ["a local arrow validator", `checkLimits(args);`],
        ["a nested validator", `const check = ({ title }) => { if (!title) throw new Error("title"); };\n        check(args);`],
        ["a validator taking no parameter there", `const ping = () => true;\n        ping(args);`],
        // The implementation behind a set of overloads is the body that runs.
        ["an overloaded validator", `overloaded(args);`],
        // `typeof input` is a type position, not a use of the value.
        ["a validator naming its parameter in a type", `typed(args);`],
        ["`typeof args` in the impl", `const shape: typeof args = { ...args };\n        console.log(shape);`],
    ])("keeps the owner write owner-scoped after %s", (_label, statement) => {
        expect.assertions(1);

        const source = `${validators}${ownerMutator(`        ${statement}\n        await ${insert("args.userId")}; // @write`)}`;

        expect(rowAt(discover(source), markerLine(source, "write"))).toMatchObject({ ownerScoped: true });
    });

    it.each([
        ["a local validator that rewrites it", `sanitize(args);`],
        ["an imported validator", `checkShape(args);`],
        ["a local validator handing it to an imported one", `relay(args);`],
        ["a local function returning it", `const same = identity(args);`],
        ["a local function storing it", `store(args);`],
        ["a nested validator that rewrites it", `const fix = (input) => { input.userId = input.targetUserId; };\n        fix(args);`],
        ["a validator taking it through a rest parameter", `const check = (...inputs) => { inputs[0].userId = "x"; };\n        check(args);`],
        ["a validator reading `arguments`", `function check() { arguments[0].userId = "x"; }\n        check(args);`],
        ["a validator redeclaring its parameter with `var`", `redeclared(args);`],
        // Accessor definers and prototype rewrites are writes, however they are spelled.
        [
            "a validator calling `__defineGetter__`",
            `const fix = (input) => { input.__defineGetter__("userId", () => input.targetUserId); };\n        fix(args);`,
        ],
        ["a validator calling `__defineSetter__`", `const fix = (input) => { input["__defineSetter__"]("userId", () => {}); };\n        fix(args);`],
        [
            "a validator calling `Object.defineProperty`",
            `const fix = (input) => { Object.defineProperty(input, "userId", { value: "x" }); };\n        fix(args);`,
        ],
        ["a validator calling `Reflect.set`", `const fix = (input) => { Reflect.set(input, "userId", "x"); };\n        fix(args);`],
        [
            "a validator calling `Reflect.defineProperty`",
            `const fix = (input) => { Reflect.defineProperty(input, "userId", { value: "x" }); };\n        fix(args);`,
        ],
        ["a validator calling `Object.setPrototypeOf`", `const fix = (input) => { Object.setPrototypeOf(input, { userId: "x" }); };\n        fix(args);`],
        ["`args.__defineGetter__` in the impl", `args.__defineGetter__("userId", () => args.targetUserId);`],
    ])("reports the owner write after %s", (_label, statement) => {
        expect.assertions(2);

        const source = `${validators}${ownerMutator(`        ${statement}\n        await ${insert("args.userId")}; // @write`)}`;

        expectReported(rowAt(discover(source), markerLine(source, "write")));
    });

    // Known noisy-but-safe: a validator this cannot read could rewrite what it is handed.
    it.each([
        ["an unknown validator", `assertValid(args);`],
        ["`Reflect.set`", `Reflect.set(args, "userId", args.targetUserId);`],
        ["a tagged template", `tag\`\${args}\`;`],
        // The read-only allowlist matches the platform globals by symbol, not by spelling.
        ["a local `JSON` that rewrites it", `const JSON = { stringify: (a) => { a.userId = a.targetUserId; } };\n        JSON.stringify(args);`],
        ["a local `structuredClone`", `const structuredClone = (a) => { a.userId = a.targetUserId; return a; };\n        structuredClone(args);`],
        // An echoing `ctx` call may hand `args` back; keeping its result aliases it.
        ["an aliasing `ctx.db.asId` result", `const alias = ctx.db.asId("users", args);\n        alias.userId = args.targetUserId;`],
    ])("reports the owner write after %s", (_label, statement) => {
        expect.assertions(2);

        const source = ownerMutator(`        ${statement}
        await ${insert("args.userId")}; // @write`);

        expectReported(rowAt(discover(source), markerLine(source, "write")));
    });
});
