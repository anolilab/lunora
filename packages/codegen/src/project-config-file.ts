/**
 * `lunora.config.*` — the project's single authored config file, read on the HOST.
 *
 * It replaces `lunora.json`, and it carries what that file carried (`target`,
 * `remote`) plus the `app` hook a Vite-first project composes its worker with.
 *
 * Read two ways, on purpose.
 *
 * {@link loadProjectConfig} EVALUATES it with `jiti`, so a computed value works
 * — but `jiti`'s non-deprecated entry point is `await jiti.import()`, so it is
 * async and only callers that can await it use it (`@lunora/vite`, whose hooks
 * can).
 *
 * {@link readProjectConfigLiterals} PARSES the default export for `target` and
 * `remote`. `runCodegen` is synchronous and resolves `target` inside itself, so
 * those two have to be answerable without awaiting.
 *
 * What the parser can see, exactly: a string / boolean / object literal assigned
 * to a property of the object the default export resolves to — directly, through
 * a `satisfies` / `as` / parenthesised wrapper, or through a `const` in the same
 * file. What it CANNOT: a computed value, a getter, a spread, `module.exports`.
 * Those do not silently become the default — the reader reports `unreadable` and
 * `resolveCodegenTarget` raises a diagnostic, because a `target` that quietly
 * becomes `cloudflare` ships the app to the wrong provider.
 *
 * BOTH readers resolve the DEFAULT export and nothing else. That is not a
 * limitation to be relaxed: `@lunora/vite` emits `import lunoraConfig from
 * "…/lunora.config"` into the composed worker entry, so a hook reached any other
 * way would fail the bundle with "does not provide an export named default" —
 * the least debuggable error that plugin can produce.
 *
 * This lives in `@lunora/codegen` rather than `@lunora/config` for the reason
 * `readProjectTarget` always did: `@lunora/config` depends on `@lunora/codegen`,
 * not the reverse, so putting the loader there and importing it here would invert
 * the edge. There is still exactly one loader for the file.
 *
 * The `app` hook is ALSO bundled into the worker by `@lunora/vite`, which is why
 * the documented shape uses a type-only `satisfies` rather than a runtime
 * `defineConfig` import: a runtime import in this file is evaluated HERE, on the
 * host, and must resolve from the host — a `cloudflare:*` module or a tsconfig
 * path alias (which `jiti` does not read) throws, and {@link loadProjectConfig}
 * reports that rather than swallowing it.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import { createJiti } from "jiti";
import type { ObjectLiteralElementLike, ObjectLiteralExpression, PropertyAssignment, ShorthandPropertyAssignment, SourceFile } from "ts-morph";
import { Node as TsNode, Project, VariableDeclarationKind } from "ts-morph";

import type { SecurityHeadersOptions } from "../../../shared/security-headers";
import { parseSecurityHeaders } from "../../../shared/security-headers";
import type { AcceptedFinding } from "./advisor-accept";
import { propertyKeyName } from "./discover/property-name";
import namedOnlyExportsProblem from "./project-config-exports";
import { findCodegenConfigFile, findProjectConfigFile } from "./project-config-path";
import type { FieldShape } from "./project-config-shape";
import { BOOLEAN, constInitializer, FUNCTION, objectOf, objectProblems, SECURITY_HEADERS, STRING, STRING_ARRAY, unwrapLiteral } from "./project-config-shape";
import { literalOf, NOT_LITERAL } from "./static-literal";

/**
 * The literals {@link readProjectConfigLiterals} proves by parsing — narrowed,
 * unlike the evaluated shape below, because the parser has just established that
 * each one IS a string or a boolean. Callers that re-checked `typeof` were
 * re-validating a fact this file already knew.
 */
interface ProjectConfigLiterals {
    /**
     * `advisor.minSeverity`, read the same way. `unreadable` when `advisor` is
     * declared but its `minSeverity` is not a string literal the parser can see,
     * kept apart from the top-level `unreadable`, which means "the target may
     * be wrong".
     */
    advisor?: { accept?: AcceptedFinding[]; acceptUnreadable?: true; minSeverity?: string; unreadable?: boolean };

    /**
     * `codegen.exclude`: extra globs (relative to `lunora/`) the source walk
     * skips on top of the built-in test-file patterns. `unreadable` when
     * `codegen` is declared but `exclude` is not an array of string literals.
     * `codegen.lazyFunctions` is read apart from it, with its own
     * `lazyFunctionsUnreadable`, so a bad `exclude` never turns the lazy
     * registry off and a bad `lazyFunctions` never drops the excludes.
     */
    codegen?: { exclude?: string[]; lazyFunctions?: boolean; lazyFunctionsUnreadable?: true; unreadable?: boolean };

    /**
     * `durableObjects.merge`: host the shard, scheduler and shard registry in one
     * Durable Object class (plan 462). `unreadable` when `durableObjects` is
     * declared but `merge` is not a boolean literal.
     */
    durableObjects?: { merge?: boolean; unreadable?: boolean };
    remote?: boolean;

    /**
     * `security.headers` as its literal value, not yet parsed (see
     * {@link readProjectSecurityHeaders}). `unreadable` when `security` is declared
     * but its `headers` is not built from literals; the caller then keeps the
     * defaults and says so, since an unreadable value must never read as "headers off".
     */
    security?: { headers?: unknown; unreadable?: true };

