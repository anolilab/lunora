/** How caller-controlled data flows inside one mutator `server` impl: {@link ImplTaint}. */
import type { CallExpression, Identifier, Node as TsNode, ParameterDeclaration, ts, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isConstDeclaration, isWriteTarget, outermostValueWrapper, unwrapExpression } from "../ast";
import { declarationOf } from "../attribution";
import type { MutatorImplScope } from "./args-pristine";
import type { ObjectBinding } from "./object-flow";
import {
    aliasBindingsOf,
    bindingIdentifiersOf,
    CALLBACK_RESULT_METHODS,
    isMethodCall,
    isPrimitiveType,
    objectContinuation,
    RECEIVER_ITERATING_METHODS,
} from "./object-flow";
import { chainRootOf, ECHOING_CONTEXT_METHODS, isImplContextReference, isReadOnlyCallArgument, receivingParameter, visibleFunctionOf } from "./read-only-use";

/**
 * Methods whose result is their receiver, one of its elements, or a value
 * derived from it without the callback's return value (an index, a boolean):
 * array narrowing and the `ctx.db` query builder. Their callbacks
 * (`withIndex((q) => q.eq("orgId", args.orgId))`) only select.
 */
const RECEIVER_RESULT_METHODS = new Set<string>([
    "at",
    "every",
    "filter",
    "finally",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "forEach",
    "order",
    "slice",
    "some",
    "sort",
    "withIndex",
    "withSearchIndex",
]);

/**
 * The values an inline callback can return: an expression body, or every
 * `return` of a block body (a bare `return;` as `undefined`). `undefined` when
 * `node` is not an inline arrow / function expression.
 */
const callbackResults = (node: TsNode): (TsNode | undefined)[] | undefined => {
    const callback = unwrapExpression(node);

    if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) {
        return undefined;
    }

    const body = callback.getBody();

    if (!Node.isBlock(body)) {
        return [body];
    }

    return body
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((statement) => statement.getFirstAncestor((ancestor) => Node.isFunctionLikeDeclaration(ancestor)) === callback)
        .map((statement) => statement.getExpression());
};

/**
 * Whether `node` may name a function: an identifier bound to a function
 * declaration or to a variable initialized with a function, or one this cannot
 * resolve. A callback passed by reference is not read, so it fails closed.
 */
const isFunctionReference = (node: TsNode): boolean => {
    const value = unwrapExpression(node);

    if (!Node.isIdentifier(value)) {
        return Node.isPropertyAccessExpression(value) || Node.isElementAccessExpression(value);
    }

    const declaration = declarationOf(value);
    const initializer = Node.isVariableDeclaration(declaration) ? unwrapExpression(declaration.getInitializer()) : undefined;

    return (
        declaration === undefined ||
        Node.isFunctionDeclaration(declaration) ||
        Node.isParameterDeclaration(declaration) ||
        Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer)
    );
};

/** `Promise` combinators whose result is the settled values of their argument's elements. */
const PROMISE_COMBINATORS = new Set<string>(["all", "allSettled", "any", "race"]);

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

/** How many variable hops (`const a = b; const b = c`) taint is followed through before failing closed. */
const MAX_VARIABLE_HOPS = 8;

/**
 * How many uncached verdicts ONE top-level taint query may compute before every
 * further verdict fails closed. A cycle makes the verdicts on it uncachable, so
 * a recursive helper re-derived from many call sites could otherwise cost
 * exponential time. The budget is reset per query and cache hits are free, so
 * a long-lived model (a dev loop reusing the project) never drifts. Realistic
 * impls, and a depth-14 chain of helpers that each call the next twice, stay far
 * below it.
 */
const WORK_BUDGET = 50_000;

/** Memoized verdicts plus the keys being computed, for {@link ImplTaint}'s least-fixed-point recursion. */
interface VerdictTable {
    inProgress: Set<ts.Node>;
    verdicts: Map<ts.Node, boolean>;
}

/**
 * The function nested in `impl` whose return value `node` is (`return node`, an
 * arrow's expression body); `undefined` for the impl's own return or no return.
 */
