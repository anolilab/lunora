import type { CallExpression, Identifier, Node as TsNode, ObjectLiteralExpression, ParameterDeclaration, Project, ts, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isArgumentDerived, isScopedByContext } from "../argument-taint";
import type { CallSiteScope, FunctionIR, MutatorIR, OwnerFieldWriteIR } from "../ir";
import { bindingKeyName, collectCallRows, isConstDeclaration, isWriteTarget, outermostValueWrapper, propertyKeyName, unwrapExpression } from "./ast";
import { callSiteScopeOf, declarationOf, withCallerVisibility } from "./attribution";
import type { MutatorServerImpl } from "./mutators";
import { mutatorServerImplOf } from "./mutators";

/**
 * Ownership / identity columns whose value must come from the server-trusted
 * identity (`ctx.auth` / `ctx.identity`), never from request input. Writing one
 * of these from `args` lets a caller act as another user or tenant — a
 * cross-tenant IDOR. Kept deliberately tight to identity / tenancy columns (not
 * arbitrary foreign keys the caller may legitimately choose) to hold the
 * false-positive rate down; the members are the identity-ish columns that
 * actually appear in the repo's example schemas.
 */
const IDENTITY_FIELDS = new Set<string>([
    "accountId",
    "authorId",
    "createdBy",
    "createdById",
    "organizationId",
    "orgId",
    "ownerId",
    "tenantId",
    "updatedBy",
    "userId",
    "workspaceId",
]);

/**
 * `ctx.db` write surfaces whose document / partial (the object whose identity
 * columns this feeder inspects) is the SECOND argument: `insert(table, doc)`,
 * `replace(id, doc)`, `patch(id, partial)`, and `insertManyUnsafe(table, rows)`
 * (`rows` an array of documents). The document argument is always `arg[1]`.
 */
const IDENTITY_WRITE_METHODS = new Set<string>(["insert", "insertManyUnsafe", "patch", "replace"]);

/**
 * When `node` is a `ctx.db.<method>` member access for one of the
 * {@link IDENTITY_WRITE_METHODS}, return the method name; otherwise `undefined`.
 * Matched by shape (a member chain rooted at `ctx.db`), the same import-agnostic,
 * fail-closed convention the other feeders use, so a re-export or alias still resolves.
 */
const contextDatabaseWriteMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    if (!IDENTITY_WRITE_METHODS.has(method)) {
        return undefined;
    }

    const database = node.getExpression();

    if (!Node.isPropertyAccessExpression(database) || database.getName() !== "db") {
        return undefined;
    }

    const context = database.getExpression();

    return Node.isIdentifier(context) && context.getText() === "ctx" ? method : undefined;
};

/**
 * The object literals whose identity columns a write's document argument
 * contributes: the argument itself for the single-document writes, and each
 * array element for `insertManyUnsafe`'s row list.
 */
const documentObjectLiterals = (documentArgument: TsNode, method: string): ObjectLiteralExpression[] => {
    if (method !== "insertManyUnsafe") {
        return Node.isObjectLiteralExpression(documentArgument) ? [documentArgument] : [];
    }

    if (!Node.isArrayLiteralExpression(documentArgument)) {
        return [];
    }

    const objectLiterals: ObjectLiteralExpression[] = [];

    for (const element of documentArgument.getElements()) {
        if (Node.isObjectLiteralExpression(element)) {
            objectLiterals.push(element);
        }
    }

    return objectLiterals;
};

/**
 * The mutator `server` impl `call` runs in, plus its own `args` parameter.
 * `pristine` says whether that parameter is still exactly the object
 * `applyOwnerScope` verified (see {@link isPristineArgsParameter}).
 */
interface MutatorImplScope {
    impl: MutatorServerImpl;
    parameter: ParameterDeclaration | undefined;
    pristine: boolean;
}

/** Per-impl {@link isPristineArgsParameter} verdicts, keyed on the compiler node so a re-parse recomputes. */
const PRISTINE_CACHE = new WeakMap<ts.Node, boolean>();

