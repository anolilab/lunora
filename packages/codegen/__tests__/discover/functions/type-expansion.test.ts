/**
 * The three checker-driven predicates deciding how a handler's return type is
 * rendered into `_generated/`.
 *
 * Every failure here is silent. `containsUnencodableMember` waving through a
 * value `encodeWire` refuses types a call that can only fail at runtime;
 * `expandUnreachableType` emitting a bare local name puts a TS2304 in generated
 * output while `lunora codegen` exits 0; and either one recursing without a
 * bound hangs the generator. `discoverFunctions` reaches these through several
 * layers of unwrapping, so the contracts are pinned directly — especially the
 * bounds and the decline cases, which the end-to-end specs do not reach.
 *
 * Fixtures are modules (`export {};`), not scripts: a script-mode file declares
 * GLOBAL names, which both `classifyType` and `isGloballyDeclared` trust and
 * never descend into, so a script fixture makes every assertion here vacuous.
 */
import type { Node, Type } from "ts-morph";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { containsUnencodableMember, expandUnreachableType, referencesUnreachableLocalType } from "../../../src/discover/functions/internal/type-expansion";

interface Subject {
    node: Node;
    path: string;
    type: Type;
}

/** The type of `declare const subject: …` in a module-mode `/app/handler.ts`, plus any sibling modules. */
const subjectOf = (source: string, siblings: Record<string, string> = {}): Subject => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });

    for (const [path, text] of Object.entries(siblings)) {
        project.createSourceFile(path, text, { overwrite: true });
    }

    const file = project.createSourceFile("/app/handler.ts", `export {};\n${source}`, { overwrite: true });
    const declaration = file.getVariableDeclarationOrThrow("subject");

    return { node: declaration, path: file.getFilePath(), type: declaration.getType() };
};

const expand = (source: string, siblings: Record<string, string> = {}): string | undefined => {
    const { node, path, type } = subjectOf(source, siblings);

    return expandUnreachableType(type, node, path, 0, new Set<Type>());
};

const unreachable = (source: string, siblings: Record<string, string> = {}): boolean => {
    const { node, path, type } = subjectOf(source, siblings);

    return referencesUnreachableLocalType(type, node, path);
};

const unencodable = (source: string, siblings: Record<string, string> = {}): boolean => {
    const { node, type } = subjectOf(source, siblings);

    return containsUnencodableMember(type, node, 0, new Set<Type>());
};

/**
 * `levels` named interfaces, each nesting the next — `L0 { a: L1 }` … the last
 * holding `leaf`. Named at every step on purpose: an anonymous `{ a: { a: … } }`
 * is one type the checker prints verbatim in a single hop, so it never costs a
 * level of expansion depth and cannot exercise the ceiling.
 */
const nestedInterfaces = (levels: number, leaf = "string"): string => {
    const declarations = Array.from({ length: levels }, (_unused, index) => {
        const next = index + 1 < levels ? `L${String(index + 1)}` : leaf;

        return `interface L${String(index)} { a: ${next} }`;
    });

    return `${declarations.join("\n")}\ndeclare const subject: L0;`;
};

/**
 * A sibling module whose exported factory returns a NON-exported alias the
 * checker inlines — `@lunora/values`'s `ObjectShapeType`/`OptionalizeShape` pair,
 * reduced to the two lines that matter.
 *
 * Two properties make it the #810 reproduction rather than a paraphrase: the
 * aliases are unexported (so `isExportedFromItsModule` is false), and the
 * checker prints their STRUCTURE — an intersection of an optional half and a
 * required half — never their names.
 */
const INLINED_SHAPE_MODULE: Record<string, string> = {
    "/app/shape.ts": [
        "type OptionalizeShape<M> = { [K in keyof M as undefined extends M[K] ? K : never]?: M[K] } & { [K in keyof M as undefined extends M[K] ? never : K]: M[K] };",
        "type ObjectShapeType<S> = OptionalizeShape<{ [K in keyof S]: S[K] }>;",
        "export declare function make(): ObjectShapeType<{ title: string; body: string | undefined }> | null;",
    ].join("\n"),
};

/** The same chain, exported from a sibling module the handler does NOT import (so it prints as its own `import(…)` qualifier). */
const nestedModule = (levels: number, leaf: string): Record<string, string> => {
    const declarations = Array.from({ length: levels }, (_unused, index) => {
        const next = index + 1 < levels ? `L${String(index + 1)}` : leaf;

        return `export interface L${String(index)} { a: ${next} }`;
    });

    return { "/app/deep.ts": `${declarations.join("\n")}\nexport class Money { format(): string { return ""; } }` };
};

