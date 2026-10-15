import type {
    CallExpression,
    Identifier,
    Node as TsNode,
    ObjectLiteralElement,
    ObjectLiteralExpression,
    Project,
    PropertyAssignment,
    ShorthandPropertyAssignment,
    Symbol,
    ts,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isArgumentDerived, isScopedByContext } from "../argument-taint";
import type { VectorNamespaceAccessIR } from "../ir";
import { collectCallRows } from "./ast";
import { callSiteScopeOf } from "./attribution";
import { isContextSurface } from "./context-root";

/**
 * The `ctx.vectors` methods whose second argument may carry a `namespace`
 * field — confirmed against the facade `createContextVectors` builds in
 * `@lunora/bindings/vectors`, which is what `ctx.vectors` is. `query`,
 * `upsert` and `upsertNow` each take a single `{ namespace, … }` input object;
 * `upsertMany` takes an array of them.
 */
const VECTOR_NAMESPACE_METHODS = new Set(["query", "upsert", "upsertMany", "upsertNow"]);

/** Symbols of the `.map` callback parameter bindings whose source array is argument-derived: each is as tainted as that array. */
type ParameterSymbols = ReadonlySet<ts.Symbol>;

const NO_PARAMETERS: ParameterSymbols = new Set();

/** A record's `namespace` source plus the callback parameters tainted where it was found. */
interface Candidate {
    node: TsNode;
    parameters: ParameterSymbols;
}

/**
 * The `ctx.vectors.<method>` namespace-taking method invoked by `node`, or
 * `undefined` when `node` is not a `ctx.vectors` call. Matched by shape (a
 * property access whose name is a namespace-taking method and whose receiver
 * text is exactly `ctx.vectors`) — the same `import`-agnostic, fail-closed
 * convention the other feeders use, so a re-export or alias still resolves.
 */
const vectorsNamespaceMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    if (!VECTOR_NAMESPACE_METHODS.has(method)) {
        return undefined;
    }

    return isContextSurface(node.getExpression(), ["vectors"]) ? method : undefined;
};

/** Strip value-preserving wrappers: parentheses, `as`, `satisfies`, `!` and `<T>` assertions. */
const unwrap = (node: TsNode): TsNode => {
    let current = node;

    while (
        Node.isParenthesizedExpression(current) ||
        Node.isAsExpression(current) ||
        Node.isSatisfiesExpression(current) ||
        Node.isNonNullExpression(current) ||
        Node.isTypeAssertion(current)
    ) {
        current = current.getExpression();
    }

    return current;
};

/** The symbol an identifier READS: for a shorthand `{ x }` that is the variable, not the property. */
const valueSymbolOf = (identifier: Identifier): Symbol | undefined => {
    const parent = identifier.getParent();

    if (Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === identifier) {
        return parent.getValueSymbol();
    }

    return identifier.getSymbol();
};

/** The declaration an identifier resolves to, by symbol (never by spelling). */
const declarationOf = (identifier: Identifier): TsNode | undefined => valueSymbolOf(identifier)?.getDeclarations()[0];

/**
 * Whether `identifier` is a value-position reference. Property keys, member
 * names after a `.`, and binding names merely share a spelling with a variable.
 */
const isValueReference = (identifier: Identifier): boolean => {
    const parent = identifier.getParent();

    if (Node.isBindingElement(parent)) {
        return false;
    }

    if (
        (Node.isPropertyAccessExpression(parent) ||
            Node.isPropertyAssignment(parent) ||
            Node.isVariableDeclaration(parent) ||
            Node.isParameterDeclaration(parent) ||
            Node.isMethodDeclaration(parent)) &&
        parent.getNameNode() === identifier
    ) {
        return false;
    }

    return !Node.isQualifiedName(parent) || parent.getLeft() === identifier;
};

/** The `VariableDeclaration` a declaration belongs to, walking out of destructuring patterns only (never out of a function). */
const enclosingVariable = (declaration: TsNode | undefined): TsNode | undefined => {
    let current = declaration;

    while (current !== undefined && (Node.isBindingElement(current) || Node.isObjectBindingPattern(current) || Node.isArrayBindingPattern(current))) {
        current = current.getParent();
    }

    return current !== undefined && Node.isVariableDeclaration(current) ? current : undefined;
};

