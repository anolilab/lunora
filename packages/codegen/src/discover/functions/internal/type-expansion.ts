import type { Symbol as TsSymbol, Type } from "ts-morph";
import { Node } from "ts-morph";

import type { QualifiedImport } from "./name-rendering";
import { annotationRendering, classifyType, isGloballyDeclared } from "./name-rendering";

/** JS identifier allowlist — mirrors `emit.ts`'s `IDENTIFIER_RE`, gating raw splice of a property name. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;

/**
 * Render an expanded object-type property key for splicing into generated TS:
 * bare when it's a JS identifier, otherwise JSON-quoted (a valid TS member name).
 * Mirrors `emit.ts`'s `renderPropertyKey` so this expansion path can't inject a
 * non-identifier property name (e.g. `"a; b"`) verbatim into `_generated/*`.
 */
const renderExpandedPropertyKey = (propertyName: string): string => (IDENTIFIER_RE.test(propertyName) ? propertyName : JSON.stringify(propertyName));

/** Composite child types of `type` (type arguments + union/intersection members) to recurse into. */
const childTypes = (type: Type): Type[] => {
    const children = [...type.getTypeArguments()];

    if (type.isUnion()) {
        children.push(...type.getUnionTypes());
    }

    if (type.isIntersection()) {
        children.push(...type.getIntersectionTypes());
    }

    return children;
};

/**
 * An object type whose members we can faithfully reproduce structurally: a plain
 * object/interface with no call/construct signatures and no index signatures
 * (those can't be re-expressed as `{ name: type; … }` without losing meaning).
 */
const isExpandableObject = (type: Type): boolean => {
    if (!type.isObject() || type.isArray() || type.isTuple()) {
        return false;
    }

    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
        return false;
    }

    return type.getStringIndexType() === undefined && type.getNumberIndexType() === undefined;
};

/**
 * Whether any name inside `type` needs renaming before it can go into
 * `_generated/` — i.e. anything in it classifies as other than `verbatim`.
 *
 * Descends type arguments, union/intersection members, **and** object property
 * types — the last so an anonymous object that embeds an unreachable interface
 * (`{ post: PostDoc }`) isn't mistaken for safe.
 */
const referencesUnreachableLocalType = (type: Type, node: Node, handlerFilePath: string, seen = new Set<Type>()): boolean => {
    if (seen.has(type)) {
        return false;
    }

    seen.add(type);

    if (classifyType(type, node, handlerFilePath).kind !== "verbatim") {
        return true;
    }

    if (childTypes(type).some((child) => referencesUnreachableLocalType(child, node, handlerFilePath, seen))) {
        return true;
    }

    if (!isExpandableObject(type)) {
        return false;
    }

    return type.getProperties().some((property) => {
        // The annotation first: it is the syntax the printer reuses, and the
        // resolved type below has already lost the alias by the time we see it.
        if (property.getDeclarations().some((declaration) => annotationRendering(declaration, node, handlerFilePath).kind !== "verbatim")) {
            return true;
        }

        return referencesUnreachableLocalType(property.getTypeAtLocation(node), node, handlerFilePath, seen);
    });
};

/** Is `property` declared optional (`name?: …`)? */
const isOptionalProperty = (property: TsSymbol, propertyType: Type): boolean => {
    const declaration = property.getValueDeclaration() ?? property.getDeclarations()[0];

    if (declaration && (Node.isPropertySignature(declaration) || Node.isPropertyDeclaration(declaration)) && declaration.hasQuestionToken()) {
        return true;
    }

    return propertyType.isUnion() && propertyType.getUnionTypes().some((member) => member.isUndefined());
};

/** Depth ceiling so a pathological nested type can't blow the stack — beyond it we bail to `unknown`. */
const MAX_EXPANSION_DEPTH = 8;

/** Shared type alias for the recursive expand callback passed to branch helpers. */
type ExpandFunction = (type: Type, node: Node, handlerFilePath: string, depth: number, seen: Set<Type>) => string | undefined;

/**
 * Expand an array type; returns `undefined` when the element can't be reproduced.
 * Receives `expand` as a parameter to avoid a forward-reference cycle.
 */