describe("expandUnreachableType", () => {
    it("expands a locally declared interface to its structure", () => {
        expect.assertions(1);

        expect(expand(`interface Local { id: string; count: number }\ndeclare const subject: Local;`)).toBe("{ id: string; count: number }");
    });

    it("expands to the depth ceiling and declines one level past it", () => {
        expect.assertions(2);

        // MAX_EXPANSION_DEPTH is 8, counted from the depth 0 the callers pass.
        expect(expand(nestedInterfaces(8))).toBe("{ a: { a: { a: { a: { a: { a: { a: { a: string } } } } } } } }");
        expect(expand(nestedInterfaces(9))).toBeUndefined();
    });

    it("terminates on a self-referential type instead of recursing forever", () => {
        expect.assertions(2);

        // The `seen` set answers before the depth ceiling does; either way the
        // contract is that it returns rather than blowing the stack.
        expect(expand(`interface Tree { value: string; child: Tree }\ndeclare const subject: Tree;`)).toBeUndefined();
        expect(expand(`interface Tree { value: string; child?: Tree }\ndeclare const subject: Tree;`)).toBeUndefined();
    });

    it("quotes a property name that is not a JS identifier as JSON, rather than splicing it raw", () => {
        expect.assertions(1);

        // The injection guard: `a; b` spliced bare would close the member list
        // and inject a second one into `_generated/*`.
        expect(expand(`interface Weird { "a; b": string; ok: number }\ndeclare const subject: Weird;`)).toBe(`{ "a; b": string; ok: number }`);
    });

    it("renders an optional member as `name?: T`, dropping the `| undefined` the checker re-adds", () => {
        expect.assertions(1);

        // `b: number | undefined` is optional by the union test, not the question
        // token — and both spellings must lose the explicit `undefined`.
        expect(expand(`interface O { a?: string; b: number | undefined }\ndeclare const subject: O;`)).toBe("{ a?: string; b?: number }");
    });

    it("renders a member-less object as `{}`", () => {
        expect.assertions(1);

        expect(expand(`interface Empty {}\ndeclare const subject: Empty;`)).toBe("{}");
    });

    it("parenthesises a union element type before the array suffix", () => {
        expect.assertions(1);

        expect(expand(`interface A { x: string }\ndeclare const subject: (A | number)[];`)).toBe("(number | { x: string })[]");
    });

    it("expands an enum by VALUE — the whole enum as a union, a member as its literal", () => {
        expect.assertions(3);

        const statusEnum = `enum Status { Done = "done", Open = "open" }`;

        expect(expand(`${statusEnum}\ndeclare const subject: Status;`)).toBe(`"done" | "open"`);
        expect(expand(`${statusEnum}\ndeclare const subject: Status.Done;`)).toBe(`"done"`);
        expect(expand(`enum Level { Low = 1, High = 2 }\ndeclare const subject: Level.High;`)).toBe("2");
    });

    it("declines a class instance, and any container carrying one", () => {
        expect.assertions(3);

        const money = `class Money { format(): string { return ""; } }`;

        expect(expand(`${money}\ndeclare const subject: Money;`)).toBeUndefined();
        expect(expand(`${money}\ndeclare const subject: Money[];`)).toBeUndefined();
        expect(expand(`${money}\ninterface Plain { id: string }\ndeclare const subject: Money | Plain;`)).toBeUndefined();
    });

    it("declines shapes structural expansion cannot reproduce — index signatures and tuples", () => {
        expect.assertions(2);

        expect(expand(`interface Bag { [key: string]: number }\ndeclare const subject: Bag;`)).toBeUndefined();
        expect(expand(`interface A { x: string }\ndeclare const subject: [A, number];`)).toBeUndefined();
    });

    it("qualifies a type the handler imports, keeping the alias rather than flattening it", () => {
        expect.assertions(1);

        // The qualifier names the file the specifier RESOLVED to, carrying the
        // extension that file is emitted as — `./types` resolves to `types.ts`,
        // emitted as `.js`. `_generated/` output is consumed under NodeNext,
        // where the extension is mandatory, so the written spelling would not
        // resolve there.
        expect(expand(`import type { Post } from "./types";\ndeclare const subject: Post;`, { "/app/types.ts": `export interface Post { id: string }` })).toBe(
            `import("./types.js").Post`,
        );
    });

    it("expands a non-exported type from another module, which has no `import(…)` qualifier", () => {
        expect.assertions(2);

        const hidden = { "/app/types.ts": `interface Hidden { id: string }\nexport declare function make(): Hidden;` };
        const shown = { "/app/types.ts": `export interface Shown { id: string }\nexport declare function make(): Shown;` };

        expect(expand(`import { make } from "./types";\ndeclare const subject: ReturnType<typeof make>;`, hidden)).toBe("{ id: string }");
        // The exported control keeps the checker's own qualifier rather than
        // expanding — the fix is narrow to declarations a module keeps to itself.
        expect(expand(`import { make } from "./types";\ndeclare const subject: ReturnType<typeof make>;`, shown)).toBe('import("./types").Shown');
    });

    it("keeps a non-exported alias the checker INLINED verbatim, rather than expanding it", () => {
        expect.assertions(1);

        // The other half of the rule above, and the half that got lost (#810).
        // "Not exported from its own module" does not imply "printed bare": an
        // alias the checker has already inlined prints as its STRUCTURE, which is
        // self-contained and needs no renaming at all.
        //
        // This is the shape `v.object(...)` infers — a mapped type split into an
        // optional half and a required half — so answering `expand` here erased
        // the return type of every `Infer<v.object(…)>` procedure to `unknown`.
        expect(expand(`import { make } from "./shape";\ndeclare const subject: ReturnType<typeof make>;`, INLINED_SHAPE_MODULE)).toBe(
            "({ body?: string | undefined; } & { title: string; }) | null",
        );
    });

    it("still expands a non-exported name carrying a `$`, which is both an identifier character and a regex anchor", () => {
        expect.assertions(1);

        // The bare-name test builds a pattern from the name. `$` is legal in an
        // identifier (and TypeScript itself mints `Foo$1` when two declarations
        // collide), so an unescaped one would anchor at end-of-input, match
        // nothing, and wave the bare name through as "already inlined" — a
        // TS2304 in `_generated/`, which is precisely what #781 closed.
        expect(
            expand(`import { make } from "./types";\ndeclare const subject: ReturnType<typeof make>;`, {
                "/app/types.ts": `interface Page$1 { id: string }\nexport declare function make(): Page$1;`,
            }),
        ).toBe("{ id: string }");
    });

    it("declines an inlined alias whose text spells a module-scoped value name", () => {
        expect.assertions(2);

        // An inlined alias is self-contained only in TYPE space. Its text can
        // still carry a VALUE name — the unique-symbol brand's `[brand]` key, a
        // `typeof helper` — that resolves nowhere from `_generated/`: a TS2304
        // with `lunora codegen` exiting 0. `unknown` compiles; that text does not.
        expect(
            expand(`import { make } from "./leaf";\ndeclare const subject: ReturnType<typeof make>;`, {
                "/app/leaf.ts": [
                    "declare const brand: unique symbol;",
                    "type Id = string & { readonly [brand]: true };",
                    "interface Leaf { id: Id; name: string }",
                    "export declare function make(): Leaf;",
                ].join("\n"),
            }),
        ).toBeUndefined();
        expect(
            expand(`import { make } from "./helper";\ndeclare const subject: ReturnType<typeof make>;`, {
                "/app/helper.ts": ["declare function helper(): void;", "type Holder = { run: typeof helper };", "export declare function make(): Holder;"].join(
                    "\n",
                ),
            }),
        ).toBeUndefined();
    });

    it("keeps a symbol-keyed property whose key is GLOBAL", () => {
        expect.assertions(1);

        // `Symbol.iterator` resolves from anywhere, so a type naming it is as
        // printable from `_generated/` as from the handler.
        expect(expand(`declare const subject: { [Symbol.iterator](): Iterator<string> } | null;`)).toBe("{ [Symbol.iterator](): Iterator<string>; } | null");
    });

    it("expands an INTERSECTION rather than declining it", () => {
        expect.assertions(2);

        // `expandObjectType`'s `isObject()` guard is false for an intersection, so
        // before this branch existed an intersection reaching expansion returned
        // `undefined` and the caller fell back to `unknown` — the failure mode
        // behind #810, independent of which classification sent it here.
        expect(expand(`interface A { a: string }\ninterface B { b: number }\ntype Both = A & B;\ndeclare const subject: Both;`)).toBe(
            "{ a: string } & { b: number }",
        );
        // `[]` binds tighter than `&`, so an unparenthesised element would read
        // as `{ a: string } & ({ b: number }[])` — a different type that compiles.
        expect(expand(`interface A { a: string }\ninterface B { b: number }\ntype Both = A & B;\ndeclare const subject: Both[];`)).toBe(
            "({ a: string } & { b: number })[]",
        );
    });

    it("expands an anonymous object that embeds an unreachable local interface", () => {
        expect.assertions(1);

        expect(expand(`interface PostDoc { id: string }\ndeclare const subject: { post: PostDoc };`)).toBe("{ post: { id: string } }");
    });

    it("does NOT decline a function-valued member — encodability is containsUnencodableMember's job", () => {
        expect.assertions(2);

        const source = `interface WithFn { go: () => void; id: string }\ndeclare const subject: WithFn;`;

        // Pinning the division of labour: expansion prints the callable
        // verbatim, and `unwrapHandlerReturn` runs the encodability guard first,
        // so this rendering never reaches `_generated/` on its own.
        expect(expand(source)).toBe("{ go: () => void; id: string }");
        expect(unencodable(source)).toBe(true);
    });
});