/**
 * Whether `identifier` carries a tainted value. It resolves BY SYMBOL: a tracked
 * `.map` callback parameter is tainted; a variable (including a destructured
 * binding) is tainted when its own declaration's initializer is, with `hops`
 * bounding how many initializers are followed; anything else (the handler's
 * `args`, positional parameters) falls back to the shared taint predicate.
 */
const identifierTainted = (identifier: Identifier, parameters: ParameterSymbols, hops: number): boolean => {
    const symbol = valueSymbolOf(identifier)?.compilerSymbol;

    if (symbol !== undefined && parameters.has(symbol)) {
        return true;
    }

    if (hops > 0) {
        const variable = enclosingVariable(declarationOf(identifier));
        const initializer = variable !== undefined && Node.isVariableDeclaration(variable) ? variable.getInitializer() : undefined;

        if (initializer !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion with expressionTainted
            return expressionTainted(initializer, parameters, hops - 1);
        }
    }

    return isArgumentDerived(identifier);
};

/**
 * Argument-derived (or reading a tainted callback parameter) and NOT scoped by a
 * server-trusted `ctx.*` value — a namespace like `` `${ctx.auth.orgId}` ``
 * references `ctx` and is treated as scoped, so it is not flagged.
 */
const expressionTainted = (expression: TsNode, parameters: ParameterSymbols, hops: number): boolean => {
    const node = unwrap(expression);

    if (isScopedByContext(node)) {
        return false;
    }

    if (Node.isIdentifier(node)) {
        return identifierTainted(node, parameters, hops);
    }

    if (isArgumentDerived(node)) {
        return true;
    }

    return node
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((identifier) => isValueReference(identifier) && identifierTainted(identifier, parameters, hops));
};

/** The initializer of the variable an identifier resolves to, by symbol. */
const initializerOf = (identifier: Identifier): TsNode | undefined => {
    const variable = enclosingVariable(declarationOf(identifier));

    return variable !== undefined && Node.isVariableDeclaration(variable) ? variable.getInitializer() : undefined;
};

/**
 * The object literals a record expression may evaluate to: the literal itself, both
 * branches of a conditional (or `||` / `??` / `&&`), or an identifier followed ONE
 * hop to its initializer.
 */
const recordsOf = (expression: TsNode, canHop: boolean): ObjectLiteralExpression[] => {
    const node = unwrap(expression);

    if (Node.isObjectLiteralExpression(node)) {
        return [node];
    }

    if (Node.isConditionalExpression(node)) {
        return [...recordsOf(node.getWhenTrue(), canHop), ...recordsOf(node.getWhenFalse(), canHop)];
    }

    if (Node.isBinaryExpression(node)) {
        const operator = node.getOperatorToken().getKind();

        if (operator === SyntaxKind.BarBarToken || operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.AmpersandAmpersandToken) {
            return [...recordsOf(node.getLeft(), canHop), ...recordsOf(node.getRight(), canHop)];
        }
    }

    if (Node.isIdentifier(node) && canHop) {
        const initializer = initializerOf(node);

        return initializer === undefined ? [] : recordsOf(initializer, false);
    }

    return [];
};

/**
 * How an object spread affects the `namespace` candidates before it: the sources
 * it contributes, and whether they replace them. `undefined` when the spread
 * provably carries no `namespace` (so the earlier candidates survive). A spread
 * that resolves to records all carrying a `namespace` replaces them; only some
 * carrying one leaves the earlier candidates possibly effective.
 */
const spreadEffect = (spread: TsNode, canHop: boolean): { replaces: boolean; sources: TsNode[] } | undefined => {
    const resolved = recordsOf(spread, canHop);

    // Unreadable: it may overwrite the namespace with anything.
    if (resolved.length === 0) {
        return { replaces: true, sources: [spread] };
    }

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion with namespaceSources
    const perRecord = resolved.map((literal) => namespaceSources(literal, false));
    const sources = perRecord.flat();

    if (sources.length === 0) {
        return undefined;
    }

    return { replaces: perRecord.every((inner) => inner.length > 0), sources };
};

