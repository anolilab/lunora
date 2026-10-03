/** How caller-controlled data flows inside one mutator `server` impl: {@link ImplTaint}. */
import type { BindingElement, CallExpression, Identifier, Node as TsNode, ParameterDeclaration, ts, Type, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isConstDeclaration, isWriteTarget, outermostValueWrapper, unwrapExpression } from "../ast";
import { declarationOf } from "../attribution";
import type { MutatorImplScope } from "./args-pristine";
import {
    chainRootOf,
    ECHOING_CONTEXT_METHODS,
    isContextReference,
    isCopiedOnly,
    isObjectAssignTarget,
    isReadOnlyCallArgument,
    isReadOnlyParameter,
    isSameNode,
    receivingParameter,
    visibleFunctionOf,
} from "./read-only-use";

/**
 * Methods whose RESULT is built from their callback's return value (or a seed
 * argument): a ctx-rooted receiver does not make that result server-scoped.
 */
const CALLBACK_RESULT_METHODS = new Set<string>(["catch", "flatMap", "map", "reduce", "reduceRight", "then"]);

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

/** A binding whose object a later statement may change: a variable, a parameter, or one element of a destructuring. */
type ObjectBinding = BindingElement | ParameterDeclaration | VariableDeclaration;

/** The identifier-named elements of a destructuring pattern, nested ones included. */
const bindingIdentifiersOf = (binding: ObjectBinding): BindingElement[] =>
    binding
        .getNameNode()
        .getDescendantsOfKind(SyntaxKind.BindingElement)
        .filter((element) => Node.isIdentifier(element.getNameNode()));

/**
 * The outermost member path over `node` (`row` → `row.meta.inner`,
 * `row["meta"]`), seen through wrappers. With `stopAtMethod`, the walk stops
 * at the receiver of a method call (`row.members` in `row.members.forEach(cb)`).
 */