/** Whether `node` is the operand of a plain member READ: `x.k`, `x?.k`, `x[k]`, seen through wrappers, and not written. */
const isMemberRead = (node: TsNode): boolean => {
    const value = outermostValueWrapper(node);
    const access = value.getParent();

    return (Node.isPropertyAccessExpression(access) || Node.isElementAccessExpression(access)) && access.getExpression() === value && !isWriteTarget(access);
};

/** Whether `node` is the initializer of a destructuring declaration (`const { a } = node`), which only reads members. */
const isDestructuringRead = (node: TsNode): boolean => {
    // With a binding-pattern name, the only expression child a declaration has is its initializer.
    const declaration = outermostValueWrapper(node).getParent();

    return Node.isVariableDeclaration(declaration) && Node.isObjectBindingPattern(declaration.getNameNode());
};

/**
 * Whether the impl's `args` parameter is still exactly the object
 * `applyOwnerScope` verified, for every read of it in the impl. Fails closed:
 *
 * - `arguments` anywhere in the impl reaches the parameter without naming it;
 * - a `var` redeclaration of a parameter binding is a second declaration of it;
 * - an `args` parameter used as anything but a plain member read (or a
 * destructuring initializer) — written through, passed to a call
 * (`fix(args)`, `Object.assign(args, …)`), aliased (`const a = args`),
 * spread — may be changed where this cannot see;
 * - a destructured binding of the parameter that is written (`userId = …`).
 */
const isPristineArgsParameter = (impl: MutatorServerImpl, parameter: ParameterDeclaration): boolean => {
    const cached = PRISTINE_CACHE.get(impl.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const nameNode = parameter.getNameNode();
    const bindings = Node.isIdentifier(nameNode)
        ? [nameNode]
        : nameNode.getDescendantsOfKind(SyntaxKind.BindingElement).flatMap((element) => {
              const name = element.getNameNode();

              return Node.isIdentifier(name) ? [name] : [];
          });
    const declarationByName = new Map(bindings.map((binding) => [binding.getText(), binding.getParentOrThrow().compilerNode]));
    const pristine =
        bindings.every((binding) => (binding.getSymbol()?.getDeclarations().length ?? 0) === 1) &&
        impl.getDescendantsOfKind(SyntaxKind.Identifier).every((identifier) => {
            const name = identifier.getText();

            if (name === "arguments") {
                return false;
            }

            const declaration = declarationByName.get(name);

            if (declaration === undefined || bindings.includes(identifier) || declarationOf(identifier)?.compilerNode !== declaration) {
                return true;
            }

            return Node.isIdentifier(nameNode) ? isMemberRead(identifier) || isDestructuringRead(identifier) : !isWriteTarget(identifier);
        });

    PRISTINE_CACHE.set(impl.compilerNode, pristine);

    return pristine;
};

/**
 * The {@link MutatorImplScope} of `call`, resolved DOWN from the top-level
 * declaration `call` sits in to that declaration's own `server` impl (see
 * {@link mutatorServerImplOf}); `undefined` when the call is not inside it.
 * Never matched by name on an ancestor: a nested `const save = defineMutator(…)`
 * inside the exported `save` resolves to the export's impl, in which the nested
 * mutator's `args` is just a nested function's parameter.
 */
const mutatorImplScopeOf = (call: CallExpression): MutatorImplScope | undefined => {
    const statement = call.getAncestors().at(-2);
    const declaration = Node.isVariableStatement(statement)
        ? statement.getDeclarations().find((candidate) => candidate.getPos() <= call.getPos() && call.getEnd() <= candidate.getEnd())
        : undefined;
    const impl = declaration === undefined ? undefined : mutatorServerImplOf(declaration);

    if (impl === undefined || call.getPos() < impl.getPos() || impl.getEnd() < call.getEnd()) {
        return undefined;
    }

    const candidate = impl.getParameters()[1];
    const parameter = candidate === undefined || candidate.isRestParameter() ? undefined : candidate;

    return { impl, parameter, pristine: parameter !== undefined && isPristineArgsParameter(impl, parameter) };
};

/** The parameter `declaration` binds: the parameter itself, or the one whose destructuring pattern holds it. */
const parameterOf = (declaration: TsNode | undefined): ParameterDeclaration | undefined => {
    if (Node.isParameterDeclaration(declaration)) {
        return declaration;
    }

    return Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.Parameter) : undefined;
};

