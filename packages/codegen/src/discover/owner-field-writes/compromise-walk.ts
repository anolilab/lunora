/**
 * Whether an object bound inside a mutator impl may have caller-controlled
 * data stored into it after its initializer: {@link CompromiseWalk}. The
 * judging half of the row walk; `object-flow` is the syntax half that climbs
 * each use to where its value ends up.
 */
import type { CallExpression, Identifier, Node as TsNode, ts } from "ts-morph";
import { Node } from "ts-morph";

import { isConstDeclaration, isSameNode, isWriteTarget, outermostValueWrapper, returningFunctionOf, unwrapExpression } from "../ast";
import type { MutatorImplScope } from "./args-pristine";
import type { ObjectBinding } from "./object-flow";
import {
    aliasBindingsOf,
    bindingIdentifiersOf,
    callbackResults,
    isMethodCall,
    isPrimitiveType,
    objectContinuation,
    RECEIVER_ITERATING_METHODS,
} from "./object-flow";
import { isReadOnlyCallArgument, isReadOperand, receivingParameter, visibleFunctionOf } from "./read-only-use";
import type { VerdictBudget } from "./verdict-budget";
import { createVerdictTable } from "./verdict-budget";

/** How many alias hops (`const a = row; const b = a`) one flow path follows before failing closed. */
const MAX_ALIAS_HOPS = 8;

/** How many nested function results (`const wrap = () => row; wrap()`) one use is followed through before failing closed. */
const MAX_RESULT_DEPTH = 8;

/** What the walk asks of the impl's taint model. */
interface TaintOracle {
    /** Whether `node` sits strictly inside the impl. */
    isInImpl: (node: TsNode) => boolean;
    /** Whether `value` is caller-controlled (see `ImplTaint.isTaintedValue`). */
    isTaintedValue: (value: TsNode, rootedInContext: boolean) => boolean;
    /** The references to `declaration`, spelled `name`, inside the impl. */
    referencesTo: (declaration: TsNode, name: string) => Identifier[];
}

/** One binding queued by the flow walk, with the alias hops spent to reach it. */
interface FlowStep {
    binding: ObjectBinding;
    hops: number;
}

/**
 * Hands the flow walk the next binding an object flows into; `isAlias` counts
 * it against {@link MAX_ALIAS_HOPS}. `true` when that bound is exceeded, which
 * the caller reports as a finding (fail-closed).
 */
type Follow = (next: ObjectBinding, isAlias: boolean) => boolean;

/**
 * Follows an object wherever it flows inside one impl — `const` aliases,
 * destructured elements, `for…of` variables, the parameters of nested
 * functions and iterating callbacks it is handed to — and judges every use.
 * Shares the impl's {@link VerdictBudget}, so a cut in either half keeps the
 * other's verdicts across it provisional.
 */
class CompromiseWalk {
    private readonly budget: VerdictBudget;

    private readonly scope: MutatorImplScope;

    private readonly taint: TaintOracle;

    private readonly verdicts = createVerdictTable();

    public constructor(scope: MutatorImplScope, budget: VerdictBudget, taint: TaintOracle) {
        this.scope = scope;
        this.budget = budget;
        this.taint = taint;
    }

    /**
     * Whether `binding`'s object may hold caller-controlled data stored into it
     * after its initializer: some binding it flows into has a compromising use
     * ({@link flowHasCompromisingUse}). A binding whose type is a primitive
     * cannot be changed in place and never counts.
     */
    public isCompromised(binding: ObjectBinding): boolean {
        return this.flowHasCompromisingUse(binding) && !isPrimitiveType(binding.getType());
    }