const returningFunctionOf = (node: TsNode, impl: TsNode): TsNode | undefined => {
    const parent = node.getParent();
    const isReturned = Node.isReturnStatement(parent) || (Node.isArrowFunction(parent) && parent.getBody() === node);
    const owner = isReturned ? node.getFirstAncestor((ancestor) => Node.isFunctionLikeDeclaration(ancestor) || Node.isArrowFunction(ancestor)) : undefined;

    return owner === undefined || owner === impl ? undefined : owner;
};

/** One binding queued by {@link ImplTaint}'s flow walk, with the alias hops spent to reach it. */
interface FlowStep {
    binding: ObjectBinding;
    hops: number;
}

/**
 * Hands {@link ImplTaint}'s flow walk the next binding an object flows into;
 * `isAlias` counts it against the alias hop bound. `true` when that bound is
 * exceeded, which the caller reports as a finding (fail-closed).
 */
type Follow = (next: ObjectBinding, isAlias: boolean) => boolean;

/**
 * How taint flows inside one mutator impl, resolved by symbol. Caller-controlled
 * are the impl's own `args` parameter, the `arguments` object, any identifier
 * spelled `args` that is not a nested parameter cleared below, and what derives
 * from them: through variables (followed up to {@link MAX_VARIABLE_HOPS}; a
 * `let` that is reassigned, a variable with no initializer, a `catch` binding,
 * or running out of hops fails closed), through a variable whose object takes
 * a caller-controlled value later (`list.push(args.x)`, `o.k = args.x`,
 * `Object.assign(o, args)`), and through a nested function declaration whose
 * body reads one. A `for…of` / `for…in` variable takes the taint of what it
 * iterates.
 *
 * A value whose member / call chain is ROOTED in the impl's own `ctx`
 * parameter, directly or through `const`s, is server-scoped: rows read through
 * `ctx.db`, even when the query filters on `args`. So is a `Promise`
 * combinator over such reads (`Promise.all(ids.map((id) => ctx.db.get(id)))`).
 * A helper result (`getMembers(ctx, args.orgId)`) is not. Neither is a row that
 * may have been changed since: see {@link ImplTaint.isCompromised}, which
 * follows the row wherever it flows inside the impl.
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
 * (or on the hop bound) is not cached. Past {@link WORK_BUDGET} every verdict
 * fails closed.
 */
class ImplTaint {
    private cuts = 0;

    /** {@link ImplTaint.isCompromised} verdicts, kept apart: they key on the same bindings as the variable verdicts. */
    private readonly compromised: VerdictTable = { inProgress: new Set(), verdicts: new Map() };

    private readonly referencesByDeclaration = new Map<string, Map<ts.Node, Identifier[]>>();

    private readonly referencesByName = new Map<string, Identifier[]>();

    private readonly scope: MutatorImplScope;

    private readonly taint: VerdictTable = { inProgress: new Set(), verdicts: new Map() };

    private variableDepth = 0;

    private queryDepth = 0;

    private work = 0;

    public constructor(scope: MutatorImplScope) {
        this.scope = scope;

        for (const identifier of scope.impl.getDescendantsOfKind(SyntaxKind.Identifier)) {
            const name = identifier.getText();

            this.referencesByName.set(name, [...(this.referencesByName.get(name) ?? []), identifier]);
        }
    }