    /**
     * `services`: binding key → `{ dir, entrypoint? }` (plan 457). `unreadable`
     * when declared but not an object of string literals, kept apart from the
     * top-level `unreadable` like `advisor`: a service codegen cannot read must
     * fail loudly, not vanish from `ctx.services`.
     */
    services?: { declared?: Record<string, ServiceLiteral>; unreadable?: boolean };

    /**
     * `studio.companion`: deploy the companion Worker that serves the advisor procedure list to a hosted Studio.
     * `unreadable` when `studio` is declared but `companion` is not a boolean literal.
     */
    studio?: { companion?: boolean; unreadable?: boolean };
    target?: string;

    /**
     * A config file exists, but its default export could not be read as an
     * object literal — a computed value, a getter, a spread, `module.exports`.
     * The caller must not treat this as "no keys declared": that is how a
     * declared `target` becomes the default in silence.
     */
    unreadable?: boolean;
}

/** One `services.<key>` entry as written: the Worker's folder and, for RPC, its `WorkerEntrypoint` export. */
interface ServiceLiteral {
    dir: string;
    entrypoint?: string;
    /** `false` binds a named `entrypoint` as a plain fetcher, without RPC types (so without importing the service's sources). */
    rpc?: false;
}

/** The structural slice of `lunora.config.*` Lunora reads. The loader does not validate it; `runCodegen` does, by parsing (see {@link projectConfigProblems}). */
interface LunoraProjectConfig {
    /** Advisor settings for codegen (`minSeverity`). Read by `runCodegen` through {@link readProjectConfigLiterals}. */
    advisor?: unknown;
    /** The `app` hook: receives the generated `defineApp()` builder and returns it. Read by `@lunora/vite`, not by the CLI. */
    app?: unknown;
    /** Codegen settings (`exclude`, `lazyFunctions`). Read through {@link readProjectConfigLiterals}. */
    codegen?: unknown;
    /** Durable Object packaging (`merge`). Read through {@link readProjectConfigLiterals}. */
    durableObjects?: unknown;
    /** Remote-binding dev preference. */
    remote?: unknown;
    /** Baseline security headers (`headers`), read through {@link readProjectConfigLiterals}. */
    security?: unknown;
    /** Deploy target id. */
    target?: unknown;
}

/** What {@link loadProjectConfig} found: the config, or why it could not be evaluated. */
interface LoadedProjectConfig {
    config?: LunoraProjectConfig;

    /**
     * Set when the file exists but evaluating it threw. Surfaced by the caller —
     * a config whose imports do not resolve on the host used to read as "no
     * config", which silently dropped the user's whole `app` hook.
     */
    error?: string;
}

/**
 * The expression the default export resolves to, or `undefined` when there is none.
 *
 * A `satisfies` / `as` / parenthesised wrapper is unwrapped, because that is the
 * documented shape. An identifier is followed to a `const` in the same file,
 * because `const config = { … }; export default config;` is the commonest config
 * idiom there is and reading it as "no keys" was indistinguishable from an empty
 * config.
 */
const defaultExportExpression = (sourceFile: SourceFile): TsNode | undefined => {
    const assignment = sourceFile.getExportAssignments().find((candidate) => !candidate.isExportEquals());
    const expression: TsNode | undefined = unwrapLiteral(assignment?.getExpression());

    // `export default config` names a `const`; its initializer unwraps the same way, parentheses included.
    return expression !== undefined && TsNode.isIdentifier(expression) ? unwrapLiteral(constInitializer(sourceFile, expression.getText())) : expression;
};

/** The object literal the default export resolves to, or `undefined` when it does not resolve to one. */
const defaultExportObject = (sourceFile: SourceFile): ObjectLiteralExpression | undefined => {
    const expression = defaultExportExpression(sourceFile);

    return expression !== undefined && TsNode.isObjectLiteralExpression(expression) ? expression : undefined;
};

/**
 * What a default export is when the parser can see it is a literal other than an object (`"an array"`, `"a string"`),
 * else `undefined`: a computed value may still evaluate to a config object, so it is only unreadable.
 */
const nonObjectLiteralKind = (sourceFile: SourceFile): string | undefined => {
    const expression = defaultExportExpression(sourceFile);

    if (expression === undefined) {
        return undefined;
    }

    if (TsNode.isArrayLiteralExpression(expression)) {
        return "an array";
    }

    if (TsNode.isStringLiteral(expression) || TsNode.isNoSubstitutionTemplateLiteral(expression) || TsNode.isTemplateExpression(expression)) {
        return "a string";
    }

    if (TsNode.isNumericLiteral(expression)) {
        return "a number";
    }

    if (TsNode.isTrueLiteral(expression) || TsNode.isFalseLiteral(expression)) {
        return "a boolean";
    }

    return TsNode.isNullLiteral(expression) ? "null" : undefined;
};

/** The literal a property is assigned, following a shorthand to its `const` in the same file. */
const propertyLiteral = (property: PropertyAssignment | ShorthandPropertyAssignment, sourceFile: SourceFile) => {
    if (TsNode.isPropertyAssignment(property)) {
        return property.getInitializer();
    }

    return constInitializer(sourceFile, propertyKeyName(property));
};

/**
 * The literal under `key` in the plain object literal `declared`, `absent`
 * when the object does not declare it, or `unreadable` when
 * `declared` is not an object literal, the key's value cannot be resolved, or a
 * member is not a plain property. A spread (before or after the literal), a
 * getter, a method or a computed key may be what sets `key`, or override the
 * literal this would read, so any of them makes the whole object unreadable.
 */