    /**
     * Whether any binding `root`'s object flows into — `root` itself, and every
     * binding {@link valueCompromises} hands to `follow`, transitively — has a
     * compromising use. A breadth-first walk over that flow, not a recursion: a
     * recursive helper (`walk(n)` calling `walk(n.child)`) puts its parameter on
     * a cycle, and a recursion would have to leave every verdict on it uncached.
     * Alias hops are bounded by {@link MAX_ALIAS_HOPS} per path, past which
     * the walk fails closed. A binding reached through the flow whose type is a
     * primitive is a copy, so its uses do not count. When nothing is found (and
     * no cut cycle or bound was involved), every binding visited is clean too —
     * its own flow is part of `root`'s — so each is cached as such.
     */
    private flowHasCompromisingUse(root: ObjectBinding): boolean {
        return this.budget.memoized(
            root.compilerNode,
            () => {
                const cutsBefore = this.budget.cuts;
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
                    const known = step.binding === root ? undefined : this.verdicts.verdicts.get(step.binding.compilerNode);

                    found = known ?? this.visitBinding(step, root, enqueue);

                    if (found) {
                        break;
                    }
                }

                if (!found && this.budget.cuts === cutsBefore) {
                    for (const node of seen) {
                        this.verdicts.verdicts.set(node, false);
                    }
                }

                return found;
            },
            this.verdicts,
        );
    }

    /** Expand one binding of {@link flowHasCompromisingUse}: judge its references, or queue a destructured parameter's elements. */
    private visitBinding({ binding, hops }: FlowStep, root: ObjectBinding, enqueue: (binding: ObjectBinding, hops: number) => void): boolean {
        const nameNode = binding.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            // A destructured parameter binds members of what it receives, each an object of its own.
            for (const element of Node.isParameterDeclaration(binding) ? bindingIdentifiersOf(binding) : []) {
                enqueue(element, hops);
            }

            return false;
        }

        if (this.budget.spend()) {
            return true;
        }

        const follow: Follow = (next, isAlias) => {
            if (isAlias && hops >= MAX_ALIAS_HOPS) {
                return this.budget.cut();
            }

            enqueue(next, isAlias ? hops + 1 : hops);

            return false;
        };
        const found = this.taint
            .referencesTo(binding, nameNode.getText())
            .some((reference) => this.valueCompromises(outermostValueWrapper(reference), true, follow, 0));

        return found && (binding === root || !isPrimitiveType(binding.getType()));
    }

    /**
     * Whether one use of the object may store caller-controlled data into it,
     * judged from `start`: a reference to its binding (`isBindingReference`), or
     * the result of a nested function that returns it, judged at each of its
     * call sites. The use is first climbed to where its value ends up
     * ({@link objectContinuation}: member paths, `await`, `??`, `?:`,
     * containers, element-returning methods). Compromising (fail-closed):
     *
     * - a member write of a caller-controlled value (`o.k = args.x`), or any
     * non-assignment write (`delete o.k`, `o.n++`);
     * - a method call on it with a caller-controlled argument (`list.push(args.x)`);
     * - handing it to a call this cannot see into (an import, a method, a
     * parameter, or a same-file function outside the impl) that caller data
     * also reaches — a caller-controlled operand (`merge(user, args)`) or callee
     * (`args.fn(user)`) — the same for a spread argument, a constructor, a tag;
     * - binding it whole to a `let` / assignment, a `throw`, or any position not
     * recognised below.
     *
     * Followed instead: aliases ({@link aliasBindingsOf}), the parameter of a
     * nested function it is handed to, the parameters of an iterating callback
     * over it. Plain reads are not compromising: member reads that end in a
     * read, read-only calls ({@link isReadOnlyCallArgument}), conditions,
     * comparisons and arithmetic, untagged templates, an index, and the impl's
     * own `return`. A member path whose type is a primitive is a copy and never
     * compromising.
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
            return !isBinding && (!Node.isBinaryExpression(parent) || this.taint.isTaintedValue(parent.getRight(), false));
        }

        const aliases = aliasBindingsOf(end);

        if (aliases !== undefined) {
            return aliases.some((alias) => follow(alias, true));
        }

        const method = Node.isPropertyAccessExpression(parent) && parent.getExpression() === end ? parent.getParent() : undefined;

        if (Node.isCallExpression(method) && method.getExpression() === parent) {
            return this.methodCallCompromises(method, follow);
        }

        const returnedFrom = this.nestedReturningFunctionOf(end);

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
     * past {@link MAX_RESULT_DEPTH} nested results, fails closed.
     */
    private resultCompromises(returnedFrom: TsNode, follow: Follow, depth: number): boolean {
        const holder = outermostValueWrapper(returnedFrom).getParent();

        if (depth >= MAX_RESULT_DEPTH) {
            return this.budget.cut();
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

        return this.taint.referencesTo(binding, nameNode.getText()).some((reference) => {
            const callee = outermostValueWrapper(reference);
            const call = callee.getParent();

            return !Node.isCallExpression(call) || call.getExpression() !== callee || this.valueCompromises(call, false, follow, depth + 1);
        });
    }

    /** A method called on the object (`list.push(x)`, `rows.forEach(cb)`): see {@link valueCompromises}. */
    private methodCallCompromises(call: CallExpression, follow: Follow): boolean {
        // A callback (`rows.filter((r) => r.org === args.org)`) reads the object; it stores nothing into it.
        const stored = call.getArguments().filter((argument) => callbackResults(argument) === undefined);

        return stored.some((argument) => this.taint.isTaintedValue(argument, false)) || this.callbackCompromises(call, follow);
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

        return target !== undefined && this.taint.isInImpl(target)
            ? target.getParameters().some((parameter) => follow(parameter, false))
            : this.taint.isTaintedValue(callback, false);
    }

    /** Where the climb of {@link valueCompromises} ends: an argument, an operand, a statement. */
    private positionCompromises(end: TsNode, follow: Follow): boolean {
        const parent = end.getParent();

        if (Node.isCallExpression(parent) && parent.getArguments().includes(end)) {
            return this.argumentCompromises(parent, end, follow);
        }

        const spreadCall = Node.isSpreadElement(parent) ? parent.getParent() : undefined;

        if (parent !== undefined && Node.isCallExpression(spreadCall)) {
            return (
                !isReadOnlyCallArgument(parent, this.scope.context) && this.isOpaqueCallTainted(spreadCall.getExpression(), spreadCall.getArguments(), parent)
            );
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

    /** Handing the object to `call`: see {@link valueCompromises}. */
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
        if (receiver?.kind === "parameter" && target !== undefined && this.taint.isInImpl(target)) {
            return follow(receiver.parameter, false);
        }

        // Anything else — an import, a same-file function outside the impl — only plants caller data that reaches it.
        return this.isOpaqueCallTainted(call.getExpression(), call.getArguments(), value);
    }

    /**
     * Positions where the object is only read: a discarded expression, a `for`
     * initializer, a {@link isReadOperand} position, the object of an element
     * access the member walk did not follow, or the impl's own `return` (the
     * mutation's result, which goes back to the caller unchanged). A `throw`
     * hands it to a `catch`, so it is not one.
     */
    private isReadPosition(end: TsNode): boolean {
        const parent = end.getParent();

        return (
            parent === undefined ||
            Node.isExpressionStatement(parent) ||
            Node.isForStatement(parent) ||
            Node.isElementAccessExpression(parent) ||
            isReadOperand(end) ||
            isSameNode(returningFunctionOf(end), this.scope.impl)
        );
    }

    /**
     * Whether caller data reaches an opaque call: its callee is caller-controlled,
     * or an operand is — any other operand, and `value` itself when it is more
     * than the bare binding (a container also carrying `args`:
     * `merge({ target: row, src: args })`).
     */
    private isOpaqueCallTainted(callee: TsNode, operands: ReadonlyArray<TsNode>, value: TsNode): boolean {
        const carriesMore = !Node.isIdentifier(unwrapExpression(value));

        return (
            this.taint.isTaintedValue(callee, false) ||
            operands.some((operand) => (operand !== value || carriesMore) && this.taint.isTaintedValue(operand, false))
        );
    }

    /** The function nested in the impl whose return value `node` is; `undefined` for the impl's own return or no return. */
    private nestedReturningFunctionOf(node: TsNode): TsNode | undefined {
        const owner = returningFunctionOf(node);

        return isSameNode(owner, this.scope.impl) ? undefined : owner;
    }
}

export { CompromiseWalk };
export type { TaintOracle };