const memberPathOf = (node: TsNode, stopAtMethod: boolean): TsNode => {
    let top = outermostValueWrapper(node);
    let parent = top.getParent();

    while ((Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === top) {
        const holder = parent.getParent();

        if (stopAtMethod && Node.isCallExpression(holder) && holder.getExpression() === parent) {
            break;
        }

        top = outermostValueWrapper(parent);
        parent = top.getParent();
    }

    return top;
};

/** The variable declaration `node` (through wrappers) is the whole initializer of, or the loop variable of a `for…of` over it. */
const receivingDeclarationOf = (node: TsNode): VariableDeclaration | undefined => {
    const value = outermostValueWrapper(node);
    const parent = value.getParent();

    if (Node.isVariableDeclaration(parent)) {
        return isSameNode(parent.getInitializer(), value) ? parent : undefined;
    }

    const initializer = Node.isForOfStatement(parent) && parent.getExpression() === value ? parent.getInitializer() : undefined;

    return Node.isVariableDeclarationList(initializer) ? initializer.getDeclarations()[0] : undefined;
};

/**
 * The bindings that take (part of) `node`'s object, which the flow walk follows
 * as aliases: a `const` bound to it (`const alias = row`, `const m = row.meta`),
 * the loop variable of a `for…of` over it, and every element of a destructuring
 * of it (`const { meta } = row`, `const { meta: { inner } } = row`,
 * `for (const { meta } of rows)`), whose object-valued members are the row's own
 * nested objects. `undefined` when `node` is no such initializer. A `let` /
 * `var` bound to it whole is not followed (see `escapesAsOperand`).
 */
const aliasBindingsOf = (node: TsNode): ObjectBinding[] | undefined => {
    const declaration = receivingDeclarationOf(node);
    const isLoopVariable = declaration !== undefined && Node.isForOfStatement(declaration.getParent().getParent());

    if (declaration === undefined) {
        return undefined;
    }

    if (!Node.isIdentifier(declaration.getNameNode())) {
        return bindingIdentifiersOf(declaration);
    }

    return isLoopVariable || isConstDeclaration(declaration) ? [declaration] : undefined;
};

/** Whether every value of `type` is a primitive, which no call can change in place. `any` / `unknown` are not. */
const isPrimitiveType = (type: Type): boolean => {
    if (type.isUnion()) {
        return type.getUnionTypes().every((member) => isPrimitiveType(member));
    }

    if (type.isIntersection()) {
        return type.getIntersectionTypes().some((member) => isPrimitiveType(member));
    }

    return !type.isAny() && !type.isUnknown() && !type.isObject() && !type.isTypeParameter();
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
 * may have been changed since: see {@link ImplTaint.isMutatedWithTaint} and
 * {@link ImplTaint.isChangedUnseen}, which follow the row through `const`
 * aliases, `for…of` variables, iterating callbacks and the parameters of the
 * nested functions it is handed to.
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

    /** {@link ImplTaint.isChangedUnseen} verdicts, kept apart: they key on the same bindings as the mutation verdicts. */
    private readonly escapes: VerdictTable = { inProgress: new Set(), verdicts: new Map() };

    /** {@link ImplTaint.isMutatedWithTaint} verdicts, keyed on the binding like the variable verdicts are. */
    private readonly mutations: VerdictTable = { inProgress: new Set(), verdicts: new Map() };

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
        if (Node.isBindingElement(declaration) && (this.isMutatedWithTaint(declaration) || this.isChangedUnseen(declaration))) {
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
     * Whether `binding` may have absorbed caller-controlled data in code this
     * cannot read. The attacker controls `args`, not a helper's code, so an
     * opaque call (an import, a method, a parameter) can only plant caller data
     * in the row when caller data reaches that call too: the row (or a `const`
     * alias of it, or the loop variable of a `for…of` over it) is handed to an
     * opaque call that also receives a caller-controlled argument
     * (`merge(user, args)`, `apply(user, { owner: args.x })`), or whose callee is
     * itself caller-controlled (`args.fn(user)`, `handlers[args.kind](user)`).
     * Spreading it into such a call, handing it to such a constructor or
     * template tag, counts the same. A `let` / assignment alias, past which its
     * uses are not followed, fails closed. Read-only calls
     * ({@link isReadOnlyCallArgument}) and `Object.assign`'s target (judged by
     * what it stores, in {@link isMutatedWithTaint}) never count; a nested
     * function, or an iterating callback over it (`rows.forEach(cb)`), is
     * followed into its parameters, and a same-file function outside the impl
     * must only read it ({@link isReadOnlyParameter}). A binding whose type is a
     * primitive cannot be changed in place and never counts.
     */
    private isChangedUnseen(binding: ObjectBinding): boolean {
        return this.reaches(binding, this.escapes, (reference, follow) => this.escapesThrough(reference, follow)) && !isPrimitiveType(binding.getType());
    }

    /** One use of {@link isChangedUnseen}: whether it hands the object to code that may plant caller data in it. */
    private escapesThrough(reference: Identifier, follow: Follow): boolean {
        // The row itself, or a member path of it (`row.meta`): its nested objects are the row's own.
        const value = memberPathOf(reference, true);
        const parent = value.getParent();
        const aliases = aliasBindingsOf(value);

        if (aliases !== undefined) {
            return aliases.filter((alias) => !isPrimitiveType(alias.getType())).some((alias) => follow(alias, true));
        }

        // A primitive member is a copy: nothing done with it reaches the row. Asked last, as it costs a type.
        const isObjectValued = (): boolean => value === outermostValueWrapper(reference) || !isPrimitiveType(value.getType());

        if (Node.isCallExpression(parent) && parent.getArguments().includes(value)) {
            return this.escapesAsArgument(parent, value, follow) && isObjectValued();
        }

        if (this.escapesAsOperand(value)) {
            return isObjectValued();
        }

        const method = Node.isPropertyAccessExpression(parent) && parent.getExpression() === value ? parent : undefined;
        const call = method?.getParent();

        if (method === undefined || !Node.isCallExpression(call) || call.getExpression() !== method || !RECEIVER_ITERATING_METHODS.has(method.getName())) {
            return false;
        }

        const callback = call.getArguments()[0];
        const target = callback === undefined ? undefined : visibleFunctionOf(callback);

        if (callback === undefined) {
            return false;
        }

        if (target === undefined) {
            // An opaque callback sees the elements; it can only plant caller data that reaches it.
            return this.isTaintedValue(callback, false) || this.hasTaintedOperand(call.getArguments(), callback);
        }

        return this.isInImpl(target)
            ? target.getParameters().some((parameter) => follow(parameter, false))
            : !target.getParameters().every((parameter) => isReadOnlyParameter(parameter));
    }

    /**
     * Whether `node` (the row or a member path of it) is aliased whole by a
     * binding this does not follow (`let alias = row`, `alias = row`; `const`
     * aliases and destructurings are followed by {@link aliasBindingsOf} before
     * this is asked), or spread into a call, handed to a constructor or to a
     * template tag that caller data also reaches (see {@link isChangedUnseen}).
     */
    private escapesAsOperand(node: TsNode): boolean {
        const value = outermostValueWrapper(node);
        const parent = value.getParent();

        if (Node.isVariableDeclaration(parent)) {
            return isSameNode(parent.getInitializer(), value);
        }

        if (Node.isBinaryExpression(parent)) {
            return isSameNode(parent.getRight(), value) && isWriteTarget(parent.getLeft());
        }

        const holder = parent?.getParent();

        if (Node.isSpreadElement(parent) && Node.isCallExpression(holder)) {
            return !isReadOnlyCallArgument(parent, this.scope.context) && this.isOpaqueCallTainted(holder.getExpression(), holder.getArguments(), parent);
        }

        if (Node.isNewExpression(parent)) {
            return this.isOpaqueCallTainted(parent.getExpression(), parent.getArguments(), value);
        }

        if (!Node.isTemplateSpan(parent) || isCopiedOnly(value)) {
            return false;
        }

        const template = parent.getParent();
        const tagged = template.getParent();

        return (
            Node.isTaggedTemplateExpression(tagged) &&
            this.isOpaqueCallTainted(
                tagged.getTag(),
                template.getTemplateSpans().map((span) => span.getExpression()),
                value,
            )
        );
    }

    /** Whether handing `value` to `call` may plant caller data in it: see {@link isChangedUnseen}. */
    private escapesAsArgument(call: CallExpression, value: TsNode, follow: Follow): boolean {
        if (isReadOnlyCallArgument(value, this.scope.context) || isObjectAssignTarget(call, value)) {
            return false;
        }

        const target = visibleFunctionOf(call.getExpression());
        const parameter = target === undefined ? undefined : receivingParameter(target, call, value);

        if (target === undefined || parameter === undefined) {
            return this.isOpaqueCallTainted(call.getExpression(), call.getArguments(), value);
        }

        if (parameter === null) {
            return false;
        }

        // A nested function's writes are judged by their values (`isMutatedWithTaint`); one outside the impl must only read.
        return this.isInImpl(target) ? follow(parameter, false) : !isReadOnlyParameter(parameter);
    }

    /** Whether caller data reaches an opaque call: its callee is caller-controlled, or an operand other than `value` is. */
    private isOpaqueCallTainted(callee: TsNode, operands: ReadonlyArray<TsNode>, value: TsNode): boolean {
        return this.isTaintedValue(callee, false) || this.hasTaintedOperand(operands, value);
    }

    /** Whether any of `operands` other than `value` is caller-controlled (a spread `...args` included). */
    private hasTaintedOperand(operands: ReadonlyArray<TsNode>, value: TsNode): boolean {
        return operands.some((operand) => operand !== value && this.isTaintedValue(operand, false));
    }

    /**
     * Whether a caller-controlled value is stored INTO `binding`'s object after
     * its initializer: a member write (`o.k = args.x`), a method call on it with
     * a tainted argument (`list.push(args.x)`, `map.set(k, args.x)`), a call it
     * is passed to alongside a tainted argument (`Object.assign(o, args)`), or —
     * through a `const` alias of it, the loop variable of a `for…of` over it,
     * an iterating callback over it (`rows.forEach((r) => …)`), or the parameter
     * of a nested function it is handed to (`set(row)`) — any of the same.
     */
    private isMutatedWithTaint(binding: ObjectBinding): boolean {
        return this.reaches(binding, this.mutations, (reference, follow) => this.storesTaintThrough(reference, follow));
    }

    /** One use of {@link isMutatedWithTaint}: whether it stores a caller-controlled value into the object. */
    private storesTaintThrough(reference: Identifier, follow: Follow): boolean {
        const value = outermostValueWrapper(reference);
        let top = value;
        let parent = top.getParent();

        while ((Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === top) {
            top = outermostValueWrapper(parent);
            parent = top.getParent();
        }

        if (top !== value && isWriteTarget(top)) {
            return !Node.isBinaryExpression(parent) || this.isTaintedValue(parent.getRight(), false);
        }

        // A binding of the row or of a member path of it (`const { meta } = row`) shares its objects.
        const aliases = aliasBindingsOf(top);

        if (aliases !== undefined) {
            return aliases.some((alias) => follow(alias, true));
        }

        if (!Node.isCallExpression(parent)) {
            return false;
        }

        const callArguments = parent.getArguments();

        if (this.nestedParametersReceiving(parent, top).some((parameter) => follow(parameter, false))) {
            return true;
        }

        // A callback (`rows.filter((r) => r.org === args.org)`) reads the object; it stores nothing into it.
        const others = callArguments.filter((argument) => {
            const unwrapped = unwrapExpression(argument);

            return argument !== top && !Node.isArrowFunction(unwrapped) && !Node.isFunctionExpression(unwrapped);
        });

        return (parent.getExpression() === top || callArguments.includes(top)) && others.some((argument) => this.isTaintedValue(argument, false));
    }

    /**
     * The parameters of functions nested in the impl that receive `node`'s
     * object in `call`: `node` handed to one as an argument (`set(row)`), or the
     * receiver of an iterating method one is the callback of
     * (`rows.forEach((r) => …)`).
     */
    private nestedParametersReceiving(call: CallExpression, node: TsNode): ParameterDeclaration[] {
        if (call.getArguments().includes(node)) {
            const target = visibleFunctionOf(call.getExpression());
            const parameter = target !== undefined && this.isInImpl(target) ? receivingParameter(target, call, node) : undefined;

            return parameter === undefined || parameter === null ? [] : [parameter];
        }

        const method = Node.isPropertyAccessExpression(node) && call.getExpression() === node ? node.getName() : undefined;
        const callback = method !== undefined && RECEIVER_ITERATING_METHODS.has(method) ? call.getArguments()[0] : undefined;
        const target = callback === undefined ? undefined : visibleFunctionOf(callback);

        return target !== undefined && this.isInImpl(target) ? target.getParameters() : [];
    }

    /**
     * Whether any binding `root`'s object flows into — `root` itself, and every
     * binding `visit` hands to `follow`, transitively — has a use `visit` judges
     * bad. A breadth-first walk over that flow, not a recursion: a recursive
     * helper (`walk(n)` calling `walk(n.child)`) puts its parameter on a cycle,
     * and a recursion would have to leave every verdict on it uncached. Alias
     * hops (`follow(next, true)`) are bounded by {@link MAX_VARIABLE_HOPS} per
     * path, past which the walk fails closed. When nothing is found (and no cut
     * cycle or bound was involved), every binding visited is clean too — its own
     * flow is part of `root`'s — so each is cached as such.
     */
    private reaches(root: ObjectBinding, table: VerdictTable, visit: (reference: Identifier, follow: Follow) => boolean): boolean {
        return this.memoized(
            root.compilerNode,
            () => {
                const cutsBefore = this.cuts;
                const queue: { binding: ObjectBinding; hops: number }[] = [{ binding: root, hops: 0 }];
                const seen = new Set<ts.Node>([root.compilerNode]);
                let found = false;
                const enqueue = (binding: ObjectBinding, hops: number): void => {
                    if (!seen.has(binding.compilerNode)) {
                        seen.add(binding.compilerNode);
                        queue.push({ binding, hops });
                    }
                };

                for (let index = 0; index < queue.length && !found; index += 1) {
                    const { binding, hops } = queue[index] as { binding: ObjectBinding; hops: number };
                    const known = binding === root ? undefined : table.verdicts.get(binding.compilerNode);
                    const follow: Follow = (next, isAlias) => {
                        if (isAlias && hops >= MAX_VARIABLE_HOPS) {
                            this.cuts += 1;

                            return true;
                        }

                        enqueue(next, isAlias ? hops + 1 : hops);

                        return false;
                    };

                    found = known ?? this.visitBinding(binding, visit, follow, enqueue, hops);
                }

                if (!found && this.cuts === cutsBefore) {
                    for (const node of seen) {
                        table.verdicts.set(node, false);
                    }
                }

                return found;
            },
            table,
        );
    }

    /** Expand one binding of {@link reaches}: its references, or a destructured parameter's elements. */
    private visitBinding(
        binding: ObjectBinding,
        visit: (reference: Identifier, follow: Follow) => boolean,
        follow: Follow,
        enqueue: (binding: ObjectBinding, hops: number) => void,
        hops: number,
    ): boolean {
        const nameNode = binding.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            // A destructured parameter binds members of what it receives, each an object of its own.
            if (Node.isParameterDeclaration(binding)) {
                for (const element of bindingIdentifiersOf(binding)) {
                    enqueue(element, hops);
                }
            }

            return false;
        }

        this.work += 1;

        if (this.work > WORK_BUDGET) {
            this.cuts += 1;

            return true;
        }

        return this.referencesTo(binding, nameNode.getText()).some((reference) => visit(reference, follow));
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

        if (isContextReference(current, this.scope.context)) {
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
            !this.isMutatedWithTaint(binding) &&
            !this.isChangedUnseen(binding) &&
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
            (this.memoized(parameter.compilerNode, () => this.flowsIntoTainted(parameter)) ||
                this.isMutatedWithTaint(parameter) ||
                this.isChangedUnseen(parameter))
        );
    }

    private isVariableTainted(variable: VariableDeclaration, name: string): boolean {
        return this.memoized(variable.compilerNode, () => {
            const holder = variable.getParent().getParent();

            if (Node.isCatchClause(variable.getParent()) || this.isMutatedWithTaint(variable) || this.isChangedUnseen(variable)) {
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