const readPlainMember = (declared: TsNode | undefined, sourceFile: SourceFile, key: string): { absent: true } | { literal: TsNode } | { unreadable: true } => {
    const value = unwrapLiteral(declared);

    if (value === undefined || !TsNode.isObjectLiteralExpression(value)) {
        return { unreadable: true };
    }

    const properties = value.getProperties();
    const plain = properties.filter(
        (candidate): candidate is PropertyAssignment | ShorthandPropertyAssignment =>
            (TsNode.isPropertyAssignment(candidate) && !TsNode.isComputedPropertyName(candidate.getNameNode())) ||
            TsNode.isShorthandPropertyAssignment(candidate),
    );

    if (plain.length !== properties.length) {
        return { unreadable: true };
    }

    // The last one wins, as it does at runtime: `{ a: 1, a: 2 }` evaluates to 2.
    const property = plain.findLast((candidate) => propertyKeyName(candidate) === key);

    if (property === undefined) {
        return { absent: true };
    }

    const literal = propertyLiteral(property, sourceFile);

    return literal === undefined ? { unreadable: true } : { literal };
};

const ACCEPT_KEYS = ["exportName", "file", "reason", "rule"] as const;

/**
 * One `advisor.accept` entry as four non-empty string literals, or `undefined`
 * for anything else — an extra key, a computed value, a blank reason. A typo in
 * a key would otherwise match nothing and fail silently, so only the four are read.
 */
const readAcceptedEntry = (entry: TsNode): AcceptedFinding | undefined => {
    const value = unwrapLiteral(entry);

    if (value === undefined || !TsNode.isObjectLiteralExpression(value)) {
        return undefined;
    }

    const fields: Partial<Record<(typeof ACCEPT_KEYS)[number], string>> = {};

    for (const property of value.getProperties()) {
        if (!TsNode.isPropertyAssignment(property) || TsNode.isComputedPropertyName(property.getNameNode())) {
            return undefined;
        }

        const key = propertyKeyName(property);
        const initializer = unwrapLiteral(property.getInitializer());

        if (!(ACCEPT_KEYS as ReadonlyArray<string>).includes(key) || initializer === undefined) {
            return undefined;
        }

        if (!TsNode.isStringLiteral(initializer) && !TsNode.isNoSubstitutionTemplateLiteral(initializer)) {
            return undefined;
        }

        fields[key as (typeof ACCEPT_KEYS)[number]] = initializer.getLiteralValue();
    }

    const { exportName, file, reason, rule } = fields;

    return exportName?.trim() && file?.trim() && reason?.trim() && rule?.trim() ? { exportName, file, reason, rule } : undefined;
};

/** `advisor.accept` from the `advisor` literal: the entries, or `acceptUnreadable` when any part is not a literal the parser can read. */
const readAccept = (declared: TsNode | undefined, sourceFile: SourceFile): { accept?: AcceptedFinding[]; acceptUnreadable?: true } => {
    const member = readPlainMember(declared, sourceFile, "accept");

    if ("absent" in member) {
        return {};
    }

    const list = "literal" in member ? unwrapLiteral(member.literal) : undefined;

    if (list === undefined || !TsNode.isArrayLiteralExpression(list)) {
        return { acceptUnreadable: true };
    }

    const accept: AcceptedFinding[] = [];

    for (const element of list.getElements()) {
        const entry = readAcceptedEntry(element);

        if (entry === undefined) {
            return { acceptUnreadable: true };
        }

        accept.push(entry);
    }

    return { accept };
};

/**
 * `advisor.minSeverity` and `advisor.accept` from the `advisor` object literal.
 * `minSeverity` is `unreadable` when it is not a string literal the parser can
 * see, since a wrong floor hides findings. `accept` is read apart from it, so a
 * bad list drops only the acceptances, never the floor.
 */
const readAdvisor = (declared: TsNode | undefined, sourceFile: SourceFile): ProjectConfigLiterals => {
    const member = readPlainMember(declared, sourceFile, "minSeverity");
    const accepts = readAccept(declared, sourceFile);

    if ("absent" in member) {
        return { advisor: accepts };
    }

    // `accept` is read from the same plain object, so it stays valid when only `minSeverity` is not a literal.
    return "literal" in member && TsNode.isStringLiteral(member.literal)
        ? { advisor: { ...accepts, minSeverity: member.literal.getLiteralValue() } }
        : { advisor: { ...accepts, unreadable: true } };
};

/** `codegen.exclude`: an array of non-negated string literals, or `unreadable`. */
const readExclude = (declared: TsNode | undefined, sourceFile: SourceFile): { exclude?: string[]; unreadable?: boolean } => {
    const member = readPlainMember(declared, sourceFile, "exclude");

    if ("absent" in member) {
        return {};
    }

    if (!("literal" in member) || !TsNode.isArrayLiteralExpression(member.literal)) {
        return { unreadable: true };
    }

    const exclude: string[] = [];

    for (const element of member.literal.getElements()) {
        // A `!` negation would read as "anything but this" to the any-match
        // matcher and exclude every source file, so it is refused, not honoured.
        if ((!TsNode.isStringLiteral(element) && !TsNode.isNoSubstitutionTemplateLiteral(element)) || element.getLiteralValue().startsWith("!")) {
            return { unreadable: true };
        }

        exclude.push(element.getLiteralValue());
    }

    return { exclude };
};