/** Whether `identifier` names a value, not a property: the `k` of `x.k` and of `{ k: v }` names a property. */
const isValueIdentifier = (identifier: Identifier): boolean => {
    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    return !((Node.isPropertyAssignment(parent) || Node.isMethodDeclaration(parent)) && parent.getNameNode() === identifier);
};

/**
 * Methods that call their callback with the elements, or the settled value, of
 * their RECEIVER, plus their other arguments (`reduce`'s seed). Only for these
 * does a callback's taint come from the receiver; any other callee — a static
 * or namespace function (`Array.from(list, cb)`, `_.map(list, cb)`), `.call` —
 * fails closed.
 */
const RECEIVER_ITERATING_METHODS = new Set<string>([
    "catch",
    "every",
    "filter",
    "finally",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "flatMap",
    "forEach",
    "map",
    "reduce",
    "reduceRight",
    "some",
    "sort",
    "then",
]);

/** How many variable hops (`const a = b; const b = c`) taint is followed through before failing closed. */
const MAX_VARIABLE_HOPS = 8;

/**
 * How taint flows inside one mutator impl, resolved by symbol. Caller-controlled
 * are the impl's own `args` parameter, the `arguments` object, any identifier
 * spelled `args` that is not a nested parameter cleared below, and what derives
 * from them through variables (followed up to {@link MAX_VARIABLE_HOPS}; a
 * `let` that is reassigned, a variable with no initializer, a `catch` binding,
 * or running out of hops fails closed). A `for…of` / `for…in` variable takes
 * the taint of what it iterates.
 *
 * A parameter of a function NESTED in the impl is caller-controlled only when
 * what flows into it is. A function called by name (`const persist = …;
 * persist(x)`, a nested `function`, an IIFE) takes taint from the argument at
 * that position at ANY call site; past a spread argument, from every later
 * argument. A function with no visible call site, or one also used as a value
 * (passed on, returned, stored, `.call`ed), fails closed. A callback takes
 * taint from its receiver and the call's other arguments, but only for a
 * {@link RECEIVER_ITERATING_METHODS} method; anything else fails closed. A
 * default, of the parameter or of any element of its destructuring, is
 * followed too.
 *
 * Each verdict is computed once. Recursion resolves to the least fixed point:
 * a cycle adds no taint of its own, and a verdict that depended on a cut cycle
 * (or on the hop bound) is not cached.
 */
class ImplTaint {
    private readonly argsParameter: ParameterDeclaration | undefined;

    private readonly contextParameter: ParameterDeclaration | undefined;

    private cuts = 0;

    private readonly impl: MutatorServerImpl;

    private readonly inProgress = new Set<ts.Node>();

    private readonly referencesByName = new Map<string, Identifier[]>();

    private variableDepth = 0;

    private readonly verdicts = new Map<ts.Node, boolean>();

    public constructor(scope: MutatorImplScope) {
        this.impl = scope.impl;
        this.argsParameter = scope.parameter;
        [this.contextParameter] = scope.impl.getParameters();

        for (const identifier of scope.impl.getDescendantsOfKind(SyntaxKind.Identifier)) {
            const name = identifier.getText();

            this.referencesByName.set(name, [...(this.referencesByName.get(name) ?? []), identifier]);
        }
    }

