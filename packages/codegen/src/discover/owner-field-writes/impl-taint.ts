/** How caller-controlled data flows inside one mutator `server` impl: {@link ImplTaint}. */
import type { CallExpression, Identifier, Node as TsNode, ParameterDeclaration, ts, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { chainRootOf, isConstDeclaration, outermostValueWrapper, unwrapExpression, walkChain } from "../ast";
import { declarationOf, isReassignedBinding, isValueIdentifier } from "../attribution";
import { CALLBACK_RESULT_METHODS, ECHOING_CONTEXT_METHODS } from "../context-root";
import type { MutatorImplScope } from "./args-pristine";
import type { TaintOracle } from "./compromise-walk";
import { CompromiseWalk } from "./compromise-walk";
import { callbackResults, RECEIVER_ITERATING_METHODS } from "./object-flow";
import { isImplContextReference, isLibraryGlobal } from "./read-only-use";
import { createVerdictTable, VerdictBudget } from "./verdict-budget";

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

/** How many variable hops (`const a = b; const b = c`) taint is followed through before failing closed. */
const MAX_VARIABLE_HOPS = 8;

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
 * may have been changed since: see {@link CompromiseWalk}, which follows the
 * row wherever it flows inside the impl.
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
 * (or on the hop bound) is not cached. Past the work budget every verdict fails
 * closed (see {@link VerdictBudget}).
 */
class ImplTaint implements TaintOracle {
    private readonly budget = new VerdictBudget();

    private readonly referencesByDeclaration = new Map<string, Map<ts.Node, Identifier[]>>();

    private readonly referencesByName = new Map<string, Identifier[]>();

    private readonly scope: MutatorImplScope;

    private readonly verdicts = createVerdictTable();

    private readonly walk: CompromiseWalk;

    private variableDepth = 0;

    private queryDepth = 0;

    public constructor(scope: MutatorImplScope) {
        this.scope = scope;
        this.walk = new CompromiseWalk(scope, this.budget, this);

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
            this.budget.reset();
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

    /** Whether `node` sits strictly inside the impl. */
    public isInImpl(node: TsNode): boolean {
        const { impl } = this.scope;

        return node !== impl && impl.getPos() <= node.getPos() && node.getEnd() <= impl.getEnd();
    }

    /**
     * The references to `declaration` (spelled `name`) inside the impl. The
     * identifiers spelled `name` are resolved once, on the first query for that
     * spelling, and grouped by declaration: many same-named bindings (300
     * helpers each taking `d`) then cost one symbol lookup per identifier, not
     * one per identifier per binding.
     */
    public referencesTo(declaration: TsNode, name: string): Identifier[] {
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
        const object = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined;
        const isCombinator =
            Node.isPropertyAccessExpression(callee) &&
            Node.isIdentifier(object) &&
            object.getText() === "Promise" &&
            isLibraryGlobal(object) &&
            PROMISE_COMBINATORS.has(callee.getName());
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
            return this.budget.memoized(declaration.compilerNode, () => this.isTaintedValue(declaration, false), this.verdicts);
        }

        // A destructured element is an object of its own, which a later statement may change.
        if (Node.isBindingElement(declaration) && this.walk.isCompromised(declaration)) {
            return true;
        }

        const variable = Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration) : declaration;

        return Node.isVariableDeclaration(variable) && this.isVariableTainted(variable);
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
        const end = walkChain(value, (call) => this.callChainVerdict(call, hops));
        const current = end.root;

        if (end.verdict !== undefined) {
            return end.verdict;
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
            !this.walk.isCompromised(binding) &&
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
            (this.budget.memoized(parameter.compilerNode, () => this.flowsIntoTainted(parameter), this.verdicts) || this.walk.isCompromised(parameter))
        );
    }

    private isVariableTainted(variable: VariableDeclaration): boolean {
        return this.budget.memoized(
            variable.compilerNode,
            () => {
                const holder = variable.getParent().getParent();

                if (Node.isCatchClause(variable.getParent()) || this.walk.isCompromised(variable)) {
                    return true;
                }

                if (Node.isForOfStatement(holder) || Node.isForInStatement(holder)) {
                    return this.isTaintedValue(holder.getExpression(), true);
                }

                const initializer = variable.getInitializer();
                const isReassigned = isReassignedBinding(variable);

                if (initializer === undefined || isReassigned) {
                    return true;
                }

                if (this.isRootedInContext(initializer, MAX_VARIABLE_HOPS)) {
                    return false;
                }

                if (this.variableDepth >= MAX_VARIABLE_HOPS) {
                    return this.budget.cut();
                }

                this.variableDepth += 1;

                try {
                    return this.isTaintedValue(initializer, false);
                } finally {
                    this.variableDepth -= 1;
                }
            },
            this.verdicts,
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

export default implTaintOf;