/** `codegen.lazyFunctions`: a boolean literal, or `lazyFunctionsUnreadable`. */
const readLazyFunctions = (
    declared: TsNode | undefined,
    sourceFile: SourceFile,
    named: boolean,
): { lazyFunctions?: boolean; lazyFunctionsUnreadable?: true } => {
    const member = readPlainMember(declared, sourceFile, "lazyFunctions");

    if ("absent" in member) {
        return {};
    }

    // The whole `codegen` value is not a literal this reader can walk. Only a value whose text names the key can be the
    // unreadable `lazyFunctions`; anything else (a `codegen` that never mentions it) is not a lazy-functions problem.
    if ("unreadable" in member) {
        // A value reached through a name this file cannot read (an import, a `let`, a call) may set the key, so it is reported; so is
        // a value whose text names it. An object literal the reader cannot walk is reported only when its text names the key.
        const mayName =
            declared !== undefined &&
            (TsNode.isIdentifier(declared) || declared.getText().includes("lazyFunctions") || (named && !TsNode.isObjectLiteralExpression(declared)));

        return mayName ? { lazyFunctionsUnreadable: true } : {};
    }

    const value = "literal" in member ? unwrapLiteral(member.literal) : undefined;

    return value !== undefined && (TsNode.isTrueLiteral(value) || TsNode.isFalseLiteral(value))
        ? { lazyFunctions: value.getLiteralValue() }
        : { lazyFunctionsUnreadable: true };
};

/** `codegen.exclude` and `codegen.lazyFunctions` from the `codegen` object literal, each read on its own. */
const readCodegen = (declared: TsNode | undefined, sourceFile: SourceFile): ProjectConfigLiterals => {
    // `codegen: sharedCodegen`, parenthesized or cast, names a `const` in this file: read the object it names. Only a `const` is
    // followed, since a `let` or `var` may hold another value by the time the config runs.
    const unwrapped = unwrapLiteral(declared);
    const isName = unwrapped !== undefined && TsNode.isIdentifier(unwrapped);
    const declaration = unwrapped !== undefined && TsNode.isIdentifier(unwrapped) ? sourceFile.getVariableDeclaration(unwrapped.getText()) : undefined;
    const isConst = declaration?.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const;
    // A `const` holds a mutable object: a write or an alias elsewhere could change what is exported. Only a name with no other
    // reference (its one use is the codegen property itself) is read; any other reference leaves it unread, and so reported.
    const name = declaration?.getNameNode();
    const provable = declaration !== undefined && isConst && name !== undefined && TsNode.isIdentifier(name) && name.findReferencesAsNodes().length === 1;
    const value = provable ? (unwrapLiteral(declaration.getInitializer()) ?? unwrapped) : unwrapped;

    return { codegen: { ...readExclude(value, sourceFile), ...readLazyFunctions(value, sourceFile, isName) } };
};

/** `durableObjects.merge` from the `durableObjects` object literal: a boolean literal, or `unreadable`. */
const readDurableObjects = (declared: TsNode | undefined, sourceFile: SourceFile): ProjectConfigLiterals => {
    const member = readPlainMember(declared, sourceFile, "merge");

    if ("absent" in member) {
        return { durableObjects: {} };
    }

    return "literal" in member && (TsNode.isTrueLiteral(member.literal) || TsNode.isFalseLiteral(member.literal))
        ? { durableObjects: { merge: member.literal.getLiteralValue() } }
        : { durableObjects: { unreadable: true } };
};

/** `studio.companion` from the `studio` object literal: a boolean literal, or `unreadable`. */
const readStudio = (declared: TsNode | undefined, sourceFile: SourceFile): ProjectConfigLiterals => {
    const member = readPlainMember(declared, sourceFile, "companion");

    if ("absent" in member) {
        return { studio: {} };
    }

    return "literal" in member && (TsNode.isTrueLiteral(member.literal) || TsNode.isFalseLiteral(member.literal))
        ? { studio: { companion: member.literal.getLiteralValue() } }
        : { studio: { unreadable: true } };
};

/**
 * `security.headers` from the `security` object literal, evaluated as a literal and handed on unjudged:
 * {@link readProjectSecurityHeaders} parses it, the same way the runtime does.
 */
const readSecurity = (declared: TsNode | undefined, sourceFile: SourceFile): ProjectConfigLiterals => {
    const member = readPlainMember(declared, sourceFile, "headers");

    if ("absent" in member) {
        return { security: {} };
    }

    const headers = "literal" in member ? literalOf(member.literal) : NOT_LITERAL;

    return headers === NOT_LITERAL ? { security: { unreadable: true } } : { security: { headers } };
};

/** A member's initializer: `undefined` when absent, `"unreadable"` when present but not a plain `key: value` assignment. */
const memberInitializer = (object: ObjectLiteralExpression, name: string): TsNode | "unreadable" | undefined => {
    const member = object.getProperty(name);

    if (member === undefined) {
        return undefined;
    }

    return (TsNode.isPropertyAssignment(member) ? member.getInitializer() : undefined) ?? "unreadable";
};

/**
 * A string-literal member's value, `undefined` when absent, or `false` when present
 * but not a literal (not `"unreadable"`, which is itself a valid string value).
 */