const expandArrayType = (type: Type, node: Node, handlerFilePath: string, depth: number, nextSeen: Set<Type>, expand: ExpandFunction): string | undefined => {
    const element = type.getArrayElementType();
    const rendered = element ? expand(element, node, handlerFilePath, depth, nextSeen) : undefined;

    if (rendered === undefined) {
        return undefined;
    }

    return element?.isUnion() ? `(${rendered})[]` : `${rendered}[]`;
};

/**
 * Expand a union type; returns `undefined` when any member can't be reproduced.
 * Receives `expand` as a parameter to avoid a forward-reference cycle.
 */
const expandUnionType = (type: Type, node: Node, handlerFilePath: string, depth: number, nextSeen: Set<Type>, expand: ExpandFunction): string | undefined => {
    const parts: string[] = [];

    for (const member of type.getUnionTypes()) {
        const rendered = expand(member, node, handlerFilePath, depth, nextSeen);

        if (rendered === undefined) {
            return undefined;
        }

        parts.push(rendered);
    }

    return parts.join(" | ");
};

/**
 * Expand an object type's properties; returns `undefined` when any property can't be reproduced.
 * Receives `expand` as a parameter to avoid a forward-reference cycle.
 */
const expandObjectType = (type: Type, node: Node, handlerFilePath: string, depth: number, nextSeen: Set<Type>, expand: ExpandFunction): string | undefined => {
    if (!isExpandableObject(type)) {
        return undefined;
    }

    const parts: string[] = [];

    for (const property of type.getProperties()) {
        const propertyType = property.getTypeAtLocation(node);
        const optional = isOptionalProperty(property, propertyType);
        // Optionality re-adds `| undefined` to the resolved type; drop it so the
        // emitted property reads `name?: T`, not `name?: T | undefined`.
        const valueMembers = optional && propertyType.isUnion() ? propertyType.getUnionTypes().filter((member) => !member.isUndefined()) : [propertyType];

        const rendered: string[] = [];

        for (const member of valueMembers) {
            const text = expand(member, node, handlerFilePath, depth + 1, nextSeen);

            if (text === undefined) {
                return undefined;
            }

            rendered.push(text);
        }

        parts.push(`${renderExpandedPropertyKey(property.getName())}${optional ? "?" : ""}: ${rendered.join(" | ")}`);
    }

    return parts.length > 0 ? `{ ${parts.join("; ")} }` : "{}";
};

/**
 * An enum-literal member prints as `Status.Done` — the enum's name, bare. What
 * actually crosses the wire is the member's VALUE, so that is both the honest
 * rendering and a nameable one. A member is a string or a number and nothing
 * else; anything else declines, so the caller keeps the `unknown` fallback.
 */
const expandEnumLiteralType = (type: Type): string | undefined => {
    const value = type.getLiteralValue();

    if (typeof value === "string") {
        return JSON.stringify(value);
    }

    return typeof value === "number" ? String(value) : undefined;
};

/** Whether `type` is the INSTANCE type of a user-land `class` declaration. */
const isClassInstance = (type: Type): boolean =>
    [type.getSymbol(), type.getAliasSymbol()]
        .flatMap((candidate) => candidate?.getDeclarations() ?? [])
        .some((declaration) => Node.isClassDeclaration(declaration) || Node.isClassExpression(declaration));

/**
 * Whether `type` reaches a value `encodeWire` refuses — a user-land class
 * instance or anything with a call signature — at any depth.
 *
 * {@link expandUnreachableType} declines a class instance outright, and the
 * reasoning there (a method or a `#private` field is absent from the serialized
 * value, so a `result.format(...)` typed off one is a runtime TypeError with no
 * compile error anywhere) applies just as much when the class is a MEMBER of the
 * type being named. Printing `import("./money").Envelope` publishes
 * `at.format()` to every caller for a value that cannot cross the wire at all —
 * `shared/wire-codec.ts` throws on it at the send site.
 *
 * Keyed on the same script-mode test the global exemption uses, so the built-ins
 * that DO round-trip (`Date`, `URL`, `Map`, `Set`, the typed arrays) are not
 * caught by it — they are declared in `lib.*.d.ts` and are exactly the set
 * `encodeWire` supports.
 *
 * An index signature is deliberately NOT a refusal: a `Record`-shaped return
 * encodes fine, and declining one is the collapse-to-`unknown` this whole path
 * exists to avoid.
 */