describe("referencesUnreachableLocalType", () => {
    it("is true for a type declared in the handler's own module", () => {
        expect.assertions(1);

        expect(unreachable(`interface Local { id: string }\ndeclare const subject: Local;`)).toBe(true);
    });

    it("is false for a shape naming only globals", () => {
        expect.assertions(1);

        expect(unreachable(`declare const subject: { at: Date; ids: string[] };`)).toBe(false);
    });

    it("is false when the checker already prints the type as its own `import(…)` qualifier", () => {
        expect.assertions(1);

        // Not imported at the handler, so the printed text is self-contained and
        // resolves from `_generated/` unchanged.
        expect(unreachable(`declare const subject: import("./types").Post;`, { "/app/types.ts": `export interface Post { id: string }` })).toBe(false);
    });

    it("is true for a type another module does NOT export — there is no `import(…)` qualifier for the checker to print", () => {
        expect.assertions(1);

        // The `import("…").X` form is spelled as an export access, so a module
        // that keeps a declaration to itself has no such spelling and the checker
        // falls back to the bare name. Treating "not imported here" as "already
        // self-contained" put that bare name into `api.ts` AND `functions.ts` as a
        // TS2304 while `lunora codegen` exited 0.
        expect(
            unreachable(`import { make } from "./types";\ndeclare const subject: ReturnType<typeof make>;`, {
                "/app/types.ts": `interface Hidden { id: string }\nexport declare function make(): Hidden;`,
            }),
        ).toBe(true);
    });

    it("is false for a non-exported alias the checker INLINED — there is no name in the text to rename", () => {
        expect.assertions(1);

        // The paired half of the case above, and the one that was over-caught
        // (#810): "not exported from its own module" was read as "printed bare",
        // but the checker prints an already-inlined alias as its structure. The
        // text is then self-contained, and answering `true` sent it to an
        // expander that cannot reproduce an intersection — so the whole return
        // type became `unknown`, silently, with codegen exiting 0.
        expect(unreachable(`import { make } from "./shape";\ndeclare const subject: ReturnType<typeof make>;`, INLINED_SHAPE_MODULE)).toBe(false);
    });

    it("is false for a member of an ambient `declare module` block, which is exported without the keyword", () => {
        expect.assertions(1);

        expect(
            unreachable(`declare const subject: import("virtual:thing").Thing;`, {
                "/app/ambient.d.ts": `declare module "virtual:thing" { interface Thing { id: string } }`,
            }),
        ).toBe(false);
    });

    it("is true for a type the handler IMPORTS — the checker prints it bare, which does not resolve", () => {
        expect.assertions(1);

        expect(
            unreachable(`import type { Post } from "./types";\ndeclare const subject: Post;`, { "/app/types.ts": `export interface Post { id: string }` }),
        ).toBe(true);
    });

    it("descends object properties, so an anonymous wrapper around an unreachable type is caught", () => {
        expect.assertions(1);

        expect(unreachable(`interface PostDoc { id: string }\ndeclare const subject: { post: PostDoc };`)).toBe(true);
    });

    it("terminates on a self-referential type", () => {
        expect.assertions(1);

        expect(unreachable(`interface Tree { value: string; child: Tree }\ndeclare const subject: Tree;`)).toBe(true);
    });
});