const stringMember = (object: ObjectLiteralExpression, name: string): string | false | undefined => {
    const value = memberInitializer(object, name);

    if (value === undefined) {
        return undefined;
    }

    return value !== "unreadable" && (TsNode.isStringLiteral(value) || TsNode.isNoSubstitutionTemplateLiteral(value)) ? value.getLiteralValue() : false;
};

/**
 * `rpc` on a service: only `false` means anything (a named entrypoint called with
 * plain `fetch`), so `undefined` when absent and `"unreadable"` for any other value.
 */
const rpcMember = (object: ObjectLiteralExpression): false | "unreadable" | undefined => {
    const value = memberInitializer(object, "rpc");

    if (value === undefined) {
        return undefined;
    }

    return value !== "unreadable" && TsNode.isFalseLiteral(value) ? false : "unreadable";
};

/** `services: { key: { dir: "…", entrypoint?: "…", rpc?: false } }`, all literals, or `unreadable`. */
const readServices = (wrapped: TsNode | undefined): ProjectConfigLiterals => {
    const value = unwrapLiteral(wrapped);

    if (value === undefined || !TsNode.isObjectLiteralExpression(value)) {
        return { services: { unreadable: true } };
    }

    const declared: Record<string, ServiceLiteral> = {};

    for (const entry of value.getProperties()) {
        if (!TsNode.isPropertyAssignment(entry) || TsNode.isComputedPropertyName(entry.getNameNode())) {
            return { services: { unreadable: true } };
        }

        const initializer = unwrapLiteral(entry.getInitializer());

        // A spread inside an entry could shadow `entrypoint` with a value the reader never sees.
        if (
            initializer === undefined ||
            !TsNode.isObjectLiteralExpression(initializer) ||
            initializer.getProperties().some((member) => !TsNode.isPropertyAssignment(member))
        ) {
            return { services: { unreadable: true } };
        }

        const directory = stringMember(initializer, "dir");
        const entrypoint = stringMember(initializer, "entrypoint");
        const rpc = rpcMember(initializer);

        if (typeof directory !== "string" || entrypoint === false || rpc === "unreadable") {
            return { services: { unreadable: true } };
        }

        declared[propertyKeyName(entry)] = {
            dir: directory,
            ...(entrypoint === undefined ? {} : { entrypoint }),
            ...(rpc === undefined ? {} : { rpc }),
        };
    }

    return { services: { declared } };
};

/** The value a `codegen` property names: its identifier when it is shorthand, so the name is resolved like any other. */
const codegenValueOf = (property: PropertyAssignment | ShorthandPropertyAssignment, sourceFile: SourceFile): TsNode | undefined =>
    TsNode.isShorthandPropertyAssignment(property) ? property.getNameNode() : propertyLiteral(property, sourceFile);

type ConfigProperty = PropertyAssignment | ShorthandPropertyAssignment;

interface ConfigSection {
    read: (property: ConfigProperty, sourceFile: SourceFile) => ProjectConfigLiterals;
    /** What `runCodegen` refuses the value for not being: an unknown key or a literal of the wrong kind (see `project-config-shape.ts`). */
    shape: FieldShape;
    unreadable: ProjectConfigLiterals;
}

/** `target`: a string literal, or `unreadable`. */
const readTarget = (property: ConfigProperty, sourceFile: SourceFile): ProjectConfigLiterals => {
    const value = propertyLiteral(property, sourceFile);

    return value !== undefined && TsNode.isStringLiteral(value) ? { target: value.getLiteralValue() } : { unreadable: true };
};

/** `remote`: a boolean literal, `null` for no preference, or the object form, which is a reserved opt-in meaning "on". */
const readRemote = (property: ConfigProperty, sourceFile: SourceFile): ProjectConfigLiterals => {
    const value = unwrapLiteral(propertyLiteral(property, sourceFile));

    if (value !== undefined && (TsNode.isTrueLiteral(value) || TsNode.isFalseLiteral(value))) {
        return { remote: value.getLiteralValue() };
    }

    // `interpretRemote` reads an evaluated `null` as "no preference", so the parse does too rather than doubt the target.
    if (value !== undefined && TsNode.isNullLiteral(value)) {
        return {};
    }

    // Reading only the booleans turned a documented config into "no preference" without a word.
    return value !== undefined && TsNode.isObjectLiteralExpression(value) ? { remote: true } : { unreadable: true };
};

/**
 * Each top-level key this reader understands: how its value is read, and what it
 * contributes when the parser cannot see it (a getter or method declares it, or a
 * spread in the config object may shadow it). A key that cannot be resolved is
 * `unreadable`, never absent: "no `target` declared" and "a `target` I could not
 * read" must not be the same answer, because the second silently ships the app to
 * the default provider.
 */
