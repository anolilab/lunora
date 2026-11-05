/**
 * The shapes `lunora.config.*` values are checked against, and the walker that
 * checks a parsed value against one.
 *
 * `project-config-file.ts` owns the top-level keys (its `SECTIONS` table gives
 * each its reader and its shape) and calls in here for a section's value. This
 * module knows nothing about which keys exist, so it never imports that one.
 *
 * One rule decides what is checked, the same one the readers follow: a name is
 * always checked, because nothing can make `traget` a valid key, but a value
 * only where the parser can prove it is the value that wins. An object with a
 * spread may have any of its members shadowed, so only its names are checked; a
 * getter or setter computes its value, so only its name is.
 */
import type { ObjectLiteralExpression, SourceFile } from "ts-morph";
import { Node as TsNode, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import type { SecurityHeadersOptions } from "../../../shared/security-headers";
import { HSTS_KEYS, SECURITY_HEADER_KEYS } from "../../../shared/security-headers";
import { closestMatch } from "../../../shared/suggest";
import { staticPropertyName } from "./discover/property-name";

/** What a literal value can be, as far as a parse can tell. */
type LiteralKind = "array" | "bigint" | "boolean" | "function" | "null" | "number" | "object" | "string";

interface FieldShape {
    /** The kinds the value may be. */
    accepts: ReadonlyArray<LiteralKind>;
    /** For an object whose keys are user-chosen (`services`), the shape of each entry. */
    entries?: FieldShape;
    /** The type as the message names it. */
    expected: string;
    /** Said after a refused `literal`, to say what to write instead. */
    hint?: string;
    /** For an array, the shape of each element. */
    items?: FieldShape;
    /** For an object with fixed keys, the shape of each. */
    keys?: Readonly<Record<string, FieldShape>>;
    /** The one boolean the value may be, when a boolean is accepted only as that literal (`rpc: false`, `csp: false`). */
    literal?: boolean;
}

const BOOLEAN: FieldShape = { accepts: ["boolean"], expected: "a boolean" };
const FUNCTION: FieldShape = { accepts: ["function"], expected: "a function" };
const NUMBER: FieldShape = { accepts: ["number"], expected: "a number" };
const STRING: FieldShape = { accepts: ["string"], expected: "a string" };
const STRING_ARRAY: FieldShape = { accepts: ["array"], expected: "an array of strings", items: STRING };
const STRING_OR_FALSE: FieldShape = { accepts: ["boolean", "string"], expected: "a string or `false`", literal: false };

const objectOf = (keys: Readonly<Record<string, FieldShape>>): FieldShape => {
    return { accepts: ["object"], expected: "an object", keys };
};

/** Each `security.headers` option's shape. A mapped type, so an option added to `SecurityHeadersOptions` without a shape here does not compile. */
const SECURITY_HEADER_SHAPES: Readonly<Record<keyof SecurityHeadersOptions, FieldShape>> = {
    crossOriginOpenerPolicy: STRING_OR_FALSE,
    csp: STRING_OR_FALSE,
    frameAncestors: STRING_ARRAY,
    frameOptions: STRING_OR_FALSE,
    hsts: {
        accepts: ["boolean", "object"],
        expected: "a boolean or an object",
        keys: Object.fromEntries(HSTS_KEYS.map((key) => [key, key === "maxAge" ? NUMBER : BOOLEAN])),
    },
    permissionsPolicy: STRING_OR_FALSE,
    referrerPolicy: STRING_OR_FALSE,
};

/**
 * `security.headers`: the key list comes from the runtime's own, so the two cannot disagree. Only kinds are checked
 * here; a value outside a header's vocabulary is `parseSecurityHeaders`' to report when the build reads it.
 */
const SECURITY_HEADERS: FieldShape = {
    accepts: ["boolean", "object"],
    expected: "a boolean or an object",
    keys: Object.fromEntries(SECURITY_HEADER_KEYS.toSorted((left, right) => left.localeCompare(right)).map((key) => [key, SECURITY_HEADER_SHAPES[key]])),
};

/** `value` with any `satisfies`, `as` or parenthesised wrapper peeled off. */
const unwrapLiteral = (value: TsNode | undefined): TsNode | undefined => {
    let inner = value;

    while (inner !== undefined && (TsNode.isSatisfiesExpression(inner) || TsNode.isAsExpression(inner) || TsNode.isParenthesizedExpression(inner))) {
        inner = inner.getExpression();
    }

    return inner;
};

/**
 * The initializer of the `const` named `name` in this file, or `undefined`. Only a `const` is followed: a `let` or
 * `var` may be reassigned before the config is exported, so its initializer is not the value that is read.
 */
const constInitializer = (sourceFile: SourceFile, name: string): TsNode | undefined => {
    const declaration = sourceFile.getVariableDeclaration(name);

    return declaration?.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const ? declaration.getInitializer() : undefined;
};

/** `node` unwrapped, and followed when it names a `const` in the same file. A method is its own value. */
const resolveValue = (node: TsNode | undefined, sourceFile: SourceFile): TsNode | undefined => {
    const value = unwrapLiteral(node);

    return value !== undefined && TsNode.isIdentifier(value) ? unwrapLiteral(constInitializer(sourceFile, value.getText())) : value;
};

/** The boolean `!0` / `!1` (a minifier's `true` / `false`) evaluates to, or `undefined` for anything else. */
const negatedNumber = (value: TsNode): boolean | undefined =>
    TsNode.isPrefixUnaryExpression(value) && value.getOperatorToken() === SyntaxKind.ExclamationToken && TsNode.isNumericLiteral(value.getOperand())
        ? Number(value.getOperand().getText()) === 0
        : undefined;

/** The boolean a boolean-kind literal evaluates to. */
const booleanValue = (value: TsNode): boolean => negatedNumber(value) ?? TsNode.isTrueLiteral(value);

/** The literal kind of a resolved value; `undefined` when a parse cannot tell. */
const literalKind = (value: TsNode | undefined): LiteralKind | undefined => {
    if (value === undefined) {
        return undefined;
    }

    if (TsNode.isStringLiteral(value) || TsNode.isNoSubstitutionTemplateLiteral(value) || TsNode.isTemplateExpression(value)) {
        return "string";
    }

    if (TsNode.isTrueLiteral(value) || TsNode.isFalseLiteral(value) || negatedNumber(value) !== undefined) {
        return "boolean";
    }

    if (TsNode.isBigIntLiteral(value) || (TsNode.isPrefixUnaryExpression(value) && TsNode.isBigIntLiteral(value.getOperand()))) {
        return "bigint";
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

    return TsNode.isArrowFunction(value) || TsNode.isFunctionExpression(value) || TsNode.isMethodDeclaration(value) ? "function" : undefined;
};

const KIND_ARTICLE: Readonly<Record<LiteralKind, string>> = {
    array: "an array",
    bigint: "a bigint",
    boolean: "a boolean",
    function: "a function",
    null: "null",
    number: "a number",
    object: "an object",
    string: "a string",
};

/** The value an object member assigns: its initializer, a shorthand's name, or the member itself for a method. */
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

/** The problems in one value checked against its shape. */
const fieldProblems = (node: TsNode | undefined, field: FieldShape, label: string, sourceFile: SourceFile): string[] => {
    const value = resolveValue(node, sourceFile);
    const kind = literalKind(value);

    if (value === undefined || kind === undefined) {
        return [];
    }

    const text = value.getText();
    const shown = text.length > 40 ? `${text.slice(0, 37)}...` : text;

    if (!field.accepts.includes(kind)) {
        return [`\`${label}\` must be ${field.expected}, got ${KIND_ARTICLE[kind]} (${shown}).`];
    }

    if (field.literal !== undefined && kind === "boolean" && booleanValue(value) !== field.literal) {
        return [`\`${label}\` must be ${field.expected}, got \`${text}\`.${field.hint === undefined ? "" : ` ${field.hint}`}`];
    }

    if (field.items !== undefined && TsNode.isArrayLiteralExpression(value)) {
        const { items } = field;

        // A spread element adds values a parse cannot see, and the elements after it no longer sit at their written index.
        const elements = value.getElements();
        const spreadAt = elements.findIndex((element) => TsNode.isSpreadElement(element));
        const checked = spreadAt === -1 ? elements : elements.slice(0, spreadAt);

        return checked.flatMap((element, index) => fieldProblems(element, items, `${label}[${String(index)}]`, sourceFile));
    }

    return TsNode.isObjectLiteralExpression(value) && (field.keys !== undefined || field.entries !== undefined)
        ? // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: a nested object re-enters `objectProblems`
          objectProblems(value, field, label, sourceFile)
        : [];
};

/**
 * The problems in `object` checked against `keys` (fixed keys) or `entries` (user-chosen keys, each checked against one
 * shape). `namesOnly` is set below a member whose value may be shadowed: its nested names are still checked, its values not.
 */
const objectProblems = (object: ObjectLiteralExpression, shape: FieldShape, path: string, sourceFile: SourceFile, namesOnly = false): string[] => {
    const members = object.getProperties();
    const keyOf = (member: (typeof members)[number]): string | undefined =>
        TsNode.isSpreadAssignment(member) ? undefined : staticPropertyName(member.getNameNode());
    // See the module header: a spread, or a computed key the parse cannot name, may shadow any member, so the values
    // are not the ones that win.
    const valuesReadable = !namesOnly && members.every((member) => keyOf(member) !== undefined);
    const problems: string[] = [];
    // `{ target: 1, target: "cloudflare" }` evaluates to its last `target`, which is the one the readers use.
    const effective = new Map(members.map((member) => [keyOf(member), member]));

    for (const member of members) {
        const key = keyOf(member);

        if (key === undefined) {
            continue;
        }

        // `Object.hasOwn`, not a lookup: `__proto__` or `toString` would find the prototype's member and read it as a shape.
        const field = shape.entries ?? (shape.keys !== undefined && Object.hasOwn(shape.keys, key) ? shape.keys[key] : undefined);

        if (field === undefined) {
            problems.push(unknownKeyProblem(key, path, Object.keys(shape.keys ?? {})));
        } else {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: a nested object re-enters `objectProblems`
            problems.push(...memberProblems(member, field, path === "" ? key : `${path}.${key}`, sourceFile, valuesReadable && effective.get(key) === member));
        }
    }

    return problems;
};

/**
 * A known member's problems: its value checked against `field` when that value is the one that wins, else only the
 * names nested in it. A getter or setter computes its value, so it has neither.
 */
const memberProblems = (member: TsNode, field: FieldShape, label: string, sourceFile: SourceFile, valueWins: boolean): string[] => {
    if (TsNode.isGetAccessorDeclaration(member) || TsNode.isSetAccessorDeclaration(member)) {
        return [];
    }

    if (valueWins) {
        return fieldProblems(memberValue(member), field, label, sourceFile);
    }

    const value = resolveValue(memberValue(member), sourceFile);

    return value !== undefined && TsNode.isObjectLiteralExpression(value) && (field.keys !== undefined || field.entries !== undefined)
        ? objectProblems(value, field, label, sourceFile, true)
        : [];
};

export type { FieldShape };
export { BOOLEAN, constInitializer, FUNCTION, objectOf, objectProblems, SECURITY_HEADERS, STRING, STRING_ARRAY, unwrapLiteral };