/** True when `property` supplies the `namespace` field, as `namespace: …` or a `{ namespace }` shorthand. */
const isNamespaceProperty = (property: ObjectLiteralElement): property is PropertyAssignment | ShorthandPropertyAssignment =>
    (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)) && property.getName() === "namespace";

/** The expression an explicit `namespace: …` supplies; a shorthand `{ namespace }` supplies its name. */
const explicitNamespaceValue = (property: PropertyAssignment | ShorthandPropertyAssignment): TsNode =>
    Node.isShorthandPropertyAssignment(property) ? property.getNameNode() : (property.getInitializer() ?? property.getNameNode());

/**
 * The expressions that may supply a record's `namespace`, walked in runtime
 * assignment order so a later property wins: an explicit `namespace` (or a
 * shorthand) replaces every candidate before it, and a spread replaces them when
 * every record it resolves to carries a `namespace` — while a spread with no
 * `namespace` leaves the earlier candidates effective. An opaque spread stays as
 * a possible source, since it may carry anything.
 */
const namespaceSources = (record: ObjectLiteralExpression, canHop: boolean): TsNode[] => {
    let sources: TsNode[] = [];

    for (const property of record.getProperties()) {
        if (Node.isSpreadAssignment(property)) {
            const effect = spreadEffect(property.getExpression(), canHop);

            if (effect !== undefined) {
                sources = effect.replaces ? effect.sources : [...sources, ...effect.sources];
            }
        } else if (isNamespaceProperty(property)) {
            sources = [explicitNamespaceValue(property)];
        }
    }

    return sources;
};

/** The record expressions a `.map` callback returns: an arrow expression body, or the `return`s of its own block body. */
const mapCallbackReturns = (callback: TsNode | undefined): TsNode[] => {
    if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) {
        return [];
    }

    const body = callback.getBody();

    if (!Node.isBlock(body)) {
        return [body];
    }

    return body
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((statement) => statement.getFirstAncestor((ancestor) => Node.isFunctionLikeDeclaration(ancestor)) === callback)
        .flatMap((statement) => statement.getExpression() ?? []);
};

/** Symbols of the identifiers the callback's first parameter binds: itself, or each name of a destructuring pattern. */
const parameterSymbolsOf = (callback: TsNode | undefined): ParameterSymbols => {
    if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) {
        return NO_PARAMETERS;
    }

    const name = callback.getParameters()[0]?.getNameNode();

    if (name === undefined) {
        return NO_PARAMETERS;
    }

    const identifiers = Node.isIdentifier(name) ? [name] : name.getDescendantsOfKind(SyntaxKind.BindingElement).map((element) => element.getNameNode());

    return new Set(identifiers.flatMap((identifier) => (Node.isIdentifier(identifier) ? (identifier.getSymbol()?.compilerSymbol ?? []) : [])));
};

/**
 * The `namespace` sources of the records an `upsertMany` second argument holds,
 * traced statically: an array literal (spread elements followed), a `.map(...)`
 * call (the callback's returned records), or an identifier bound by ONE local
 * hop to either.
 */