    /**
     * Whether `value` is caller-controlled. With `rootedInContext`, a value whose
     * member / call chain is rooted in the impl's own `ctx` parameter counts as
     * server-scoped.
     */
    public isTaintedValue(value: TsNode, rootedInContext: boolean): boolean {
        if (this.queryDepth === 0) {
            this.work = 0;
        }

        this.queryDepth += 1;

        try {
            if (rootedInContext && this.isRootedInContext(value, MAX_VARIABLE_HOPS)) {
                return false;
            }

            const identifiers = Node.isIdentifier(value) ? [value] : value.getDescendantsOfKind(SyntaxKind.Identifier);

            return identifiers.some((identifier) => isValueIdentifier(identifier) && this.isIdentifierTainted(identifier));
        } finally {
            this.queryDepth -= 1;
        }
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

    /** `Promise.all([ctx.db.get(a), …])` / `Promise.all(xs.map((x) => ctx.db.get(x)))`: every settled value is ctx-rooted. */
    private isContextRootedCombinator(call: CallExpression, hops: number): boolean {
        const callee = unwrapExpression(call.getExpression());
        const isCombinator =
            Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === "Promise" && PROMISE_COMBINATORS.has(callee.getName());
        const input = isCombinator ? unwrapExpression(call.getArguments()[0]) : undefined;

        if (Node.isArrayLiteralExpression(input)) {
            const elements = input.getElements();

            return elements.length > 0 && elements.every((element) => !Node.isSpreadElement(element) && this.isRootedInContext(element, hops));
        }

        const mapCallee = Node.isCallExpression(input) ? unwrapExpression(input.getExpression()) : undefined;
        const callback =
            Node.isCallExpression(input) && Node.isPropertyAccessExpression(mapCallee) && mapCallee.getName() === "map"
                ? unwrapExpression(input.getArguments()[0])
                : undefined;

        const results = callback === undefined ? undefined : callbackResults(callback);

        return results !== undefined && results.length > 0 && results.every((result) => result !== undefined && this.isRootedInContext(result, hops));
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

        if (Node.isFunctionDeclaration(declaration)) {
            return this.memoized(declaration.compilerNode, () => this.isTaintedValue(declaration, false));
        }

        // A destructured element is an object of its own, which a later statement may change.
        if (Node.isBindingElement(declaration) && this.isCompromised(declaration)) {
            return true;
        }

        const variable = Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration) : declaration;

        return Node.isVariableDeclaration(variable) && this.isVariableTainted(variable, name);
    }

    private isInImpl(node: TsNode): boolean {
        const { impl } = this.scope;

        return node !== impl && impl.getPos() <= node.getPos() && node.getEnd() <= impl.getEnd();
    }

    /**
     * Whether `binding`'s object may hold caller-controlled data stored into it
     * after its initializer. One walk over every binding the object flows into
     * ({@link reaches}): `const` aliases, destructured elements, `for…of`
     * variables, the parameters of nested functions and iterating callbacks it is
     * handed to. Each use of it is first climbed to where its value ends up
     * ({@link objectContinuation}: member paths, `await`, `??`, `?:`,
     * containers, element-returning methods), then judged there
     * ({@link isCompromisingUse}). A binding whose type is a primitive cannot be
     * changed in place and never counts.
     */
    private isCompromised(binding: ObjectBinding): boolean {
        return this.reaches(binding) && !isPrimitiveType(binding.getType());
    }

    /**
     * Whether one use of an object may store caller-controlled data into it.
     * Compromising (fail-closed):
     *
     * - a member write of a caller-controlled value (`o.k = args.x`), or any
     * non-assignment write (`delete o.k`, `o.n++`);
     * - a method call on it with a caller-controlled argument (`list.push(args.x)`);
     * - handing it to a call this cannot see into (an import, a method, a
     * parameter, or a same-file function outside the impl) that caller data
     * also reaches — a caller-controlled operand (`merge(user, args)`) or callee
     * (`args.fn(user)`) — the same for a spread argument, a constructor, a tag;
     * - binding it whole to a `let` / assignment, or any position not recognised
     * below.
     *
     * Followed instead: aliases ({@link aliasBindingsOf}), the parameter of a
     * nested function it is handed to, the parameters of an iterating callback
     * over it. Plain reads are not compromising: member reads that end in a
     * read, read-only calls ({@link isReadOnlyCallArgument}), conditions,
     * comparisons and arithmetic, untagged templates, an index, a `throw`, and
     * the impl's own `return`. A member path whose type is a primitive is a copy
     * and never compromising.
     */
    private isCompromisingUse(reference: Identifier, follow: Follow): boolean {
        return this.valueCompromises(outermostValueWrapper(reference), true, follow, 0);
    }

