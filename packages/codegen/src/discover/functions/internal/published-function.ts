import { LunoraError } from "@lunora/errors";
import type { Node, Type } from "ts-morph";

import type { FunctionIR, ValidatorIR } from "../../../ir";
import type { LifecycleMoment } from "../classify-procedure-call";
import { renderReturnType } from "../unwrap-handler-return";
import { literalProperty, registeredKindOf } from "./registered-type";

const LIFECYCLE_MOMENTS = new Set<LifecycleMoment>(["connect", "disconnect", "init", "reactor", "whisper"]);

/** Nesting past this renders as `from`: a recursive value type would otherwise never bottom out. */
const MAX_TYPE_DEPTH = 8;

/** A type the mapper has no IR kind for, carried through as its rendered TS text. */
const opaque = (type: Type, at: Node): ValidatorIR => {
    const tsType = type.getText(at);

    return tsType === "" ? { kind: "from" } : { kind: "from", tsType };
};

const LITERAL_BOOLEANS = new Set(["false", "true"]);

/** Scalar kinds, by the checker predicate that recognises each. */
const SCALAR_KINDS: ReadonlyArray<[(type: Type) => boolean, string]> = [
    [(type) => type.isAny() || type.isUnknown(), "any"],
    [(type) => type.isString(), "string"],
    [(type) => type.isNumber(), "number"],
    [(type) => type.isBoolean(), "boolean"],
    [(type) => type.isNull(), "null"],
    [(type) => type.isBigInt(), "bigint"],
];

/** An object type's IR: a record for a pure string index, an object for plain properties, `undefined` for anything else. */
const objectIr = (type: Type, at: Node, depth: number): ValidatorIR | undefined => {
    if (!type.isObject() || type.isIntersection() || type.getCallSignatures().length > 0 || type.isClass()) {
        return undefined;
    }

    const properties = type.getProperties();

    // A type with methods is a runtime object (`Date`, a lib interface), not a JSON shape; its keys are no schema.
    if (properties.some((property) => property.getTypeAtLocation(at).getCallSignatures().length > 0)) {
        return undefined;
    }
    const indexValue = type.getStringIndexType();

    if (indexValue !== undefined && properties.length === 0) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion; valueIr maps nested values back through objectIr
        return { keyType: { kind: "string" }, kind: "record", valueType: valueIr(indexValue, at, depth + 1) };
    }

    if (indexValue !== undefined || properties.length === 0) {
        return undefined;
    }

    return {
        kind: "object",
        shape: Object.fromEntries(
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion; fieldIr maps each property back through valueIr
            properties.map((property) => [property.getName(), fieldIr(property.getTypeAtLocation(at), property.isOptional(), at, depth + 1)]),
        ),
    };
};

/**
 * The IR for a value type, so every surface built from args — the client `api`,
 * OpenAPI, MCP schemas, the non-JS SDKs — sees a real kind rather than an opaque
 * one. Covers the shapes `@lunora/values` validators produce; anything else (a
 * class, any other intersection) is carried as `from` with its text.
 */
const valueIr = (type: Type, at: Node, depth: number): ValidatorIR => {
    if (depth > MAX_TYPE_DEPTH) {
        return opaque(type, at);
    }

    const scalar = SCALAR_KINDS.find(([matches]) => matches(type));

    if (scalar !== undefined) {
        return { kind: scalar[1] };
    }

    // `v.bytes()` parses to an `ArrayBuffer` — a lib interface, which would otherwise read as an object of its methods.
    if ((type.getSymbol() ?? type.getAliasSymbol())?.getName() === "ArrayBuffer") {
        return { kind: "bytes" };
    }

    if (type.isStringLiteral() || type.isNumberLiteral() || type.isBooleanLiteral() || type.isBigIntLiteral()) {
        // `v.sensitive` leaves no trace in the type, and a literal's value could be the secret it guards.
        // Marked sensitive, schema emitters keep the type and drop the `const`; the client types still narrow.
        return { kind: "literal", literalValue: type.getText(at), sensitive: true };
    }

    // `Id<"table">` is `string & { readonly __table: "table" }` — `@lunora/values`' brand for `v.id(...)`.
    const tableName = type.isIntersection() ? literalProperty(type, "__table", at) : undefined;

    if (tableName !== undefined) {
        return { kind: "id", tableName };
    }

    if (type.isUnion()) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion; unionIr maps each member back through valueIr
        return unionIr(type.getUnionTypes(), at, depth);
    }

    if (type.isArray()) {
        const element = type.getArrayElementType();

        return element === undefined ? opaque(type, at) : { inner: valueIr(element, at, depth + 1), kind: "array" };
    }

    return objectIr(type, at, depth) ?? opaque(type, at);
};

