import type { Node, Type } from "ts-morph";

import isAnyDegraded from "./internal/any-token";
import { containsUnencodableMember, expandUnreachableType, referencesUnreachableLocalType } from "./internal/type-expansion";

/**
 * Render a handler's resolved return type via ts-morph's type checker. Unwraps
 * the outer `Promise<…>` so the emitted `FunctionReference<Kind, Args, Return>`
 * matches what callers see post-await. Shared by the object-literal `query(...)`
 * path and the builder terminal (`c.query(...)`) path.
 *
 * Returns `"unknown"` when the type checker can't resolve enough context —
 * typical when running against a stand-alone fixture without a tsconfig.
 */
const unwrapHandlerReturn = (handler: Node): string => {
    const signature = handler.getType().getCallSignatures()[0];

    if (!signature) {
        return "unknown";
    }

    let returnType = signature.getReturnType();

    // Unwrap a single layer of `Promise<…>` / `AsyncIterable<…>` /
    // `AsyncGenerator<…, …, …>`. The runtime awaits / iterates the handler,
    // so callers should see the inner element type — not the wrapper.
    const symbol = returnType.getSymbol() ?? returnType.getAliasSymbol();
    const wrapperName = symbol?.getName();

    if (wrapperName === "Promise" || wrapperName === "AsyncIterable" || wrapperName === "AsyncIterableIterator" || wrapperName === "AsyncGenerator") {
        const innerTypeArgument = returnType.getTypeArguments()[0];

        if (innerTypeArgument) {
            returnType = innerTypeArgument;
        }
    }

    const rendered = returnType.getText(handler);

    // `any`/empty fall back to `unknown` so downstream typings stay strict.
    if (!rendered || rendered === "any" || rendered === "never") {
        return "unknown";
    }

    // If `any` appears as a standalone identifier anywhere in the rendered
    // type (e.g. `{ channelId: any; ... }`), the type checker is in degraded
    // mode — typically because the consuming project lacks the tsconfig
    // wiring to resolve `@lunora/server`/`@lunora/values`. Surfacing such
    // partial types would mislead users; fall back to `unknown` instead.
    if (isAnyDegraded(rendered)) {
        return "unknown";
    }

    // A value `encodeWire` refuses never reaches a caller — it throws at the send
    // site (`shared/wire-codec.ts`: only plain objects, arrays, and the supported
    // built-ins round-trip). Naming one in the contract types a call that can
    // never complete: `result.at.format()` compiles and is a runtime TypeError,
    // and `private`/`#private` members get published to clients besides.
    //
    // {@link expandUnreachableType} already declined a class it was asked to
    // expand, but that only covers the types it walks. A class the handler does
    // NOT import is not bare-nameable, so the checker prints it fully qualified
    // and the reachability walk waves it through — `{ at: import("./money").Money }`
    // reached `api.ts` intact. Every return type funnels through here, so this is
    // the one place the rule holds for all of them.
    if (containsUnencodableMember(returnType, handler, 0, new Set<Type>())) {
        return "unknown";
    }

    // ts-morph renders types relative to the handler's enclosing node, so a
    // locally-declared (non-exported) interface like `interface CursorDoc {…}`
    // inside `cursors.ts` shows up as the bare name `CursorDoc[]` — unreachable
    // from `_generated/api.ts` (TS2304 on compile). Rather than erase to
    // `unknown`, structurally expand it to the real shape; only fall back when
    // the type can't be faithfully reproduced.
    const handlerFilePath = handler.getSourceFile().getFilePath();

    if (referencesUnreachableLocalType(returnType, handler, handlerFilePath)) {
        return expandUnreachableType(returnType, handler, handlerFilePath, 0, new Set<Type>()) ?? "unknown";
    }

    return rendered;
};

export default unwrapHandlerReturn;