    /**
     * The {@link isCompromisingUse} verdict from any expression `start` holding the object:
     * a reference to its binding (`isBindingReference`), or the result of a
     * nested function that returns it, judged at each of its call sites.
     */
    private valueCompromises(start: TsNode, isBindingReference: boolean, follow: Follow, depth: number): boolean {
        let end = start;

        for (let next = objectContinuation(end); next !== undefined; next = objectContinuation(end)) {
            if (Node.isCallExpression(next) && this.callbackCompromises(next, follow)) {
                return true;
            }

            end = outermostValueWrapper(next);
        }

        const parent = end.getParent();
        const isBinding = end === start && isBindingReference;
        const isCopy = (): boolean => !isBinding && isPrimitiveType(end.getType());

        if (isWriteTarget(end)) {
            // `row = other` rebinds the name; a write through a member stores into the object.
            return !isBinding && (!Node.isBinaryExpression(parent) || this.isTaintedValue(parent.getRight(), false));
        }

        const aliases = aliasBindingsOf(end);

        if (aliases !== undefined) {
            return aliases.some((alias) => follow(alias, true));
        }

        const method = Node.isPropertyAccessExpression(parent) && parent.getExpression() === end ? parent.getParent() : undefined;

        if (Node.isCallExpression(method) && method.getExpression() === parent) {
            return this.methodCallCompromises(method, follow);
        }

        const returnedFrom = returningFunctionOf(end, this.scope.impl);

        if (returnedFrom !== undefined) {
            return this.resultCompromises(returnedFrom, follow, depth) && !isCopy();
        }

        return this.positionCompromises(end, follow) && !isCopy();
    }

    /**
     * Whether the object, returned from the nested function `returnedFrom`, is
     * compromised where that function's result goes: each call site of a named
     * or immediately invoked function is judged as a value of its own. A
     * predicate or comparator of an iterating method (`rows.filter((r) => r)`)
     * only hands its result to that method. A function used any other way, or
     * past {@link MAX_VARIABLE_HOPS} nested results, fails closed.
     */
    private resultCompromises(returnedFrom: TsNode, follow: Follow, depth: number): boolean {
        const holder = outermostValueWrapper(returnedFrom).getParent();

        if (depth >= MAX_VARIABLE_HOPS) {
            this.cuts += 1;

            return true;
        }

        if (Node.isCallExpression(holder)) {
            const isInvoked = holder.getExpression() === outermostValueWrapper(returnedFrom);

            return isInvoked ? this.valueCompromises(holder, false, follow, depth + 1) : !isMethodCall(holder, RECEIVER_ITERATING_METHODS);
        }

        const binding = Node.isFunctionDeclaration(returnedFrom) ? returnedFrom : holder;
        const nameNode = Node.isFunctionDeclaration(binding) || isConstDeclaration(binding) ? binding.getNameNode() : undefined;

        if (binding === undefined || !Node.isIdentifier(nameNode)) {
            return true;
        }

        return this.referencesTo(binding, nameNode.getText()).some((reference) => {
            const callee = outermostValueWrapper(reference);
            const call = callee.getParent();

            return !Node.isCallExpression(call) || call.getExpression() !== callee || this.valueCompromises(call, false, follow, depth + 1);
        });
    }

    /** A method called on the object (`list.push(x)`, `rows.forEach(cb)`): see {@link isCompromisingUse}. */
    private methodCallCompromises(call: CallExpression, follow: Follow): boolean {
        // A callback (`rows.filter((r) => r.org === args.org)`) reads the object; it stores nothing into it.
        const stored = call.getArguments().filter((argument) => callbackResults(argument) === undefined);

        return stored.some((argument) => this.isTaintedValue(argument, false)) || this.callbackCompromises(call, follow);
    }

    /**
     * Whether the callback of an iterating method over the object
     * (`rows.forEach(cb)`, also when the call's result is climbed through) may
     * store caller data into its elements: a callback nested in the impl is
     * followed into its parameters; any other is opaque, and compromises when it
     * is itself caller-controlled.
     */
    private callbackCompromises(call: CallExpression, follow: Follow): boolean {
        const callback = isMethodCall(call, RECEIVER_ITERATING_METHODS) ? call.getArguments()[0] : undefined;

        if (callback === undefined) {
            return false;
        }

        const target = visibleFunctionOf(callback);

        return target !== undefined && this.isInImpl(target)
            ? target.getParameters().some((parameter) => follow(parameter, false))
            : this.isTaintedValue(callback, false);
    }