const containsUnencodableMember = (type: Type, node: Node, depth: number, seen: Set<Type>): boolean => {
    // Already on the stack: a cycle proves nothing either way, and the frame
    // that put it there is still deciding. Answering "not unencodable" here is
    // correct — it defers, it doesn't clear.
    if (seen.has(type)) {
        return false;
    }

    // Out of depth, though, is a refusal. This is a "can it round-trip?" check,
    // so an unexamined subtree has to count against the type: answering
    // "encodable" cleared everything below the ceiling, and a class nested
    // deeper than it reached `api.ts` verbatim — publishing its methods to
    // clients for a value `encodeWire` then throws on. Refusing collapses the
    // type to `unknown` instead, which is what the ceiling already does on the
    // expansion path and what this constant's docblock always claimed.
    if (depth > MAX_EXPANSION_DEPTH) {
        return true;
    }

    const nextSeen = new Set(seen).add(type);

    // Type arguments and union/intersection members first, so a supported
    // container carrying an unsupported payload (`Map<string, Money>`, an array
    // of them) is still caught — the container encodes, its contents do not.
    if (childTypes(type).some((child) => containsUnencodableMember(child, node, depth + 1, nextSeen))) {
        return true;
    }

    const element = type.getArrayElementType();

    if (element !== undefined) {
        return containsUnencodableMember(element, node, depth + 1, nextSeen);
    }

    // A GLOBAL type is trusted and NOT descended into. The globals a return type
    // realistically names are the built-ins `encodeWire` supports (`Date`, `Map`,
    // `Set`, `URL`, the typed arrays), and every one of them carries prototype
    // methods — walking their members would report `Date` itself as unencodable
    // on the strength of `getTime()`. Same script-mode test as the bare-name
    // exemption uses, for the same reason.
    if (isGloballyDeclared(type)) {
        return false;
    }

    // A function/callable is not a plain object, so `encodeWire` throws on it.
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
        return true;
    }

    const isUserLandClass = [type.getSymbol(), type.getAliasSymbol()]
        .flatMap((candidate) => candidate?.getDeclarations() ?? [])
        .some((declaration) => Node.isClassDeclaration(declaration) || Node.isClassExpression(declaration));

    if (isUserLandClass) {
        return true;
    }

    // Members are walked only for shapes structural expansion would itself walk —
    // which excludes arrays, tuples, and anything carrying call or index
    // signatures, so a prototype method never reaches the callable test above.
    return (
        isExpandableObject(type) &&
        type.getProperties().some((property) => containsUnencodableMember(property.getTypeAtLocation(node), node, depth + 1, nextSeen))
    );
};

/**
 * Render `qualified` as `import("<specifier>").<export><…type arguments>`.
 *
 * Only the bare NAME is unreachable from `_generated/`; the type itself is
 * perfectly nameable, and the handler's own `import` declaration says which
 * module to name it from. Emitting the qualifier keeps the alias intact — a
 * paginated page of `Doc`s stays that, rather than becoming the flattened record
 * structural expansion produces — and keeps a type expansion cannot reproduce at
 * all (an index signature, a call signature, a generic the checker left
 * unresolved) off the `unknown` fallback it would otherwise land on.
 *
 * Type arguments go back through `expand`, so one unreachable argument still
 * decides the outcome for the whole reference.
 */
const qualifiedImportText = (
    qualified: QualifiedImport,
    type: Type,
    node: Node,
    handlerFilePath: string,
    depth: number,
    seen: Set<Type>,
    expand: ExpandFunction,
): string | undefined => {
    const rendered: string[] = [];

    for (const argument of type.getAliasSymbol() === undefined ? type.getTypeArguments() : type.getAliasTypeArguments()) {
        const text = expand(argument, node, handlerFilePath, depth + 1, seen);

        if (text === undefined) {
            return undefined;
        }

        rendered.push(text);
    }

    return `import("${qualified.specifier}").${qualified.exportName}${rendered.length > 0 ? `<${rendered.join(", ")}>` : ""}`;
};