const SECTIONS: ReadonlyMap<string, ConfigSection> = new Map<string, ConfigSection>([
    [
        "advisor",
        {
            read: (property, sourceFile) => readAdvisor(propertyLiteral(property, sourceFile), sourceFile),
            shape: objectOf({
                accept: { ...STRING_ARRAY, expected: "an array of objects", items: objectOf(Object.fromEntries(ACCEPT_KEYS.map((key) => [key, STRING]))) },
                minSeverity: STRING,
            }),
            unreadable: { advisor: { unreadable: true } },
        },
    ],
    // `@lunora/vite` evaluates the hook; the parse only checks it is a function.
    [
        "app",
        {
            read: () => {
                return {};
            },
            shape: FUNCTION,
            unreadable: {},
        },
    ],
    // Shorthand `{ codegen }` names the value: its identifier is what readCodegen resolves, whether the name is imported or a const here.
    [
        "codegen",
        {
            read: (property, sourceFile) => readCodegen(codegenValueOf(property, sourceFile), sourceFile),
            shape: objectOf({ exclude: STRING_ARRAY, lazyFunctions: BOOLEAN }),
            unreadable: { codegen: { lazyFunctionsUnreadable: true, unreadable: true } },
        },
    ],
    [
        "durableObjects",
        {
            read: (property, sourceFile) => readDurableObjects(propertyLiteral(property, sourceFile), sourceFile),
            shape: objectOf({ merge: BOOLEAN }),
            unreadable: { durableObjects: { unreadable: true } },
        },
    ],
    // The object form is a reserved opt-in, read as "on" (see `interpretRemote`).
    ["remote", { read: readRemote, shape: { accepts: ["boolean", "null", "object"], expected: "a boolean" }, unreadable: { unreadable: true } }],
    [
        "security",
        {
            read: (property, sourceFile) => readSecurity(propertyLiteral(property, sourceFile), sourceFile),
            shape: objectOf({ headers: SECURITY_HEADERS }),
            unreadable: { security: { unreadable: true } },
        },
    ],
    [
        "services",
        {
            read: (property, sourceFile) => readServices(propertyLiteral(property, sourceFile)),
            shape: {
                accepts: ["object"],
                entries: objectOf({
                    dir: STRING,
                    entrypoint: STRING,
                    // `true` is the default, never written: only `false` changes anything.
                    rpc: { accepts: ["boolean"], expected: "`false`", hint: "Leave it out for an RPC binding.", literal: false },
                }),
                expected: "an object",
            },
            unreadable: { services: { unreadable: true } },
        },
    ],
    [
        "studio",
        {
            read: (property, sourceFile) => readStudio(propertyLiteral(property, sourceFile), sourceFile),
            shape: objectOf({ companion: BOOLEAN }),
            unreadable: { studio: { unreadable: true } },
        },
    ],
    ["target", { read: readTarget, shape: STRING, unreadable: { unreadable: true } }],
]);

/** What one property of the config object contributes. */
const readProperty = (property: ObjectLiteralElementLike, sourceFile: SourceFile): ProjectConfigLiterals => {
    // A getter or method declares a value this reader cannot see.
    if (TsNode.isGetAccessorDeclaration(property) || TsNode.isMethodDeclaration(property)) {
        return SECTIONS.get(propertyKeyName(property))?.unreadable ?? {};
    }

    if (!TsNode.isPropertyAssignment(property) && !TsNode.isShorthandPropertyAssignment(property)) {
        return {};
    }

    return SECTIONS.get(propertyKeyName(property))?.read(property, sourceFile) ?? {};
};

/** The config file parsed into a standalone in-memory program, or `undefined` when it cannot be read. */
const parseConfigSource = (configPath: string, source: string): SourceFile => {
    const project = new Project({
        compilerOptions: { allowJs: true },
        skipFileDependencyResolution: true,
        skipLoadingLibFiles: true,
        useInMemoryFileSystem: true,
    });

    return project.createSourceFile(basename(configPath), source, { overwrite: true });
};

/** The literals of a default-exported config object, read the same way whichever way the file was found. */
const readConfigObject = (object: ObjectLiteralExpression, sourceFile: SourceFile): ProjectConfigLiterals => {
    // A spread can SHADOW a literal later in the object, so the literal this
    // reader sees is not necessarily the value that wins. Reporting it anyway is
    // the one case where this reader would be actively wrong rather than merely
    // blind, so the whole read gives up instead. It still says so for a
    // declared `advisor`, whose own warning is what tells the user the floor
    // was not applied: dropping it here left that warning silent.
    if (object.getProperties().some((property) => TsNode.isSpreadAssignment(property))) {
        const declares = (key: string): boolean =>
            object.getProperties().some((property) => !TsNode.isSpreadAssignment(property) && propertyKeyName(property) === key);

        let shadowed: ProjectConfigLiterals = { unreadable: true };

        for (const [key, section] of SECTIONS) {
            if (declares(key)) {
                shadowed = { ...shadowed, ...section.unreadable };
            }
        }

        return shadowed;
    }

    let literals: ProjectConfigLiterals = {};

    for (const property of object.getProperties()) {
        literals = { ...literals, ...readProperty(property, sourceFile) };
    }

    return literals;
};

/** Everything one parse of a config file tells: the literals the readers use, and every problem `runCodegen` refuses it for. */
interface ConfigFileAnalysis {
    literals: ProjectConfigLiterals;
    /** Set when the file has no default export but named value exports, which is also one of the `problems`. */
    namedOnly?: string;
    /** Set when the default export is a literal other than an object (an array, a string), which is also one of the `problems`. */
    notObject?: string;
    problems: string[];
}

const analyze = (configPath: string, source: string): ConfigFileAnalysis => {
    const sourceFile = parseConfigSource(configPath, source);

    const object = defaultExportObject(sourceFile);

    if (object === undefined) {
        const kind = nonObjectLiteralKind(sourceFile);
        const problem =
            kind === undefined
                ? namedOnlyExportsProblem(basename(configPath), sourceFile, SECTIONS)
                : `${basename(configPath)} exports ${kind} as its default, so none of its settings are read. Lunora reads an object: \`export default { … } satisfies LunoraConfig\`.`;

        return {
            literals: { unreadable: true },
            ...(kind === undefined ? { namedOnly: problem } : { notObject: problem }),
            problems: problem === undefined ? [] : [problem],
        };
    }

    const shape = objectOf(Object.fromEntries([...SECTIONS].map(([key, section]) => [key, section.shape])));

    return { literals: readConfigObject(object, sourceFile), problems: objectProblems(object, shape, "", sourceFile) };
};