    /** Where the climb of {@link isCompromisingUse} ends: an argument, an operand, a statement. */
    private positionCompromises(end: TsNode, follow: Follow): boolean {
        const parent = end.getParent();

        if (Node.isCallExpression(parent) && parent.getArguments().includes(end)) {
            return this.argumentCompromises(parent, end, follow);
        }

        if (Node.isSpreadElement(parent) && Node.isCallExpression(parent.getParent())) {
            const call = parent.getParentOrThrow() as CallExpression;

            return !isReadOnlyCallArgument(parent, this.scope.context) && this.isOpaqueCallTainted(call.getExpression(), call.getArguments(), parent);
        }

        if (Node.isNewExpression(parent)) {
            return this.isOpaqueCallTainted(parent.getExpression(), parent.getArguments(), end);
        }

        if (Node.isTemplateSpan(parent)) {
            const template = parent.getParent();
            const tagged = template.getParent();
            const spans = template.getTemplateSpans().map((span) => span.getExpression());

            return Node.isTaggedTemplateExpression(tagged) && this.isOpaqueCallTainted(tagged.getTag(), spans, end);
        }

        return !this.isReadPosition(end);
    }

    /** Handing the object to `call`: see {@link isCompromisingUse}. */
    private argumentCompromises(call: CallExpression, value: TsNode, follow: Follow): boolean {
        if (isReadOnlyCallArgument(value, this.scope.context)) {
            return false;
        }

        const target = visibleFunctionOf(call.getExpression());
        const receiver = target === undefined ? undefined : receivingParameter(target, call, value);

        if (receiver?.kind === "unreached") {
            return false;
        }

        // A function nested in the impl sees caller data, so its writes are judged by their values.
        if (receiver?.kind === "parameter" && target !== undefined && this.isInImpl(target)) {
            return follow(receiver.parameter, false);
        }

        // Anything else — an import, a same-file function outside the impl — only plants caller data that reaches it.
        return this.isOpaqueCallTainted(call.getExpression(), call.getArguments(), value);
    }

    /** Positions where a value is only read: a condition, a comparison or arithmetic operand, an index, a `throw`, the impl's own `return`. */
    private isReadPosition(end: TsNode): boolean {
        const parent = end.getParent();

        if (parent === undefined || Node.isExpressionStatement(parent) || Node.isThrowStatement(parent) || Node.isForInStatement(parent)) {
            return true;
        }

        if (
            Node.isIfStatement(parent) ||
            Node.isWhileStatement(parent) ||
            Node.isDoStatement(parent) ||
            Node.isSwitchStatement(parent) ||
            Node.isCaseClause(parent)
        ) {
            return true;
        }

        if (Node.isConditionalExpression(parent) || Node.isElementAccessExpression(parent) || Node.isComputedPropertyName(parent)) {
            return true;
        }

        if (Node.isPrefixUnaryExpression(parent) || Node.isTypeOfExpression(parent) || Node.isVoidExpression(parent)) {
            return true;
        }

        if (Node.isBinaryExpression(parent)) {
            const operator = parent.getOperatorToken().getKind();

            return operator < SyntaxKind.FirstAssignment || operator > SyntaxKind.LastAssignment;
        }

        if (Node.isTemplateSpan(parent) || Node.isForStatement(parent)) {
            return true;
        }

        const returned = Node.isReturnStatement(parent) || (Node.isArrowFunction(parent) && parent.getBody() === end);
        const owner = returned ? end.getFirstAncestor((ancestor) => Node.isFunctionLikeDeclaration(ancestor) || Node.isArrowFunction(ancestor)) : undefined;

        return owner !== undefined && owner === this.scope.impl;
    }

    /** Whether caller data reaches an opaque call: its callee is caller-controlled, or an operand other than `value` is. */
    private isOpaqueCallTainted(callee: TsNode, operands: ReadonlyArray<TsNode>, value: TsNode): boolean {
        return this.isTaintedValue(callee, false) || operands.some((operand) => operand !== value && this.isTaintedValue(operand, false));
    }

