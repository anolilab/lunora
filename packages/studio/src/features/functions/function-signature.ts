import type { FunctionArgumentDescriptor } from "../../lib/types";

/**
 * The display type of one argument: `id<table>` for foreign keys, `kind[]`
 * for arrays whose element kind is known, otherwise the bare validator kind.
 */
const argumentType = (argument: FunctionArgumentDescriptor): string => {
    if (argument.kind === "id") {
        return argument.table === undefined ? "id" : `id<${argument.table}>`;
    }

    if (argument.kind === "array") {
        return argument.element === undefined ? "array" : `${argument.element}[]`;
    }

    return argument.kind;
};

/**
 * A one-line, human-readable function signature from its argument descriptors,
 * e.g. `(channelId: id<channels>, text: string, limit?: number)`. Optional
 * arguments are marked with `?`. Returns `()` when there are no arguments.
 */
const formatSignature = (arguments_: FunctionArgumentDescriptor[] | undefined): string => {
    if (arguments_ === undefined || arguments_.length === 0) {
        return "()";
    }

    return `(${arguments_.map((argument) => `${argument.name}${argument.optional ? "?" : ""}: ${argumentType(argument)}`).join(", ")})`;
};

/** A placeholder JSON value for an argument, by validator kind. */
const placeholderValue = (kind: string): unknown => {
    switch (kind) {
        case "array": {
            return [];
        }
        case "bigint":
        case "number": {
            return 0;
        }
        case "boolean": {
            return false;
        }
        case "object":
        case "record": {
            return {};
        }
        // string / id / literal / bytes / date / timestamp / any / unknown
        default: {
            return "";
        }
    }
};

/**
 * A ready-to-edit JSON args template for a function: an object with a
 * placeholder for each REQUIRED argument (optional ones are omitted so the
 * template is a minimal valid call). Returns `{}` when there are no required
 * arguments.
 */
const argumentsTemplate = (arguments_: FunctionArgumentDescriptor[] | undefined): string => {
    const template: Record<string, unknown> = {};

    for (const argument of arguments_ ?? []) {
        if (!argument.optional) {
            template[argument.name] = placeholderValue(argument.kind);
        }
    }

    return JSON.stringify(template, undefined, 2);
};

export { argumentsTemplate, formatSignature };