    /**
     * Whether `value` is caller-controlled. With `rootedInContext`, a value whose
     * member / call chain is rooted in the impl's own `ctx` parameter (rows read
     * through `ctx.db`) counts as server-scoped.
     */
    public isTaintedValue(value: TsNode, rootedInContext: boolean): boolean {
        if (rootedInContext && this.isRootedInContext(value, MAX_VARIABLE_HOPS)) {
            return false;
        }

        const identifiers = Node.isIdentifier(value) ? [value] : value.getDescendantsOfKind(SyntaxKind.Identifier);

        return identifiers.some((identifier) => isValueIdentifier(identifier) && this.isIdentifierTainted(identifier));
    }

    private flowsIntoTainted(parameter: ParameterDeclaration): boolean {
        const defaults = [parameter.getInitializer(), ...parameter.getDescendantsOfKind(SyntaxKind.BindingElement).map((element) => element.getInitializer())];

        if (defaults.some((value) => value !== undefined && this.isTaintedValue(value, false))) {
            return true;
        }

        const nestedFunction = parameter.getParentOrThrow();
        const index = Node.isFunctionLikeDeclaration(nestedFunction)
            ? nestedFunction.getParameters().findIndex((candidate) => candidate.compilerNode === parameter.compilerNode)
            : -1;
        const value = outermostValueWrapper(nestedFunction);
        const holder = value.getParent();

        if (index === -1) {
            return true;
        }

        if (Node.isCallExpression(holder)) {
            // An IIFE is a direct call; anything else receives the function as a callback.
            if (holder.getExpression() === value) {
                return this.isCallSiteTainted(holder, index, parameter.isRestParameter());
            }

            const callee = unwrapExpression(holder.getExpression());

            if (!Node.isPropertyAccessExpression(callee) || !RECEIVER_ITERATING_METHODS.has(callee.getName())) {
                return true;
            }

            const others = holder.getArguments().filter((argument) => argument !== value);

            return this.isTaintedValue(callee.getExpression(), true) || others.some((argument) => this.isTaintedValue(argument, false));
        }

        const binding = Node.isVariableDeclaration(holder) && isConstDeclaration(holder) ? holder : undefined;
        const declaration = Node.isFunctionDeclaration(nestedFunction) ? nestedFunction : binding;
        const nameNode = declaration?.getNameNode();

        if (declaration === undefined || !Node.isIdentifier(nameNode)) {
            return true;
        }

        const references = this.referencesTo(declaration, nameNode.getText());

        return (
            references.length === 0 ||
            references.some((reference) => {
                const callee = outermostValueWrapper(reference);
                const call = callee.getParent();

                return !Node.isCallExpression(call) || call.getExpression() !== callee || this.isCallSiteTainted(call, index, parameter.isRestParameter());
            })
        );
    }

    private isCallSiteTainted(call: CallExpression, index: number, isRest: boolean): boolean {
        const callArguments = call.getArguments();
        const firstSpread = callArguments.findIndex((argument) => Node.isSpreadElement(argument));
        // Past a spread, any later argument may land on any later parameter.
        const reaches = (position: number): boolean =>
            position === index || (isRest && position > index) || (firstSpread !== -1 && firstSpread <= index && position >= firstSpread);

        return callArguments.some((argument, position) => reaches(position) && this.isTaintedValue(argument, false));
    }

    private isIdentifierTainted(identifier: Identifier): boolean {
        const name = identifier.getText();

        if (name === "arguments") {
            return true;
        }

        const declaration = declarationOf(identifier);
        const parameter = parameterOf(declaration);

        if (parameter !== undefined) {
            return this.isSource(parameter);
        }

        // An `args` that is not, by symbol, a parameter cleared above stays tainted by its spelling.
        if (name === "args") {
            return true;
        }

        if (declaration === undefined || !this.isInImpl(declaration)) {
            return false;
        }

        const variable = Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration) : declaration;

