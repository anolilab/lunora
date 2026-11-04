/**
 * Validation of `lunora.config.*` keys and literal value types.
 *
 * The readers in `project-config-file.ts` look up the keys they know and ignore
 * the rest, so `remot: true` or `codegen: { lazyFuntions: true }` was a config
 * that did nothing and said nothing, and `remote: "true"` read as "no
 * preference". This walks the default export against the shape `LunoraConfig`
 * declares (see `emit-app.ts`) and refuses an unknown key or a literal of the
 * wrong type. It is a parse, like the readers, so a computed value is not
 * judged here: the readers already report the ones they cannot see.
 */
import { basename } from "node:path";

import { LunoraError } from "@lunora/errors";
import type { ObjectLiteralExpression, SourceFile } from "ts-morph";
import { Node as TsNode } from "ts-morph";

import { closestMatch } from "../../../shared/suggest";
import { staticPropertyName } from "./discover/property-name";
import { defaultExportObject, parseConfigSource, unwrapLiteral } from "./project-config-file";

/** What a literal value can be, as far as a parse can tell. */
type LiteralKind = "array" | "boolean" | "function" | "null" | "number" | "object" | "string";

interface FieldShape {
    /** The kinds the value may be. */
    accepts: ReadonlyArray<LiteralKind>;
    /** For an object whose keys are user-chosen (`services`), the shape of each entry. */
    entries?: FieldShape;
    /** The type as the message names it. */
    expected: string;
    /** For an object with fixed keys, the shape of each. */
    keys?: Readonly<Record<string, FieldShape>>;
}

const BOOLEAN: FieldShape = { accepts: ["boolean"], expected: "a boolean" };
const STRING: FieldShape = { accepts: ["string"], expected: "a string" };
const STRING_ARRAY: FieldShape = { accepts: ["array"], expected: "an array" };

/** `rpc` means something only as `false`; `true` is the default it is never written as. */
const RPC: FieldShape = { accepts: ["boolean"], expected: "`false`" };

const section = (keys: Record<string, FieldShape>): FieldShape => {
    return { accepts: ["object"], expected: "an object", keys };
};

/** The `LunoraConfig` shape. Kept in step with the interface `emit-app.ts` emits; a key added there and not here is refused. */
const CONFIG_SHAPE: Readonly<Record<string, FieldShape>> = {
    advisor: section({ accept: STRING_ARRAY, minSeverity: STRING }),
    app: { accepts: ["function"], expected: "a function" },
    codegen: section({ exclude: STRING_ARRAY, lazyFunctions: BOOLEAN }),
    durableObjects: section({ merge: BOOLEAN }),
    // The object form is a reserved opt-in, read as "on" (see `interpretRemote`).
    remote: { accepts: ["boolean", "object"], expected: "a boolean" },
    services: { accepts: ["object"], entries: section({ dir: STRING, entrypoint: STRING, rpc: RPC }), expected: "an object" },
    studio: section({ companion: BOOLEAN }),
    target: STRING,
};

/** `node` unwrapped, and followed when it names a `const` in the same file. */
const resolveValue = (node: TsNode | undefined, sourceFile: SourceFile): TsNode | undefined => {
    const value = unwrapLiteral(node);

    return value !== undefined && TsNode.isIdentifier(value) ? unwrapLiteral(sourceFile.getVariableDeclaration(value.getText())?.getInitializer()) : value;
};

/** The literal kind of a resolved value; `undefined` when a parse cannot tell. */
const literalKind = (value: TsNode | undefined): LiteralKind | undefined => {
    if (value === undefined) {
        return undefined;
    }

    if (TsNode.isStringLiteral(value) || TsNode.isNoSubstitutionTemplateLiteral(value) || TsNode.isTemplateExpression(value)) {
        return "string";
    }

    if (TsNode.isTrueLiteral(value) || TsNode.isFalseLiteral(value)) {
        return "boolean";
    }

    if (TsNode.isNumericLiteral(value) || (TsNode.isPrefixUnaryExpression(value) && TsNode.isNumericLiteral(value.getOperand()))) {
        return "number";
    }

    if (TsNode.isNullLiteral(value)) {
        return "null";
    }

    if (TsNode.isObjectLiteralExpression(value)) {
        return "object";
    }

    if (TsNode.isArrayLiteralExpression(value)) {
        return "array";
    }

    return TsNode.isArrowFunction(value) || TsNode.isFunctionExpression(value) ? "function" : undefined;
};

const KIND_ARTICLE: Readonly<Record<LiteralKind, string>> = {
    array: "an array",
    boolean: "a boolean",
    function: "a function",
    null: "null",
    number: "a number",
    object: "an object",
    string: "a string",
};

