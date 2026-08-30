import type { CallExpression, Expression, Node as TsNode, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import { diagnosticAt } from "../../../diagnostics";
import type { VectorIndexIR } from "../../../ir";

const VECTOR_METRICS = new Set(["cosine", "dot-product", "euclidean"]);

/**
 * `property.getName()` returns the string-literal's text WITH its surrounding
 * quotes for a quoted key (e.g. `"delete"` yields `'"delete"'`, not `delete`),
 * verified empirically against ts-morph — so both the reserved-name and
 * identifier checks below must strip them first, or a quoted `"delete"` key
 * would slip past `RESERVED_TABLE_NAMES.has` and a quoted `"user-profiles"`
 * key would slip past the identifier test.
 */
const stripQuotes = (name: string): string => name.replaceAll(/^["']|["']$/gu, "");

/** Read the named property's initializer off an object literal, or `undefined` when absent / not a plain property assignment. */
const objectPropertyInitializer = (objectLiteral: ObjectLiteralExpression, name: string): Expression | undefined => {
    const property = objectLiteral.getProperty(name);

    if (property && Node.isPropertyAssignment(property)) {
        return property.getInitializer();
    }

    return undefined;
};

/** Read a string-literal property from an object literal, or `undefined`. */
const getStringProperty = (object: ObjectLiteralExpression, key: string): string | undefined => {
    const initializer = objectPropertyInitializer(object, key);

    if (initializer && Node.isStringLiteral(initializer)) {
        return initializer.getLiteralText();
    }

    return undefined;
};

/** Read a numeric-literal property from an object literal, or `undefined`. */
const getNumberProperty = (object: ObjectLiteralExpression, key: string): number | undefined => {
    const initializer = objectPropertyInitializer(object, key);

    if (initializer && Node.isNumericLiteral(initializer)) {
        return Number(initializer.getLiteralText());
    }

    return undefined;
};

/** Read a boolean-literal property, or `undefined` when absent (or not a literal). */
const getBooleanProperty = (object: ObjectLiteralExpression, key: string): boolean | undefined => {
    const initializer = objectPropertyInitializer(object, key);

    if (initializer && (Node.isTrueLiteral(initializer) || Node.isFalseLiteral(initializer))) {
        return initializer.getLiteralValue();
    }

    return undefined;
};

/** Read an array-of-string-literals property, or `undefined`. */
const getStringArrayProperty = (object: ObjectLiteralExpression, key: string): string[] | undefined => {
    const initializer = objectPropertyInitializer(object, key);

    if (initializer && Node.isArrayLiteralExpression(initializer)) {
        return initializer
            .getElements()
            .filter((element): element is Expression & { getLiteralText: () => string } => Node.isStringLiteral(element))
            .map((element) => element.getLiteralText());
    }

    return undefined;
};

const asMetric = (value: string | undefined): VectorIndexIR["metric"] => (value && VECTOR_METRICS.has(value) ? (value as VectorIndexIR["metric"]) : undefined);

/** Read the literal name of an index/search/vector builder's first string argument, or `"_unnamed_"`. */
const indexNameOf = (nameArgument: Node | undefined): string =>
    nameArgument && Node.isStringLiteral(nameArgument) ? nameArgument.getLiteralText() : "_unnamed_";

/** Read a non-empty string-array-literal property off an object literal, or `undefined`. */
const stringArrayPropertyOf = (object: ObjectLiteralExpression, property: string): string[] | undefined => {
    const items = getStringArrayProperty(object, property);

    return items !== undefined && items.length > 0 ? items : undefined;
};

/**
 * Walk the builder chain wrapping `defineSchemaCall` for a `.<methodName>("literal")`
 * link and return its validated string-literal argument, or `undefined` when the
 * method is absent from the chain (found regardless of where it sits, e.g.
 * `defineSchema(...).rls("required").jurisdiction("us").extend(...)`). Shared by
 * `jurisdictionOf` and `rlsModeOf`, which differ only in the method
 * name, the allowed-literal `Set`, and the diagnostic phrasing. Throws (via
 * {@link diagnosticAt}) on a non-literal argument or an unrecognised literal, so a
 * typo fails loudly rather than silently mis-modelling the schema.
 */
const chainedStringLiteralArgument = <T extends string>(
    defineSchemaCall: CallExpression,
    methodName: string,
    noun: string,
    allowed: ReadonlySet<T>,
    expected: string,
): T | undefined => {
    let current: TsNode = defineSchemaCall;

    for (;;) {
        const parent = current.getParent();

        if (!parent || !Node.isPropertyAccessExpression(parent)) {
            break;
        }

        const callParent = parent.getParent();

        if (!callParent || !Node.isCallExpression(callParent)) {
            break;
        }

        if (parent.getName() === methodName) {
            const argument = callParent.getArguments()[0];

            if (!argument || !Node.isStringLiteral(argument)) {
                throw diagnosticAt(callParent, `\`.${methodName}(...)\` expects a string literal (${expected})`);
            }

            const value = argument.getLiteralText() as T;

            if (!allowed.has(value)) {
                throw diagnosticAt(argument, `unknown ${noun} ${JSON.stringify(value)} — expected ${expected}`);
            }

            return value;
        }

        current = callParent;
    }

    return undefined;
};

export {
    asMetric,
    chainedStringLiteralArgument,
    getBooleanProperty,
    getNumberProperty,
    getStringArrayProperty,
    getStringProperty,
    indexNameOf,
    objectPropertyInitializer,
    stringArrayPropertyOf,
    stripQuotes,
};