/**
 * One analysis per file content: a codegen run asks the validator and several readers about the same file, and one
 * parse answers them all. Keyed on the text itself, not mtime + size, since a same-size rewrite can keep its
 * timestamp and would otherwise keep a stale verdict; reading the file is cheap next to parsing it.
 */
const analysisCache = new Map<string, { source: string; value: ConfigFileAnalysis }>();

const analyzeConfigFile = (configPath: string): ConfigFileAnalysis => {
    let source: string;

    try {
        source = readFileSync(configPath, "utf8");
    } catch {
        return { literals: { unreadable: true }, problems: [] };
    }

    const cached = analysisCache.get(configPath);

    if (cached?.source === source) {
        return cached.value;
    }

    const value = analyze(configPath, source);

    analysisCache.set(configPath, { source, value });

    return value;
};

/**
 * Memoized per path, keyed on mtime + size so an edit is picked up and a
 * short-lived process transpiles once. One entry per path, replaced rather than
 * accumulated: a long dev session edits the file many times.
 */
const cache = new Map<string, { key: string; value: Promise<LoadedProjectConfig> }>();

/**
 * Load `lunora.config.*`, or `{}` when the project ships none.
 *
 * `moduleCache: false` is load-bearing, not a tuning knob: `jiti`'s module cache
 * lives on `globalThis`, so a NEW instance still hands back the module it
 * compiled the first time. Without it a config edit was never picked up in a
 * long-lived dev server — the watcher fired, the server restarted, and the hook
 * stayed as it was when the process started.
 *
 * `interopDefault` is off so the namespace is not collapsed onto its default
 * export: the hook has to come from `default` specifically, because that is what
 * the emitted worker entry imports (see the module header).
 */
const loadProjectConfig = async (projectRoot: string): Promise<LoadedProjectConfig> => {
    const configPath = findProjectConfigFile(projectRoot);

    if (configPath === undefined) {
        return {};
    }

    let key: string;

    try {
        const stats = statSync(configPath);

        key = `${String(stats.mtimeMs)}:${String(stats.size)}`;
    } catch {
        return {};
    }

    const cached = cache.get(configPath);

    if (cached?.key === key) {
        return cached.value;
    }

    const pending = (async (): Promise<LoadedProjectConfig> => {
        try {
            const namespace: unknown = await createJiti(configPath, { interopDefault: false, moduleCache: false }).import(configPath);
            const value = (namespace as { default?: unknown } | undefined)?.default;
            // Only named exports: every setting in the file is ignored, the `app` hook included. Codegen refuses such a file too, but
            // `@lunora/vite` loads it to compose the worker whether or not codegen ran first, so this path says so on its own rather
            // than read it as "no config". The parse decides, so both paths name the same exports and give the same fix.
            const namedOnly = value === undefined ? analyzeConfigFile(configPath).namedOnly : undefined;

            if (namedOnly !== undefined) {
                return { error: namedOnly };
            }

            // An array is an object too, but no config: say so, as codegen does, rather than read its indexes as keys.
            if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
                return {
                    error:
                        analyzeConfigFile(configPath).notObject ??
                        `${basename(configPath)}'s default export is not an object, so none of its settings are read. Lunora reads an object: \`export default { … } satisfies LunoraConfig\`.`,
                };
            }

            return { config: value };
        } catch (error: unknown) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    })();

    cache.set(configPath, { key, value: pending });

    return pending;
};

const readConfigLiterals = (configPath: string): ProjectConfigLiterals => analyzeConfigFile(configPath).literals;

/**
 * Every problem in one config file: an unknown key, a literal of the wrong kind,
 * or only named exports. Empty when it is valid or cannot be read (the readers
 * report that case). A computed value is not judged: the readers already report
 * the ones they cannot see.
 */
const projectConfigProblems = (configPath: string): ReadonlyArray<string> => analyzeConfigFile(configPath).problems;

/**
 * The `target`, `remote`, `advisor.minSeverity`, `codegen.exclude`,
 * `codegen.lazyFunctions` and `services` LITERALS declared in the config, without evaluating it — see the
 * module header for what this can and cannot see, and why.
 */
const readProjectConfigLiterals = (projectRoot: string): ProjectConfigLiterals => {
    const configPath = findProjectConfigFile(projectRoot);

    return configPath === undefined ? {} : readConfigLiterals(configPath);
};

/**
 * `lunora.config`'s `durableObjects.merge` (plan 462). An unreadable value is
 * said out loud and treated as off: merging changes which classes wrangler binds,
 * so it is never switched on by a value the parser could not prove.
 */
const readMergeDurableObjects = (projectRoot: string): boolean => {
    const { durableObjects } = readProjectConfigLiterals(projectRoot);

    if (durableObjects?.unreadable) {
        // eslint-disable-next-line no-console -- codegen has no diagnostic sink for config literals; matches `codegen.exclude`'s warning.
        console.warn("@lunora/codegen: `durableObjects.merge` in lunora.config is not a boolean literal — the Durable Object classes stay separate.");
    }

    return durableObjects?.merge === true;
};

