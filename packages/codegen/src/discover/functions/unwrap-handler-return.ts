import type { Diagnostic, Node, SourceFile, Type } from "ts-morph";
import { DiagnosticCategory } from "ts-morph";

import { recordErasedReturn } from "../erased-returns";
import isAnyDegraded from "./internal/any-token";
import { containsUnencodableMember, expandUnreachableType, referencesUnreachableLocalType } from "./internal/type-expansion";

/** The error diagnostics of each source file, computed once: a whole-file type-check is the expensive part. */
const errorsByFile = new WeakMap<SourceFile, Diagnostic[]>();

const errorsOf = (file: SourceFile): Diagnostic[] => {
    const cached = errorsByFile.get(file);

    if (cached) {
        return cached;
    }

    const errors = file.getPreEmitDiagnostics().filter((diagnostic) => diagnostic.getCategory() === DiagnosticCategory.Error);

    errorsByFile.set(file, errors);

    return errors;
};

/** The text of a diagnostic, whichever shape ts-morph returns it in. */
const messageOf = (diagnostic: Diagnostic): string => {
    const text = diagnostic.getMessageText();

    return typeof text === "string" ? text : text.getMessageText();
};

/**
 * A consequence of another error rather than a cause: the checker reports an
 * `unknown` value being used, and the name it was given is not the root.
 */
const DERIVATIVE_ERROR = /is of type 'unknown'|on type '\{\}'/;

const isDerivativeError = (message: string): boolean => DERIVATIVE_ERROR.test(message);

/**
 * The reason a handler's type is `unknown`, or `undefined` when it has no error.
 * The first error inside the handler is usually a consequence, such as
 * `'userThreads' is of type 'unknown'`. The cause is often elsewhere in the file:
 * an import of an export that no longer exists, which is then named as the cause.
 */
const typeErrorWithin = (handler: Node): string | undefined => {
    const start = handler.getStart();
    const end = handler.getEnd();
    const errors = errorsOf(handler.getSourceFile());
    const earliest = errors.find((diagnostic) => {
        const at = diagnostic.getStart();

        return at !== undefined && at >= start && at <= end;
    });

    if (earliest === undefined) {
        return undefined;
    }

    const first = messageOf(earliest);

    if (!isDerivativeError(first)) {
        return first;
    }

    const cause = errors.find((diagnostic) => messageOf(diagnostic).includes("has no exported member"));

    return cause ? `${first}; caused by: ${messageOf(cause)}` : first;
};

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
    // The checker gives up on a handler that contains a type error (an import of a
    // removed export, an unresolved name), and the result is one of these. The
    // fallback to `unknown` is deliberate, so the output is unchanged, but that
    // fallback used to be silent: codegen exited 0 and nothing said why (#1072).
    // Report it, naming the error, so the cause is visible.
    if (!rendered || rendered === "any" || rendered === "never" || rendered === "unknown") {
        const error = typeErrorWithin(handler);

        if (error !== undefined) {
            recordErasedReturn(handler, `${rendered || "any"} (${error})`);
        }

        return "unknown";
    }

    // If `any` appears as a standalone identifier anywhere in the rendered
    // type (e.g. `{ channelId: any; ... }`), the type checker is in degraded
    // mode — typically because the consuming project lacks the tsconfig
    // wiring to resolve `@lunora/server`/`@lunora/values`. Surfacing such
    // partial types would mislead users; fall back to `unknown` instead.
    // An object carrying an `any` field is the same silent fallback as a bare
    // `unknown`: a field that reads a value the checker could not type. Report
    // it when the handler also has a type error, as the branch above does.
    if (isAnyDegraded(rendered)) {
        const error = typeErrorWithin(handler);

        if (error !== undefined) {
            recordErasedReturn(handler, `${rendered} (${error})`);
        }

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
        const expanded = expandUnreachableType(returnType, handler, handlerFilePath, 0, new Set<Type>());

        // Falling back here is a SILENT downgrade: the caller sees `unknown`
        // where a shape was inferred, every consumer of it breaks, and codegen
        // exits 0. Report it the way the argument side already reports an
        // unreadable `.input()` record (issue #810).
        if (expanded === undefined) {
            recordErasedReturn(handler, rendered);
        }

        return expanded ?? "unknown";
    }

    return rendered;
};

export default unwrapHandlerReturn;