const upsertManyCandidates = (input: TsNode, canHop = true, parameters: ParameterSymbols = NO_PARAMETERS): Candidate[] => {
    const node = unwrap(input);

    if (Node.isIdentifier(node)) {
        const initializer = canHop ? initializerOf(node) : undefined;

        // An identifier we cannot follow to a local initializer may still BE the
        // caller's records array, so hand it to the taint check rather than drop it.
        return initializer === undefined ? [{ node, parameters }] : upsertManyCandidates(initializer, false, parameters);
    }

    if (Node.isArrayLiteralExpression(node)) {
        return node.getElements().flatMap((element) =>
            Node.isSpreadElement(element)
                ? upsertManyCandidates(element.getExpression(), canHop, parameters)
                : recordsOf(element, true).flatMap((record) =>
                      namespaceSources(record, true).map((source) => {
                          return { node: source, parameters };
                      }),
                  ),
        );
    }

    const callee = Node.isCallExpression(node) ? node.getExpression() : undefined;

    if (Node.isCallExpression(node) && Node.isPropertyAccessExpression(callee) && callee.getName() === "map") {
        const callback = node.getArguments()[0];

        // A callback parameter is as tainted as the array it iterates over.
        const tainted = expressionTainted(callee.getExpression(), NO_PARAMETERS, 1) ? parameterSymbolsOf(callback) : NO_PARAMETERS;

        return mapCallbackReturns(callback).flatMap((returned) =>
            recordsOf(returned, true).flatMap((record) =>
                namespaceSources(record, true).map((source) => {
                    return { node: source, parameters: tainted };
                }),
            ),
        );
    }

    // Anything else (a call result, a property access, a conditional, …) is opaque:
    // it may be the caller's records, so let the taint check decide.
    return [{ node, parameters }];
};

/** The IR row for a `ctx.vectors.<method>(indexName, input)` call whose `input.namespace` is arg-derived and unscoped, or `undefined`. */
const vectorNamespaceAccessInCall = (call: CallExpression, relativePath: string): VectorNamespaceAccessIR | undefined => {
    const method = vectorsNamespaceMethod(call.getExpression());

    if (method === undefined) {
        return undefined;
    }

    const input = call.getArguments()[1];

    if (!input) {
        return undefined;
    }

    // `upsertMany` takes an array of records: every record's namespace sources are checked.
    const candidates: Candidate[] =
        method === "upsertMany"
            ? upsertManyCandidates(input)
            : recordsOf(input, true).flatMap((record) =>
                  namespaceSources(record, true).map((source) => {
                      return { node: source, parameters: NO_PARAMETERS };
                  }),
              );

    if (!candidates.some(({ node, parameters }) => expressionTainted(node, parameters, 1))) {
        return undefined;
    }

    return { scope: callSiteScopeOf(call), file: relativePath, line: call.getStartLineNumber(), method };
};

/**
 * Discover `ctx.vectors.<method>(indexName, input)` calls in `lunora/` whose
 * `input.namespace` is derived from the handler's `args` with no server-side
 * scoping — the `vectors_namespace_from_user_input` lint input. A Vectorize
 * namespace partitions one index into isolated sub-collections, so a namespace
 * taken straight from request input lets any caller read or poison another
 * tenant's vectors. A fixed literal namespace, one prefixed with a
 * server-trusted identity (`` `${ctx.auth.orgId}` `` — references `ctx`, so
 * treated as scoped), or a call whose argument isn't a statically recognisable
 * record, is not recorded; only an arg-derived, unscoped `namespace` reaches here.
 *
 * Identifiers are resolved through the type checker's symbols, never by
 * spelling, so a shadowing declaration in either direction is read correctly.
 * Traced: an object literal (through parentheses, `as`, `satisfies`, `!` and
 * `<T>` wrappers); both branches of a conditional or `||` / `??` / `&&`; a
 * shorthand `{ namespace }`; an identifier or array/`.map` bound by one local
 * variable hop; array spreads; object spreads that resolve to a literal in one
 * hop; an opaque arg-derived object spread (flagged unless scoped by context);
 * and a `.map` callback's parameter (also destructured) or local alias when the
 * mapped array is itself argument-derived.
 *
 * NOT traced, so the lint fails open on them: values produced by a helper call
 * (`buildRecords(args)`), computed keys (`{ ["namespace"]: … }`), values
 * imported from another file, records built by mutation after creation
 * (`record.namespace = …`), and a chain longer than one variable hop.
 */
const discoverVectorNamespaceAccesses = (project: Project, lunoraDirectory: string): VectorNamespaceAccessIR[] =>
    collectCallRows(project, lunoraDirectory, vectorNamespaceAccessInCall);

export default discoverVectorNamespaceAccesses;