        return Node.isVariableDeclaration(variable) && this.isVariableTainted(variable, name);
    }

    private isInImpl(node: TsNode): boolean {
        return node !== this.impl && this.impl.getPos() <= node.getPos() && node.getEnd() <= this.impl.getEnd();
    }

    /** Whether `value`'s member / call chain is rooted, by symbol, in the impl's `ctx` parameter (directly or through `const`s). */
    private isRootedInContext(value: TsNode, hops: number): boolean {
        let current: TsNode | undefined = unwrapExpression(value);

        while (
            Node.isAwaitExpression(current) ||
            Node.isPropertyAccessExpression(current) ||
            Node.isElementAccessExpression(current) ||
            Node.isCallExpression(current)
        ) {
            current = unwrapExpression(current.getExpression());
        }

        if (!Node.isIdentifier(current)) {
            return false;
        }

        const declaration = declarationOf(current);
        const context = this.contextParameter;

        if (context !== undefined && Node.isIdentifier(context.getNameNode()) && declaration?.compilerNode === context.compilerNode) {
            return true;
        }

        const initializer = isConstDeclaration(declaration) && Node.isIdentifier(declaration.getNameNode()) ? declaration.getInitializer() : undefined;

        return hops > 0 && initializer !== undefined && this.isRootedInContext(initializer, hops - 1);
    }

    private isSource(parameter: ParameterDeclaration): boolean {
        if (parameter.compilerNode === this.argsParameter?.compilerNode) {
            return true;
        }

        return parameter.getParent() !== this.impl && this.isInImpl(parameter) && this.memoized(parameter.compilerNode, () => this.flowsIntoTainted(parameter));
    }

    private isVariableTainted(variable: VariableDeclaration, name: string): boolean {
        return this.memoized(variable.compilerNode, () => {
            const holder = variable.getParent().getParent();

            if (Node.isCatchClause(variable.getParent())) {
                return true;
            }

            if (Node.isForOfStatement(holder) || Node.isForInStatement(holder)) {
                return this.isTaintedValue(holder.getExpression(), true);
            }

            const initializer = variable.getInitializer();

            if (
                initializer === undefined ||
                (!isConstDeclaration(variable) && this.referencesTo(variable, name).some((reference) => isWriteTarget(reference)))
            ) {
                return true;
            }

            if (this.variableDepth >= MAX_VARIABLE_HOPS) {
                this.cuts += 1;

                return true;
            }

            this.variableDepth += 1;

            try {
                return this.isTaintedValue(initializer, false);
            } finally {
                this.variableDepth -= 1;
            }
        });
    }

    private memoized(key: ts.Node, compute: () => boolean): boolean {
        const known = this.verdicts.get(key);

        if (known !== undefined) {
            return known;
        }

        if (this.inProgress.has(key)) {
            this.cuts += 1;

            return false;
        }

        const cutsBefore = this.cuts;

        this.inProgress.add(key);

        const verdict = compute();

        this.inProgress.delete(key);

        if (this.cuts === cutsBefore) {
            this.verdicts.set(key, verdict);
        }

        return verdict;
    }

    private referencesTo(declaration: TsNode, name: string): Identifier[] {
        return (this.referencesByName.get(name) ?? []).filter(
            (reference) => reference.getParent() !== declaration && declarationOf(reference)?.compilerNode === declaration.compilerNode,
        );
    }
}

/** One {@link ImplTaint} per impl, keyed on the compiler node so a re-parse rebuilds it. */
const IMPL_TAINT_CACHE = new WeakMap<ts.Node, ImplTaint>();

