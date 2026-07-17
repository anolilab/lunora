import type { Telemetry } from "ai";

/**
 * A fan-out value callback: awaits every provided callback (guarding
 * `undefined`) for one event. Written with an `unknown` event parameter so it
 * is assignable to any concrete callback slot on {@link Telemetry} (an
 * `(event: unknown) => …` is a supertype of `(event: E) => …`).
 *
 * Each callback runs inside its own async thunk and results are awaited with
 * `Promise.allSettled`, mirroring the SDK's own merge semantics so per
 * integration fault isolation is preserved: a synchronous throw or a rejection
 * in one integration can neither abort the fan-out to the siblings nor make the
 * combined callback throw or reject. The execution wrappers below intentionally
 * do not use this helper, since they must surface `execute`'s own failures.
 */
const fanOut =
    <E>(callbacks: ReadonlyArray<((event: E) => PromiseLike<void> | void) | undefined>) =>
    async (event: E): Promise<void> => {
        await Promise.allSettled(callbacks.map(async (callback) => callback?.(event)));
    };

/**
 * Options shape the composed execution wrappers operate on. `callId` and
 * `toolCallId` are kept required so that both {@link Telemetry.executeTool}
 * (which needs `toolCallId`) and {@link Telemetry.executeLanguageModelCall}
 * (which does not) satisfy the `W extends ExecuteWrapperLike` constraint below;
 * the extra key is harmless for the language-model wrapper.
 */
type ExecuteWrapperOptions<T> = Record<string, unknown> & {
    readonly callId: string;
    readonly execute: () => PromiseLike<T>;
    readonly toolCallId: string;
};

/** Structural supertype of the two {@link Telemetry} execution wrappers. */
type ExecuteWrapperLike = <T>(options: ExecuteWrapperOptions<T>) => PromiseLike<T>;

/**
 * Compose a list of (possibly-`undefined`) execution wrappers into one wrapper
 * by nesting: the wrappers are applied right-to-left so the first integration
 * ends up outermost and the last innermost around the real `execute`.
 * Integrations that do not define the wrapper are skipped; when none define it
 * the composition collapses to the identity and `execute` runs directly.
 */
const composeWrappers = <W extends ExecuteWrapperLike>(wrappers: ReadonlyArray<W | undefined>): W => {
    const defined: ReadonlyArray<ExecuteWrapperLike> = wrappers.filter((wrapper): wrapper is W => typeof wrapper === "function");

    const combined: ExecuteWrapperLike = <T>(options: ExecuteWrapperOptions<T>): PromiseLike<T> => {
        let composed: () => PromiseLike<T> = options.execute;

        for (const wrapper of defined.toReversed()) {
            const inner = composed;

            composed = () => wrapper({ ...options, execute: inner });
        }

        return composed();
    };

    return combined as W;
};

/**
 * Combine several {@link Telemetry} integrations into a single one that fans
 * every lifecycle callback out to all of them and nests the two execution
 * wrappers so multiple span-context wrappers compose correctly.
 *
 * Value callbacks (`onStart`, `onStepEnd`, `onToolExecutionEnd`, …) invoke each
 * integration's matching callback (guarding `undefined`) and await them all in
 * parallel. The wrappers (`executeLanguageModelCall`, `executeTool`) are
 * composed by nesting right-to-left; integrations without a wrapper are skipped,
 * and with none defined the plain `execute` still runs.
 * @experimental
 */
// eslint-disable-next-line import/prefer-default-export -- named export: the package barrel re-exports by name, per the repo's no-default-mixing convention
export const combineTelemetry = (...integrations: Telemetry[]): Telemetry => {
    return {
        executeLanguageModelCall: composeWrappers(integrations.map((integration) => integration.executeLanguageModelCall)),
        executeTool: composeWrappers(integrations.map((integration) => integration.executeTool)),
        onAbort: fanOut(integrations.map((integration) => integration.onAbort)),
        onEmbedEnd: fanOut(integrations.map((integration) => integration.onEmbedEnd)),
        onEmbedStart: fanOut(integrations.map((integration) => integration.onEmbedStart)),
        onEnd: fanOut(integrations.map((integration) => integration.onEnd)),
        onError: fanOut(integrations.map((integration) => integration.onError)),
        onLanguageModelCallEnd: fanOut(integrations.map((integration) => integration.onLanguageModelCallEnd)),
        onLanguageModelCallStart: fanOut(integrations.map((integration) => integration.onLanguageModelCallStart)),
        // eslint-disable-next-line sonarjs/deprecation -- deprecated in the ai@7 type but still actively dispatched (dist onObjectStepEnd fan-out); combine must not drop an integration's callback
        onObjectStepEnd: fanOut(integrations.map((integration) => integration.onObjectStepEnd)),
        // eslint-disable-next-line sonarjs/deprecation -- deprecated in the ai@7 type but still actively dispatched (dist onObjectStepStart fan-out); combine must not drop an integration's callback
        onObjectStepStart: fanOut(integrations.map((integration) => integration.onObjectStepStart)),
        onRerankEnd: fanOut(integrations.map((integration) => integration.onRerankEnd)),
        onRerankStart: fanOut(integrations.map((integration) => integration.onRerankStart)),
        onStart: fanOut(integrations.map((integration) => integration.onStart)),
        onStepEnd: fanOut(integrations.map((integration) => integration.onStepEnd)),
        // eslint-disable-next-line sonarjs/deprecation -- deprecated alias of onStepEnd but ai@7 still fans step-end events to it (dist onStepEnd → onStepFinish); combine must not drop an integration's callback
        onStepFinish: fanOut(integrations.map((integration) => integration.onStepFinish)),
        onStepStart: fanOut(integrations.map((integration) => integration.onStepStart)),
        onToolExecutionEnd: fanOut(integrations.map((integration) => integration.onToolExecutionEnd)),
        onToolExecutionStart: fanOut(integrations.map((integration) => integration.onToolExecutionStart)),
    };
};