    /**
     * Whether any binding `root`'s object flows into — `root` itself, and every
     * binding {@link isCompromisingUse} hands to `follow`, transitively — has a
     * compromising use. A breadth-first walk over that flow, not a recursion: a
     * recursive helper (`walk(n)` calling `walk(n.child)`) puts its parameter on
     * a cycle, and a recursion would have to leave every verdict on it uncached.
     * Alias hops are bounded by {@link MAX_VARIABLE_HOPS} per path, past which
     * the walk fails closed. A binding reached through the flow whose type is a
     * primitive is a copy, so its uses do not count. When nothing is found (and
     * no cut cycle or bound was involved), every binding visited is clean too —
     * its own flow is part of `root`'s — so each is cached as such.
     */
    private reaches(root: ObjectBinding): boolean {
        return this.memoized(
            root.compilerNode,
            () => {
                const cutsBefore = this.cuts;
                const queue: FlowStep[] = [];
                const seen = new Set<ts.Node>();
                const enqueue = (binding: ObjectBinding, hops: number): void => {
                    if (!seen.has(binding.compilerNode)) {
                        seen.add(binding.compilerNode);
                        queue.push({ binding, hops });
                    }
                };
                let found = false;

                enqueue(root, 0);

                for (const step of queue) {
                    const known = step.binding === root ? undefined : this.compromised.verdicts.get(step.binding.compilerNode);

                    found = known ?? this.visitBinding(step, root, enqueue);

                    if (found) {
                        break;
                    }
                }

                if (!found && this.cuts === cutsBefore) {
                    for (const node of seen) {
                        this.compromised.verdicts.set(node, false);
                    }
                }

                return found;
            },
            this.compromised,
        );
    }

    /** Expand one binding of {@link reaches}: judge its references, or queue a destructured parameter's elements. */
    private visitBinding({ binding, hops }: FlowStep, root: ObjectBinding, enqueue: (binding: ObjectBinding, hops: number) => void): boolean {
        const nameNode = binding.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            // A destructured parameter binds members of what it receives, each an object of its own.
            for (const element of Node.isParameterDeclaration(binding) ? bindingIdentifiersOf(binding) : []) {
                enqueue(element, hops);
            }

            return false;
        }

        this.work += 1;

        if (this.work > WORK_BUDGET) {
            this.cuts += 1;

            return true;
        }

        const follow: Follow = (next, isAlias) => {
            if (isAlias && hops >= MAX_VARIABLE_HOPS) {
                this.cuts += 1;

                return true;
            }

            enqueue(next, isAlias ? hops + 1 : hops);

            return false;
        };
        const found = this.referencesTo(binding, nameNode.getText()).some((reference) => this.isCompromisingUse(reference, follow));