/** The {@link ImplTaint} of `scope`'s impl, built once. */
const implTaintOf = (scope: MutatorImplScope): ImplTaint => {
    const cached = IMPL_TAINT_CACHE.get(scope.impl.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const taint = new ImplTaint(scope);

    IMPL_TAINT_CACHE.set(scope.impl.compilerNode, taint);

    return taint;
};

/** The object `node` reads `field` from (`<object>.<field>`, `<object>?.<field>`, `<object>["<field>"]`), unwrapped; else `undefined`. */
const ownerPropertyObject = (node: TsNode, field: string): TsNode | undefined => {
    if (Node.isPropertyAccessExpression(node)) {
        return node.getName() === field ? unwrapExpression(node.getExpression()) : undefined;
    }

    if (Node.isElementAccessExpression(node)) {
        const argument = node.getArgumentExpression();

        return argument !== undefined && Node.isStringLiteral(argument) && argument.getLiteralValue() === field
            ? unwrapExpression(node.getExpression())
            : undefined;
    }

    return undefined;
};

/** Whether `node` is an identifier resolving, by symbol, to `parameter` itself. */
const isParameterReference = (node: TsNode | undefined, parameter: ParameterDeclaration): boolean =>
    Node.isIdentifier(node) && declarationOf(node)?.compilerNode === parameter.compilerNode;

/**
 * Whether `value` resolves to the verified `args[owner]` of a PRISTINE impl
 * parameter `parameter`: `args.<owner>` / `args?.<owner>` / `args["<owner>"]`,
 * the `<owner>` element of the destructured parameter (`(ctx, { userId })`) or
 * of a `const` destructure of it (`const { userId } = args`) — directly or
 * through one `const` alias. `applyOwnerScope` stamps the parsed args BEFORE
 * `server(context, args)` runs, so each of these reads the stamped value.
 *
 * Every identifier is resolved by SYMBOL: a nested closure's own `args`, a
 * shadowing `for` / `catch` / block binding, or anything else merely spelled
 * `args` resolves elsewhere. The column NAME matching `owner` is not enough
 * either: `{ userId: args.targetUserId }` is a genuine act-as-any-user IDOR. A
 * `let` destructure or alias, a nested destructuring, or a rest element falls
 * through as NOT owner-scoped, which fails toward reporting.
 */
const resolvesToOwnerArgument = (value: TsNode, parameter: ParameterDeclaration, ownerField: string, hops = 1): boolean => {
    const object = ownerPropertyObject(value, ownerField);

    if (object !== undefined) {
        return isParameterReference(object, parameter);
    }

    const declaration = Node.isIdentifier(value) ? declarationOf(value) : undefined;

    if (Node.isBindingElement(declaration)) {
        const pattern = declaration.getParent();
        const holder = pattern.getParent();
        const isOwnerElement =
            declaration.getDotDotDotToken() === undefined && bindingKeyName(declaration) === ownerField && Node.isObjectBindingPattern(pattern);

        return (
            isOwnerElement &&
            (holder.compilerNode === parameter.compilerNode ||
                (isConstDeclaration(holder) && isParameterReference(unwrapExpression(holder.getInitializer()), parameter)))
        );
    }

    const initializer = isConstDeclaration(declaration) ? declaration.getInitializer() : undefined;

    return hops > 0 && initializer !== undefined && resolvesToOwnerArgument(initializer, parameter, ownerField, hops - 1);
};

/** Identity columns in one object literal that are written from `args` and not from `ctx`. */
const identityWritesInObjectLiteral = (
    objectLiteral: ObjectLiteralExpression,
    write: { call: CallExpression; method: string; ownerField: string | undefined; relativePath: string; scope: CallSiteScope },
    implScope: MutatorImplScope | undefined,
): OwnerFieldWriteIR[] => {
    const rows: OwnerFieldWriteIR[] = [];
    const taint = implScope === undefined ? undefined : implTaintOf(implScope);

    for (const property of objectLiteral.getProperties()) {
        let name: string | undefined;
        let value: TsNode | undefined;

        if (Node.isPropertyAssignment(property)) {
            name = propertyKeyName(property);
            value = property.getInitializer();
        } else if (Node.isShorthandPropertyAssignment(property)) {
            name = propertyKeyName(property);
            value = property.getNameNode();
        }

        if (name === undefined || value === undefined || !IDENTITY_FIELDS.has(name)) {
            continue;
        }

        // Correct: `userId: ctx.auth.userId`; offending: `userId: args.userId`.
        // A value that references `ctx` is server-scoped even when it also embeds
        // `args`, so it is not flagged — mirrors the shared taint convention.
        // Inside a mutator impl taint is resolved by symbol (see `implTaintOf`).
        const isTainted = taint === undefined ? isArgumentDerived(value) : taint.isTaintedValue(value, false);

        if (isTainted && !isScopedByContext(value)) {
            // Recorded either way — the lint decides what to do with it. Dropping it
            // here would make the feeder the only place that knows the write
            // happened, and the `visibility` stamp is the precedent for annotating
            // rather than discarding.
            //
            // Owner-scoped ONLY when the value is, by symbol, the `args[owner]` the
            // runtime verified: `applyOwnerScope` stamps the parsed args object this
            // export's `defineMutator` `server` impl receives as its 2nd parameter,
            // and nothing else. A write anywhere in that impl, nested closures
            // included, qualifies iff it reads THAT parameter and the impl never
            // rewrites or lets it escape. A helper's or a nested function's own
            // parameters can be filled from anything, so they never qualify.
            const ownerScoped =
                write.ownerField === name &&
                implScope?.parameter !== undefined &&
                implScope.pristine &&
                resolvesToOwnerArgument(value, implScope.parameter, name);

            rows.push({
                field: name,
                file: write.relativePath,
                line: write.call.getStartLineNumber(),
                method: write.method,
                scope: write.scope,
                ...(ownerScoped && { ownerScoped: true }),
            });
        }
    }

    return rows;
};

/** Identity columns written from `args` by a single `ctx.db` write call. */
const ownerFieldWritesInCall = (call: CallExpression, relativePath: string, ownerFieldOf: (exportName: string) => string | undefined): OwnerFieldWriteIR[] => {
    const method = contextDatabaseWriteMethod(call.getExpression());
    const documentArgument = method === undefined ? undefined : call.getArguments()[1];

    if (method === undefined || documentArgument === undefined) {
        return [];
    }

    const objectLiterals = documentObjectLiterals(documentArgument, method);

    if (objectLiterals.length === 0) {
        return [];
    }

    const scope = callSiteScopeOf(call);
    const isExport = scope.kind === "export";
    const write = { call, method, ownerField: isExport ? ownerFieldOf(scope.name) : undefined, relativePath, scope };
    const implScope = isExport ? mutatorImplScopeOf(call) : undefined;

    return objectLiterals.flatMap((objectLiteral) => identityWritesInObjectLiteral(objectLiteral, write, implScope));
};

/**
 * Discover `ctx.db` writes (`insert`, `replace`, `patch`, `insertManyUnsafe`) in
 * `lunora/` that set an ownership / identity column — `userId`, `ownerId`,
 * `tenantId`, and the like — from the handler's `args` instead of the
 * server-trusted identity. This is the `owner_field_from_args_not_auth` lint
 * input: the ownership column decides who a row belongs to, so a value taken from
 * request input lets any caller write rows owned by another user or tenant (the
 * act-as-any-user / cross-tenant IDOR vector). A column stamped from `ctx.*`, or
 * set to a fixed literal, is not recorded; only an arg-derived identity write
 * (directly, or through one local `const` hop) reaches here.
 */
const discoverOwnerFieldWrites = (
    project: Project,
    lunoraDirectory: string,
    functions: ReadonlyArray<FunctionIR> = [],
    mutators: ReadonlyArray<MutatorIR> = [],
): OwnerFieldWriteIR[] => {
    // Keyed on file + export because two modules may export the same name.
    const ownerByKey = new Map(mutators.map((entry) => [`${entry.filePath}:${entry.exportName}`, entry.owner]));
    const writes = collectCallRows(project, lunoraDirectory, (call, relativePath) =>
        ownerFieldWritesInCall(call, relativePath, (exportName) => ownerByKey.get(`${relativePath}:${exportName}`)),
    );

    return withCallerVisibility(writes, functions);
};

export default discoverOwnerFieldWrites;
