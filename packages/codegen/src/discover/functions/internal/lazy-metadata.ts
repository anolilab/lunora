import { LunoraError } from "@lunora/errors";
import type { CallExpression, Node as AstNode, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import type { ExposeCacheIR, FunctionIR } from "../../../ir";
import staticBuilderChain from "./static-builder-chain";

const unreadable = (node: AstNode, detail: string): never => {
    throw new LunoraError(
        "INTERNAL",
        `@lunora/codegen: lazy function registry needs literal ${detail} in ${node.getSourceFile().getFilePath()}:${String(node.getStartLineNumber())}`,
    );
};

const literalObject = (node: AstNode | undefined, owner: AstNode, fields: ReadonlyArray<string>): ObjectLiteralExpression => {
    if (!node || !Node.isObjectLiteralExpression(node)) {
        return unreadable(owner, "metadata objects");
    }

    const seen = new Set<string>();

    for (const property of node.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            return unreadable(property, "metadata fields without spreads, getters, or shorthand");
        }

        const name = property.getNameNode();
        const key = Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText();

        if ((!Node.isIdentifier(name) && !Node.isStringLiteral(name)) || !fields.includes(key) || seen.has(key)) {
            return unreadable(property, "supported, unique metadata fields");
        }

        seen.add(key);
    }

    return node;
};

const valueOf = (object: ObjectLiteralExpression, name: string): AstNode | undefined => {
    const property = object.getProperty(name);

    return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
};

const cacheLiteral = (node: AstNode): ExposeCacheIR => {
    const object = literalObject(node, node, ["credentialHeaders", "maxAge", "scope", "staleWhileRevalidate", "tag", "vary"]);
    const cache: ExposeCacheIR = {};

    for (const key of ["maxAge", "staleWhileRevalidate"] as const) {
        const value = valueOf(object, key);

        if (value === undefined && key !== "maxAge") {
            continue;
        }

        if (!value || !Node.isNumericLiteral(value)) {
            return unreadable(node, `cache.${key}`);
        }

        cache[key] = value.getLiteralValue();
    }

    const scope = valueOf(object, "scope");

    if (!scope || !Node.isStringLiteral(scope) || !["private", "public"].includes(scope.getLiteralValue())) {
        return unreadable(node, "cache.scope");
    }

    cache.scope = scope.getLiteralValue() as "private" | "public";

    for (const key of ["tag", "vary"] as const) {
        const value = valueOf(object, key);

        if (value === undefined) {
            continue;
        }

        if (!Node.isStringLiteral(value)) {
            return unreadable(value, `cache.${key}`);
        }

        cache[key] = value.getLiteralValue();
    }

    const headers = valueOf(object, "credentialHeaders");

    if (headers !== undefined) {
        if (!Node.isArrayLiteralExpression(headers)) {
            return unreadable(headers, "cache.credentialHeaders");
        }

        cache.credentialHeaders = headers.getElements().map((element) => {
            if (!Node.isStringLiteral(element)) {
                return unreadable(element, "cache.credentialHeaders string entries");
            }

            return element.getLiteralValue();
        });
    }

    return cache;
};

const exposeLiteral = (call: CallExpression): NonNullable<FunctionIR["expose"]> => {
    const object = literalObject(call.getArguments()[0], call, ["rest", "cache"]);
    const rest = valueOf(object, "rest");
    const cache = valueOf(object, "cache");

    if (rest !== undefined && !Node.isTrueLiteral(rest) && !Node.isFalseLiteral(rest)) {
        return unreadable(rest, ".expose({ rest })");
    }

    return { ...(rest ? { rest: Node.isTrueLiteral(rest) } : {}), ...(cache ? { cache: cacheLiteral(cache) } : {}) };
};

const x402Literal = (call: CallExpression): NonNullable<FunctionIR["x402"]> => {
    const object = literalObject(call.getArguments()[0], call, ["price"]);
    const price = valueOf(object, "price");

    if (!price || (!Node.isStringLiteral(price) && !Node.isNumericLiteral(price))) {
        return unreadable(call, "`.x402({ price })` value");
    }

    return { price: price.getLiteralValue() };
};

/** These facts gate requests before the module loads, so partial extraction is unsafe. */
const lazyMetadataFromBuilderChain = (receiver: AstNode): Pick<FunctionIR, "expose" | "x402" | "visibility"> => {
    const { factory, steps } = staticBuilderChain(receiver);

    if (!factory) {
        return unreadable(receiver, "metadata from a resolvable Lunora factory root");
    }

    const metadata: Pick<FunctionIR, "expose" | "x402" | "visibility"> = { visibility: factory.startsWith("internal") ? "internal" : "public" };

    for (const { call, name } of steps) {
        if (!["expose", "input", "meta", "output", "use", "x402"].includes(name)) {
            return unreadable(call, `known builder modifiers, got .${name}()`);
        }

        if (name === "expose" && metadata.expose === undefined) {
            metadata.expose = exposeLiteral(call);
        }

        if (name === "x402" && metadata.x402 === undefined) {
            metadata.x402 = x402Literal(call);
        }
    }

    return metadata;
};

export default lazyMetadataFromBuilderChain;