        return found && (binding === root || !isPrimitiveType(binding.getType()));
    }

    /**
     * What one call on a chain settles: `true` for a `Promise` combinator over
     * ctx reads, `false` for an {@link ECHOING_CONTEXT_METHODS} call, otherwise
     * nothing (keep walking).
     */
    private callChainVerdict(call: CallExpression, hops: number): boolean | undefined {
        if (this.isContextRootedCombinator(call, hops)) {
            return true;
        }

        const callee = unwrapExpression(call.getExpression());
        const method = Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;

        if (method !== undefined && ECHOING_CONTEXT_METHODS.has(method)) {
            return false;
        }

        if (method !== undefined && CALLBACK_RESULT_METHODS.has(method)) {
            return this.isCallbackResultServerScoped(call, hops) ? undefined : false;
        }

        // A method that returns its receiver (or one of its elements) passes through;
        // any other method handed an inline callback may return that callback's value.
        const takesCallback = call.getArguments().some((argument) => callbackResults(argument) !== undefined);

        return takesCallback && (method === undefined || !RECEIVER_RESULT_METHODS.has(method)) ? false : undefined;
    }

    /**
     * Whether every value a callback-result call (`then`, `map`, `reduce`, …) can
     * produce is server-scoped: each inline callback's returned value is rooted
     * in `ctx`, rooted in one of that callback's own parameters (which carry the
     * ctx-rooted receiver's elements), or clean; and every other argument (a
     * `reduce` seed) is rooted in `ctx` or clean. A callback passed by reference
     * fails closed.
     */
    private isCallbackResultServerScoped(call: CallExpression, hops: number): boolean {
        const isServerScoped = (value: TsNode, callbackParameters: ReadonlyArray<ParameterDeclaration> = []): boolean => {
            const root = chainRootOf(value);
            const parameter = Node.isIdentifier(root) ? parameterOf(declarationOf(root)) : undefined;

            if (parameter !== undefined && callbackParameters.includes(parameter)) {
                return true;
            }

            return this.isRootedInContext(value, hops) || !this.isTaintedValue(value, false);
        };

        return call.getArguments().every((argument) => {
            const results = callbackResults(argument);

            if (results === undefined) {
                return !isFunctionReference(argument) && isServerScoped(argument);
            }

            const callback = unwrapExpression(argument);
            const parameters = Node.isArrowFunction(callback) || Node.isFunctionExpression(callback) ? callback.getParameters() : [];

            return results.every((result) => result === undefined || isServerScoped(result, parameters));
        });
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
            const verdict = Node.isCallExpression(current) ? this.callChainVerdict(current, hops) : undefined;

            if (verdict !== undefined) {
                return verdict;
            }

            current = unwrapExpression(current.getExpression());
        }

        if (isImplContextReference(current, this.scope.context)) {
            return true;
        }

        const declaration = Node.isIdentifier(current) ? declarationOf(current) : undefined;
        const variable = Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration) : declaration;
        const initializer = isConstDeclaration(variable) && this.isInImpl(variable) ? variable.getInitializer() : undefined;
        const binding = Node.isBindingElement(declaration) ? declaration : variable;

        return (
            hops > 0 &&
            initializer !== undefined &&
            (Node.isBindingElement(binding) || Node.isVariableDeclaration(binding)) &&
            !this.isCompromised(binding) &&
            this.isRootedInContext(initializer, hops - 1)
        );
    }

    private isSource(parameter: ParameterDeclaration): boolean {
        const { impl, parameter: argsParameter } = this.scope;

        if (parameter.compilerNode === argsParameter?.compilerNode) {
            return true;
        }

        // A nested parameter is caller-controlled when what flows into it is, or when its object is changed afterwards.
        return (
            parameter.getParent() !== impl &&
            this.isInImpl(parameter) &&
            (this.memoized(parameter.compilerNode, () => this.flowsIntoTainted(parameter)) || this.isCompromised(parameter))
        );
    }

    private isVariableTainted(variable: VariableDeclaration, name: string): boolean {
        return this.memoized(variable.compilerNode, () => {
            const holder = variable.getParent().getParent();

            if (Node.isCatchClause(variable.getParent()) || this.isCompromised(variable)) {
                return true;
            }

            if (Node.isForOfStatement(holder) || Node.isForInStatement(holder)) {
                return this.isTaintedValue(holder.getExpression(), true);
            }

            const initializer = variable.getInitializer();
            const isReassigned = !isConstDeclaration(variable) && this.referencesTo(variable, name).some((reference) => isWriteTarget(reference));

            if (initializer === undefined || isReassigned) {
                return true;
            }

            if (this.isRootedInContext(initializer, MAX_VARIABLE_HOPS)) {
                return false;
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

    private memoized(key: ts.Node, compute: () => boolean, table: VerdictTable = this.taint): boolean {
        const known = table.verdicts.get(key);

        if (known !== undefined) {
            return known;
        }

        if (table.inProgress.has(key)) {
            this.cuts += 1;

            return false;
        }

        this.work += 1;

        if (this.work > WORK_BUDGET) {
            this.cuts += 1;

            return true;
        }

        const cutsBefore = this.cuts;

        table.inProgress.add(key);

        let verdict: boolean;

        try {
            verdict = compute();
        } finally {
            table.inProgress.delete(key);
        }

        if (this.cuts === cutsBefore) {
            table.verdicts.set(key, verdict);
        }

        return verdict;
    }

    /**
     * The references to `declaration` (spelled `name`) inside the impl. The
     * identifiers spelled `name` are resolved once, on the first query for that
     * spelling, and grouped by declaration: many same-named bindings (300
     * helpers each taking `d`) then cost one symbol lookup per identifier, not
     * one per identifier per binding.
     */
    private referencesTo(declaration: TsNode, name: string): Identifier[] {
        let byDeclaration = this.referencesByDeclaration.get(name);

        if (byDeclaration === undefined) {
            byDeclaration = new Map();

            for (const reference of this.referencesByName.get(name) ?? []) {
                const target = declarationOf(reference)?.compilerNode;

                if (target !== undefined) {
                    byDeclaration.set(target, [...(byDeclaration.get(target) ?? []), reference]);
                }
            }

            this.referencesByDeclaration.set(name, byDeclaration);
        }

        return (byDeclaration.get(declaration.compilerNode) ?? []).filter((reference) => reference.getParent() !== declaration);
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

export default implTaintOf;