/** A union's IR. `boolean` is the union `false | true` to the checker; it stays one member rather than two literals. */
const unionIr = (members: ReadonlyArray<Type>, at: Node, depth: number): ValidatorIR => {
    const booleans = new Set(members.filter((member) => member.isBooleanLiteral()).map((member) => member.getText(at)));
    const wholeBoolean = booleans.size === LITERAL_BOOLEANS.size;
    const mapped = members.filter((member) => !(wholeBoolean && member.isBooleanLiteral())).map((member) => valueIr(member, at, depth + 1));

    const all: ValidatorIR[] = wholeBoolean ? [...mapped, { kind: "boolean" }] : mapped;
    const [only] = all;

    return all.length === 1 && only !== undefined ? only : { kind: "union", members: all };
};

/** A key's IR: `optional` around the rest when it may be absent (its type admits `undefined`). */
const fieldIr = (type: Type, optional: boolean, at: Node, depth: number): ValidatorIR => {
    const members = type.isUnion() ? type.getUnionTypes() : [type];
    const defined = members.filter((member) => !member.isUndefined());

    if (!optional && defined.length === members.length) {
        return valueIr(type, at, depth);
    }

    if (defined.length === 0) {
        return { inner: { kind: "any" }, kind: "optional" };
    }

    const [only] = defined;
    const inner = defined.length === 1 && only !== undefined ? valueIr(only, at, depth) : unionIr(defined, at, depth);

    return { inner, kind: "optional" };
};

/**
 * One argument, from its validator's `__type` phantom (the parsed value type).
 *
 * The validator itself is not reachable: the declaration file carries its type,
 * not the `v.*()` call, so bounds and refinements are lost — the function is
 * marked `typeDerivedArgs` and the runtime parses through its own `args`.
 */
const argumentIr = (validatorType: Type, at: Node): ValidatorIR => {
    const valueType = validatorType.getProperty("__type")?.getTypeAtLocation(at);

    return valueType === undefined ? { kind: "from" } : fieldIr(valueType, false, at, 0);
};

const ASYNC_ITERABLES = new Set(["AsyncGenerator", "AsyncIterable", "AsyncIterableIterator"]);

/** The handler's resolved result: `R` out of its declared `Promise<R> | R`, or a stream's chunk out of `AsyncIterable<R>`. */
const resultType = (type: Type, at: Node): Type | undefined => {
    const returned = type.getProperty("handler")?.getTypeAtLocation(at).getCallSignatures()[0]?.getReturnType();

    if (returned !== undefined && ASYNC_ITERABLES.has((returned.getSymbol() ?? returned.getAliasSymbol())?.getName() ?? "")) {
        return returned.getTypeArguments()[0];
    }

    // Dispatch awaits the handler, so callers see `T` whether it returns `Promise<T>` or `Promise<T> | T`.
    const candidates = returned?.isUnion() ? returned.getUnionTypes() : [returned];
    const promise = candidates.find((member) => member?.getSymbol()?.getName() === "Promise");

    return promise?.getTypeArguments()[0] ?? returned;
};

/**
 * Build the {@link FunctionIR} for a registered function that reaches the
 * project only as a type: re-exported from a component published to
 * `node_modules` (`export const { heartbeat } = presence.functions`). Returns
 * `undefined` when the type is not a registered function.
 *
 * Visibility must be stated by the type (`RegisteredMutation` is public,
 * `RegisteredInternalMutation` internal). The generated client `api` is built
 * from it, so a function typed by the bare `RegisteredFunction`, whose visibility
 * is either, would be guessed — and guessing public lists an internal function
 * there. The runtime still refuses to dispatch it, but the declaration is wrong,
 * so this fails instead.
 */