describe("containsUnencodableMember", () => {
    it("is false for the built-ins encodeWire supports", () => {
        expect.assertions(1);

        // Globals are trusted and NOT descended into: walking `Date`'s members
        // would report it unencodable on the strength of `getTime()`.
        expect(unencodable(`declare const subject: { at: Date; blob: Uint8Array; seen: Map<string, number>; set: Set<string> };`)).toBe(false);
    });

    it("is true for a class instance reached through a plain object member", () => {
        expect.assertions(1);

        expect(unencodable(`class Money { format(): string { return ""; } }\ninterface Wrap { at: Money }\ndeclare const subject: Wrap;`)).toBe(true);
    });

    it("is true for a class carried inside a supported container", () => {
        expect.assertions(2);

        const money = `class Money { format(): string { return ""; } }`;

        expect(unencodable(`${money}\ndeclare const subject: Map<string, Money>;`)).toBe(true);
        expect(unencodable(`${money}\ndeclare const subject: Money[];`)).toBe(true);
    });

    it("is true for a callable member", () => {
        expect.assertions(1);

        expect(unencodable(`interface WithFn { go: () => void; id: string }\ndeclare const subject: WithFn;`)).toBe(true);
    });

    it("is false for an index signature — a Record-shaped return encodes fine", () => {
        expect.assertions(2);

        expect(unencodable(`declare const subject: Record<string, number>;`)).toBe(false);
        expect(unencodable(`interface Bag { [key: string]: number }\ndeclare const subject: Bag;`)).toBe(false);
    });

    it("terminates on a self-referential type while still finding the unencodable member", () => {
        expect.assertions(1);

        expect(unencodable(`interface Tree { child: Tree; go: () => void }\ndeclare const subject: Tree;`)).toBe(true);
    });

    it("finds a class however deeply it is nested", () => {
        expect.assertions(3);

        // This walk used to stop at `MAX_EXPANSION_DEPTH` and answer "encodable"
        // for whatever it had not looked at, so a class below that depth reached
        // `api.ts` verbatim and published its methods to clients for a value
        // `encodeWire` throws on.
        expect(unencodable(`declare const subject: import("./deep").L0;`, nestedModule(8, "Money"))).toBe(true);
        expect(unencodable(`declare const subject: import("./deep").L0;`, nestedModule(9, "Money"))).toBe(true);
        expect(unencodable(`declare const subject: import("./deep").L0;`, nestedModule(14, "Money"))).toBe(true);
    });

    it("walks a shared subtype once, not once per path", () => {
        expect.assertions(2);

        // `seen` is per-PATH, so without a memo a shared subtype is re-walked
        // once per path that reaches it — exponential in paths, not linear in
        // types. This shape took 1.7s at 10 levels and did not finish at 12
        // while the ceiling was 8 (the ceiling was capping the blowup, not the
        // depth), so raising the ceiling exposed it.
        const wide = (levels: number, properties: number): string => {
            const declarations = Array.from({ length: levels }, (_unused, index) => {
                const next = index + 1 < levels ? `L${String(index + 1)}` : "string";
                const members = Array.from({ length: properties }, (_v, slot) => `p${String(slot)}: ${next}`).join("; ");

                return `interface L${String(index)} { ${members} }`;
            });

            return `${declarations.join("\n")}\ndeclare const subject: L0;`;
        };

        const started = Date.now();

        expect(unencodable(wide(12, 6))).toBe(false);
        // Generous — the point is linear-vs-exponential, not a timing budget.
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("does not refuse ordinary deep types", () => {
        expect.assertions(3);

        // Refusing at `MAX_EXPANSION_DEPTH` was far more aggressive than it
        // looked: the walk spends two units per nesting level (one for the
        // property, one for the `T | undefined` union or the array element), so
        // the real budget was four. A five-level optional settings blob came
        // back `unknown`, with no diagnostic — the same silent failure this
        // check exists to prevent. The ceiling is now stack insurance only;
        // `seen` is what terminates recursion.
        expect(unencodable(`declare const subject: import("./deep").L0;`, nestedModule(8, "string"))).toBe(false);
        expect(unencodable(`declare const subject: import("./deep").L0;`, nestedModule(14, "string"))).toBe(false);
        expect(unencodable(`declare const subject: { v?: { v?: { v?: { v?: { v?: string } } } } };`)).toBe(false);
    });
});
