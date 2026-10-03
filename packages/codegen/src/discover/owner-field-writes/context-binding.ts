/**
 * Which bindings denote a handler's `ctx`, resolved by symbol: the literal
 * spelling `ctx` alone misses `(c, args) => c.db.insert(…)`,
 * `({ db }, args) => db.insert(…)` and `const { db } = ctx`.
 */
import type { Node as TsNode, ParameterDeclaration, ts } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { bindingKeyName, handlerOf, isConstDeclaration, outermostValueWrapper, unwrapExpression } from "../ast";
import { declarationOf } from "../attribution";
import { classifyProcedureCall } from "../functions/classify-procedure-call";
import { mutatorServerImplOf } from "../mutators";

/** How many `const` hops (`const c = ctx; const d = c.db`) a binding is followed through. */
const MAX_CONTEXT_HOPS = 8;

/**
 * Whether `parameter` is a handler's POSITIONAL `ctx`: the first parameter of a
 * `defineMutator` `server` impl, or of a bare-factory registration's
 * `handler: (ctx, args) => …`. A builder terminal's handler takes the
 * `{ ctx, args }` options object instead, which {@link isContextObject} reads by
 * its `ctx` key.
 */
const isHandlerContextParameterUncached = (parameter: ParameterDeclaration): boolean => {
    const handler = parameter.getParent();

    if (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler) && !Node.isMethodDeclaration(handler)) {
        return false;
    }

    if (handler.getParameters()[0] !== parameter) {
        return false;
    }

    const declaration = handler.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);

    if (declaration !== undefined && mutatorServerImplOf(declaration) === handler) {
        return true;
    }

    const property = outermostValueWrapper(handler).getParent();
    const call = Node.isPropertyAssignment(property) ? property.getParent().getParent() : undefined;
    const classified = Node.isCallExpression(call) ? classifyProcedureCall(call) : undefined;

    return Node.isCallExpression(call) && classified !== undefined && classified.receiver === undefined && handlerOf(call, undefined) === handler;
};

/** Per-parameter {@link isHandlerContextParameterUncached} verdicts, keyed on the compiler node so a re-parse recomputes. */
const HANDLER_CONTEXT_CACHE = new WeakMap<ts.Node, boolean>();

/** The cached {@link isHandlerContextParameterUncached} verdict: it classifies the registration call, so once per parameter. */
const isHandlerContextParameter = (parameter: ParameterDeclaration): boolean => {
    let verdict = HANDLER_CONTEXT_CACHE.get(parameter.compilerNode);

    if (verdict === undefined) {
        verdict = isHandlerContextParameterUncached(parameter);
        HANDLER_CONTEXT_CACHE.set(parameter.compilerNode, verdict);
    }

    return verdict;
};

/**
 * Whether `node` denotes a handler's `ctx` object: the spelling `ctx` (any
 * binding, as every feeder has always matched it), a handler's positional ctx
 * parameter under any name, the `ctx` key of a destructuring (`{ ctx: c }`), or
 * a `const` bound to one of these.
 */
const isContextObject = (node: TsNode | undefined, hops = MAX_CONTEXT_HOPS): boolean => {
    const value = unwrapExpression(node);

    if (!Node.isIdentifier(value)) {
        return false;
    }

    if (value.getText() === "ctx") {
        return true;
    }

    const declaration = declarationOf(value);

    if (Node.isParameterDeclaration(declaration)) {
        return Node.isIdentifier(declaration.getNameNode()) && isHandlerContextParameter(declaration);
    }

    if (Node.isBindingElement(declaration)) {
        return declaration.getDotDotDotToken() === undefined && bindingKeyName(declaration) === "ctx";
    }

    return (
        hops > 0 && isConstDeclaration(declaration) && Node.isIdentifier(declaration.getNameNode()) && isContextObject(declaration.getInitializer(), hops - 1)
    );
};

/**
 * Whether `node` denotes a handler's `ctx.db`: `<ctx>.db` for any
 * {@link isContextObject} `<ctx>`, a `db` destructured from a handler's
 * positional ctx (`({ db }, args)`), from a `ctx` key (`({ ctx: { db } })`) or
 * from a `const` ctx (`const { db } = ctx`), or a `const` bound to one of these
 * (`const database = ctx.db`).
 */
const mayDenoteContextDatabase = (node: TsNode | undefined, hops = MAX_CONTEXT_HOPS): boolean => {
    const value = unwrapExpression(node);

    if (Node.isPropertyAccessExpression(value)) {
        return value.getName() === "db" && isContextObject(value.getExpression(), hops);
    }

    const declaration = Node.isIdentifier(value) ? declarationOf(value) : undefined;

    if (Node.isBindingElement(declaration)) {
        const holder = declaration.getParent().getParent();

        if (declaration.getDotDotDotToken() !== undefined || bindingKeyName(declaration) !== "db") {
            return false;
        }

        if (Node.isParameterDeclaration(holder)) {
            return isHandlerContextParameter(holder);
        }

        if (Node.isBindingElement(holder)) {
            return holder.getDotDotDotToken() === undefined && bindingKeyName(holder) === "ctx";
        }

        return hops > 0 && isConstDeclaration(holder) && isContextObject(holder.getInitializer(), hops - 1);
    }

    return (
        hops > 0 &&
        isConstDeclaration(declaration) &&
        Node.isIdentifier(declaration.getNameNode()) &&
        mayDenoteContextDatabase(declaration.getInitializer(), hops - 1)
    );
};

export default mayDenoteContextDatabase;