const publishedFunctionIr = (at: Node, exportName: string, relativePath: string, description: string | undefined): FunctionIR | undefined => {
    const type = at.getType();
    const kind = registeredKindOf(type, at);

    if (kind === undefined) {
        return undefined;
    }

    const base = { ...(description ? { description } : {}), exportName, filePath: relativePath, kind: kind as FunctionIR["kind"] };
    // A room is reached by its literal name, which a declaration-file type does not carry (`name: string`).
    if (type.getProperty("channel")?.isOptional() === false) {
        throw new LunoraError(
            "PUBLISHED_FUNCTION_UNSUPPORTED",
            `${relativePath}:${exportName} re-exports a room from a published package; its name is not in the declared type, so codegen cannot route it. Declare the room with \`defineRoom\` in this file instead.`,
        );
    }

    const lifecycle = literalProperty(type, "lifecycle", at);
    // Every registration has an optional `lifecycle?`; only a hook's is required. One whose moment is not a
    // single literal cannot be routed, and the visibility advice below would not help it.
    const lifecycleProperty = type.getProperty("lifecycle");

    if (lifecycle === undefined && lifecycleProperty !== undefined && !lifecycleProperty.isOptional()) {
        throw new LunoraError(
            "PUBLISHED_FUNCTION_UNSUPPORTED",
            `${relativePath}:${exportName} re-exports a lifecycle hook from a published package whose type does not say which moment it runs at. ` +
                'Declare it with its moment, e.g. `RegisteredLifecycleHook & { readonly lifecycle: "disconnect" }` (what `onDisconnect` returns).',
        );
    }

    if (lifecycle !== undefined) {
        if (!LIFECYCLE_MOMENTS.has(lifecycle as LifecycleMoment)) {
            throw new LunoraError(
                "PUBLISHED_FUNCTION_UNSUPPORTED",
                `${relativePath}:${exportName} re-exports a "${lifecycle}" lifecycle hook from a published package; only a locally declared hook can carry its route. Declare it in this file instead.`,
            );
        }

        return { ...base, args: {}, lifecycle: lifecycle as LifecycleMoment, returnType: "void", visibility: "internal" };
    }

    const visibility = literalProperty(type, "visibility", at);

    if (visibility !== "internal" && visibility !== "public") {
        throw new LunoraError(
            "PUBLISHED_FUNCTION_VISIBILITY_UNKNOWN",
            `${relativePath}:${exportName} re-exports a function from a published package whose type does not say whether it is internal or public. ` +
                `Declare it in that package as \`RegisteredQuery\` / \`RegisteredMutation\` / \`RegisteredAction\` (public) or their \`RegisteredInternal*\` ` +
                `counterparts, not the bare \`RegisteredFunction\`, so codegen does not list an internal function in the client \`api\`.`,
        );
    }

    // Dispatch refuses a client call by the VALUE's marker, and an optional `visibility?: "internal"` lets the value
    // omit it — the function would be served while the client `api` hid it. Only the required form is a promise.
    if (visibility === "internal" && type.getProperty("visibility")?.isOptional() !== false) {
        throw new LunoraError(
            "PUBLISHED_FUNCTION_UNSUPPORTED",
            `${relativePath}:${exportName} re-exports an internal function from a published package whose type makes \`visibility\` optional, so the value may not carry it. ` +
                'Declare it with a `RegisteredInternal*` type, which requires `visibility: "internal"`.',
        );
    }

    const argumentsType = type.getProperty("args")?.getTypeAtLocation(at);

    // An empty args map has to mean "no arguments": the client treats such a function as holding nothing
    // sensitive. A type that does not list its keys (`any`, an index signature) would read as empty too.
    if (
        argumentsType === undefined ||
        argumentsType.isAny() ||
        argumentsType.isUnknown() ||
        argumentsType.getStringIndexType() !== undefined ||
        argumentsType.getNumberIndexType() !== undefined
    ) {
        throw new LunoraError(
            "PUBLISHED_FUNCTION_UNSUPPORTED",
            `${relativePath}:${exportName} re-exports a function from a published package whose type does not list its arguments. ` +
                "Declare its validator map with one key per argument (an empty `{}` for none) so codegen can type the client call.",
        );
    }

    const args = Object.fromEntries(argumentsType.getProperties().map((property) => [property.getName(), argumentIr(property.getTypeAtLocation(at), at)]));
    const result = resultType(type, at);

    return {
        ...base,
        args,
        // The handler body is not in the program, so it cannot be scanned for an IP read.
        ...(kind === "query" ? { readsIp: true as const } : {}),
        returnType: result ? renderReturnType(result, at) : "unknown",
        typeDerivedArgs: true,
        visibility,
    };
};

export default publishedFunctionIr;