/** The config version the lazy-functions warning was last said for; a repeat run on the same file says nothing. */
let lazyFunctionsWarnedFor: string | undefined;

/**
 * `lunora.config`'s `codegen.lazyFunctions`: the project-wide opt-in to the lazy
 * function registry. Read inside `runCodegen` so every entry point that writes or
 * checks `_generated/` — the CLI commands, the Vite and Rspack plugins, the Studio
 * host — agrees without each having to pass the flag. An unreadable value is said
 * out loud and treated as off, like `durableObjects.merge`.
 */
const readProjectLazyFunctions = (lunoraDirectory: string): boolean => {
    const configPath = findCodegenConfigFile(lunoraDirectory);
    const { codegen } = configPath === undefined ? {} : readConfigLiterals(configPath);

    if (codegen?.lazyFunctionsUnreadable) {
        // Every entry point reads this on each run; the warning is said once per config version, as `codegen.exclude`'s is.
        const stats = configPath === undefined ? undefined : statSync(configPath, { throwIfNoEntry: false });
        const key = configPath === undefined || stats === undefined ? "" : `${configPath}:${String(stats.mtimeMs)}:${String(stats.size)}`;

        if (key !== lazyFunctionsWarnedFor) {
            lazyFunctionsWarnedFor = key;
            // eslint-disable-next-line no-console -- codegen has no diagnostic sink for config literals; matches `durableObjects.merge`'s warning.
            console.warn(
                "@lunora/codegen: `codegen.lazyFunctions` in lunora.config is not a boolean literal, so the config does not turn the function registry lazy.",
            );
        }
    }

    return codegen?.lazyFunctions === true;
};

const studioCompanionWarnedFor = new Set<string>();

/**
 * `lunora.config`'s `studio.companion`: opt in to the generated companion Worker. An unreadable value is said
 * out loud and treated as off, since the flag deploys an extra Worker and is never switched on by a value the parser could not prove.
 */
const readProjectStudioCompanion = (lunoraDirectory: string): boolean => {
    const configPath = findCodegenConfigFile(lunoraDirectory);
    const { studio } = configPath === undefined ? {} : readConfigLiterals(configPath);

    // Codegen and every binding read call this, so the warning is said once per config file rather than once per call.
    if (studio?.unreadable && configPath !== undefined && !studioCompanionWarnedFor.has(configPath)) {
        studioCompanionWarnedFor.add(configPath);
        // eslint-disable-next-line no-console -- codegen has no diagnostic sink for config literals; matches `durableObjects.merge`'s warning.
        console.warn("@lunora/codegen: `studio.companion` in lunora.config is not a boolean literal, so the companion Worker is not generated.");
    }

    return studio?.companion === true;
};

const securityWarnedFor = new Set<string>();

/** Say why `security.headers` could not be used, once per config file and reason, and pin the defaults. */
const warnDefaultSecurityHeaders = (configPath: string | undefined, literals: ProjectConfigLiterals, parsed: { problems: string[] } | undefined): true => {
    let problems: string[];

    if (parsed !== undefined) {
        ({ problems } = parsed);
    } else if (literals.unreadable && literals.security === undefined) {
        problems = ["is not an object literal codegen can read, so `security.headers` cannot be read either"];
    } else {
        problems = ["`security.headers` is not built from literals"];
    }

    const key = `${configPath ?? ""}:${problems.join(";")}`;

    if (!securityWarnedFor.has(key)) {
        securityWarnedFor.add(key);
        // eslint-disable-next-line no-console -- codegen has no diagnostic sink for config literals; matches `durableObjects.merge`'s warning.
        console.warn(`@lunora/codegen: lunora.config ${problems.join("; ")}, so the default security headers apply.`);
    }

    return true;
};

/**
 * `lunora.config`'s `security.headers`, `undefined` when the config sets none,
 * or `true` (the defaults) when the value cannot be used. Unreadable or invalid,
 * a whole config codegen cannot read included, is said out loud and pins the
 * defaults: `undefined` would let `LUNORA_SECURITY_HEADERS` turn every header
 * off, and an invalid value would fail every request at runtime. The build's
 * `_headers` writer resolves the same way, so the Worker and the static assets
 * keep sending the same headers.
 */
const readProjectSecurityHeaders = (lunoraDirectory: string): boolean | SecurityHeadersOptions | undefined => {
    const configPath = findCodegenConfigFile(lunoraDirectory);
    const literals: ProjectConfigLiterals = configPath === undefined ? {} : readConfigLiterals(configPath);
    const { security } = literals;
    // The top-level flag also marks a computed `target` or `remote`; it hides `security` only when that was not read.
    const unreadable = security?.unreadable === true || (literals.unreadable === true && security === undefined);
    const parsed = unreadable ? undefined : parseSecurityHeaders(security?.headers);

    return parsed?.ok ? parsed.value : warnDefaultSecurityHeaders(configPath, literals, parsed);
};

export type { LoadedProjectConfig, LunoraProjectConfig, ProjectConfigLiterals, ServiceLiteral };
export { findProjectConfigFile, PROJECT_CONFIG_FILENAMES } from "./project-config-path";
export {
    loadProjectConfig,
    projectConfigProblems,
    readMergeDurableObjects,
    readProjectConfigLiterals,
    readProjectLazyFunctions,
    readProjectSecurityHeaders,
    readProjectStudioCompanion,
};