/** The value a member assigns: its initializer, a shorthand's name, or the member itself for a method. */
const memberValue = (member: TsNode): TsNode | undefined => {
    if (TsNode.isPropertyAssignment(member)) {
        return member.getInitializer();
    }

    if (TsNode.isShorthandPropertyAssignment(member)) {
        return member.getNameNode();
    }

    return TsNode.isMethodDeclaration(member) ? member : undefined;
};

/** An unknown key, with the closest valid spelling when one is near enough. */
const unknownKeyProblem = (key: string, path: string, valid: ReadonlyArray<string>): string => {
    const qualify = (name: string): string => (path === "" ? name : `${path}.${name}`);
    const suggestion = closestMatch(key, valid);
    const hint = suggestion === undefined ? "" : ` Did you mean \`${qualify(suggestion)}\`?`;
    const scope = path === "" ? "" : ` of \`${path}\``;

    return `unknown key \`${qualify(key)}\`.${hint} Valid keys${scope}: ${valid.join(", ")}.`;
};

/**
 * The problems in `object` checked against `keys` (fixed keys) or `entries`
 * (user-chosen keys, each checked against one shape). A spread or a computed
 * key cannot be checked, but cannot make a named key valid either, so the
 * named ones are checked around it.
 */
const objectProblems = (object: ObjectLiteralExpression, shape: FieldShape, path: string, sourceFile: SourceFile): string[] => {
    const problems: string[] = [];

    for (const member of object.getProperties()) {
        if (TsNode.isSpreadAssignment(member)) {
            continue;
        }

        const key = staticPropertyName(member.getNameNode());

        if (key === undefined) {
            continue;
        }

        const label = path === "" ? key : `${path}.${key}`;
        const field = shape.entries ?? shape.keys?.[key];

        if (field === undefined) {
            problems.push(unknownKeyProblem(key, path, Object.keys(shape.keys ?? {})));
        } else if (!TsNode.isGetAccessorDeclaration(member) && !TsNode.isSetAccessorDeclaration(member)) {
            // An accessor's value is computed, so only its name is checked.
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: a nested object re-enters `objectProblems`
            problems.push(...fieldProblems(memberValue(member), field, label, sourceFile));
        }
    }

    return problems;
};

/** The problems in one value checked against its shape. */
const fieldProblems = (node: TsNode | undefined, field: FieldShape, label: string, sourceFile: SourceFile): string[] => {
    const value = node !== undefined && TsNode.isMethodDeclaration(node) ? node : resolveValue(node, sourceFile);
    const kind = value !== undefined && TsNode.isMethodDeclaration(value) ? "function" : literalKind(value);

    if (value === undefined || kind === undefined) {
        return [];
    }

    if (!field.accepts.includes(kind)) {
        const text = value.getText();
        const shown = text.length > 40 ? `${text.slice(0, 37)}...` : text;

        return [`\`${label}\` must be ${field.expected}, got ${KIND_ARTICLE[kind]} (${shown}).`];
    }

    if (field === RPC && TsNode.isTrueLiteral(value)) {
        return [`\`${label}\` must be ${field.expected}, got \`true\`; leave it out for an RPC binding.`];
    }

    return TsNode.isObjectLiteralExpression(value) && (field.keys !== undefined || field.entries !== undefined)
        ? objectProblems(value, field, label, sourceFile)
        : [];
};

/** Every problem in one config file; empty when it is valid or cannot be parsed (the readers report that case). */
const projectConfigProblems = (configPath: string): string[] => {
    const sourceFile = parseConfigSource(configPath);

    if (sourceFile === undefined) {
        return [];
    }

    const object = defaultExportObject(sourceFile);

    if (object === undefined) {
        return [];
    }

    return objectProblems(object, { accepts: ["object"], expected: "an object", keys: CONFIG_SHAPE }, "", sourceFile);
};

/**
 * Refuse a `lunora.config.*` with an unknown key or a literal of the wrong
 * type. Called by `runCodegen`, which every dev server, build
 * and deploy runs first, so a typo stops the run that would have ignored it.
 * @throws LunoraError `PROJECT_CONFIG_INVALID`, listing every problem.
 */
const assertValidProjectConfig = (configPath: string): void => {
    const problems = projectConfigProblems(configPath);

    if (problems.length > 0) {
        throw new LunoraError("PROJECT_CONFIG_INVALID", `${basename(configPath)} is invalid:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    }
};

export { assertValidProjectConfig, projectConfigProblems };