/** Whether `type` is an `enum` or one of its members — the one named type deliberately rendered by VALUE rather than by name. */
const isEnumDeclared = (type: Type): boolean =>
    [type.getSymbol(), type.getAliasSymbol()]
        .flatMap((candidate) => candidate?.getDeclarations() ?? [])
        .some((declaration) => Node.isEnumDeclaration(declaration) || Node.isEnumMember(declaration));

/**
 * Structurally expand a return type that references a non-exported local type,
 * so the generated `FunctionReference` carries the real shape (`PostDoc[]` →
 * `{ _id: Id<"posts">; … }[]`) instead of erasing to `unknown`. Reachable names
 * (`Id`, `Doc`, primitives, library types) are printed verbatim; anything we
 * can't faithfully reproduce — recursion, call/index signatures, exotic types —
 * returns `undefined` so the caller keeps the `unknown` fallback. The result is
 * thus never worse than today, only more precise.
 */
const expandUnreachableType = (type: Type, node: Node, handlerFilePath: string, depth: number, seen: Set<Type>): string | undefined => {
    if (depth > MAX_EXPANSION_DEPTH || seen.has(type)) {
        return undefined;
    }

    const rendering = classifyType(type, node, handlerFilePath);

    // Reachable types already print correctly by name — leave them verbatim. The
    // type's OWN rendering gates the walk rather than the other way round: it is
    // the cheap half, it is implied by the walk anyway, and checking it first
    // means a type that already needs renaming never pays for the recursion.
    if (rendering.kind === "verbatim" && !referencesUnreachableLocalType(type, node, handlerFilePath)) {
        return type.getText(node);
    }

    const nextSeen = new Set(seen).add(type);

    // A CLASS INSTANCE is not reproducible, and expanding it would be worse than
    // declining. Answered before every branch below — including the qualifier —
    // so no path can publish one. `encodeWire` refuses a class instance outright (`shared/wire-codec.ts`
    // — only plain objects and the supported built-ins round-trip), so no such value
    // ever reaches a caller; and the structural expansion would describe one wrongly
    // in three directions at once: methods and getters live on the prototype and are
    // absent from the serialized value, `#private` fields are absent too, and
    // `private`/`protected` members would be published into the client-facing type.
    // A `result.format(...)` typed from a method is then a runtime TypeError with no
    // compile error anywhere. Declining keeps `unknown` — which is the contract this
    // function opens with, and the only answer that is never wrong.
    if (isClassInstance(type)) {
        return undefined;
    }

    // An `enum` is the one named type rendered by VALUE rather than by name. The
    // value is what crosses the wire, and the type is NOMINAL — a caller
    // comparing `result.status === "done"` does not typecheck against `Status`,
    // and a caller without the enum installed cannot name it at all. A single
    // member answers here; a whole enum falls through to the union branch, which
    // expands each member the same way.
    if (type.isEnumLiteral()) {
        return expandEnumLiteralType(type);
    }

    // Nameable, just not BARE-nameable — qualify it with the module the handler
    // imports it from. Ahead of the structural branches because an alias for an
    // array or a union (`type Ids = Id<"x">[]`, `type Status = A | B`) is a
    // reference the checker prints by name, and expanding it loses the alias for
    // no gain — or declines outright on a member it cannot reproduce. Nothing but
    // `discover-functions.test.ts`'s alias-of-array and alias-of-union cases
    // enforces that order.
    if (rendering.kind === "qualify" && !isEnumDeclared(type)) {
        const qualified = qualifiedImportText(rendering.qualified, type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);

        if (qualified !== undefined) {
            return qualified;
        }
    }

    if (type.isArray()) {
        return expandArrayType(type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);
    }

    if (type.isUnion()) {
        return expandUnionType(type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);
    }

    return expandObjectType(type, node, handlerFilePath, depth, nextSeen, expandUnreachableType);
};

export { containsUnencodableMember, expandUnreachableType, referencesUnreachableLocalType };
