/**
 * Builds the Lunora-flavored context handed to a workflow body. Node-safe (no
 * `cloudflare:workers` import) so the runner and context assembly are unit
 * testable; the workerd-only `src/do` base class consumes it.
 */
import type {
    ArgsOf,
    FunctionReference,
    RunFunctionOptions,
    WorkflowEventLike,
    WorkflowLogger,
    WorkflowRunContext,
    WorkflowRunFunction,
    WorkflowStepLike,
} from "./types";

/** Strip trailing slashes from an origin so the dispatch path joins cleanly. */
const trimTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

interface RunnerOptions {
    /** Worker `env` — read `LUNORA_ORIGIN_URL` + `LUNORA_ADMIN_TOKEN` at call time. */
    env: Record<string, unknown>;
    /** Injectable fetch (tests); defaults to the global. */
    fetchImpl?: typeof fetch;
}

/**
 * Build a {@link WorkflowRunFunction} that invokes a Lunora function by POSTing
 * to the Worker's `/_lunora/scheduler/dispatch` endpoint — the same path the
 * SchedulerDO and the Queues workpool dispatch through — authenticated with the
 * admin bearer. The parsed JSON body (the function's return value) is resolved;
 * an empty/non-JSON body resolves to `undefined`.
 *
 * Wrap calls in `ctx.step.do(...)` to make them durable + memoized + retried.
 */
const createWorkflowRunner = (options: RunnerOptions): WorkflowRunFunction => {
    const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;

    return async <F extends FunctionReference>(function_: F, args?: ArgsOf<F>, runOptions: RunFunctionOptions = {}): Promise<unknown> => {
        if (typeof fetchImpl !== "function") {
            throw new TypeError("@lunora/workflow: no fetch implementation available — pass fetchImpl or run on a platform with global fetch");
        }

        const origin = options.env.LUNORA_ORIGIN_URL;

        if (typeof origin !== "string" || origin.length === 0) {
            throw new Error("@lunora/workflow: `LUNORA_ORIGIN_URL` must be set on the Worker env so a workflow can call back into Lunora functions");
        }

        const token = options.env.LUNORA_ADMIN_TOKEN;

        if (typeof token !== "string" || token.length === 0) {
            throw new Error("@lunora/workflow: `LUNORA_ADMIN_TOKEN` must be set on the Worker env to authenticate workflow function dispatch");
        }

        const url = `${trimTrailingSlashes(origin)}/_lunora/scheduler/dispatch`;
        const response = await fetchImpl(url, {
            body: JSON.stringify({ args: args ?? {}, functionPath: function_.__lunoraRef, shardKey: runOptions.shardKey }),
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            method: "POST",
        });

        if (!response.ok) {
            throw new Error(`@lunora/workflow: function dispatch failed (${String(response.status)}): ${await response.text()}`);
        }

        const text = await response.text();

        if (text.length === 0) {
            return undefined;
        }

        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    };
};

/** Console-backed logger, prefixed with the workflow name for log correlation. */
const createWorkflowLogger = (exportName: string): WorkflowLogger => {
    const prefix = `[workflow:${exportName}]`;

    /* eslint-disable no-console -- this logger's whole job is to write to the console; the workflow runtime routes it to wrangler tail / Studio. */
    return {
        debug: (message, ...rest) => {
            console.debug(prefix, message, ...rest);
        },
        error: (message, ...rest) => {
            console.error(prefix, message, ...rest);
        },
        info: (message, ...rest) => {
            console.info(prefix, message, ...rest);
        },
        warn: (message, ...rest) => {
            console.warn(prefix, message, ...rest);
        },
    };
    /* eslint-enable no-console */
};

interface RunContextOptions<Params> {
    env: Record<string, unknown>;
    event: WorkflowEventLike<Params>;
    exportName: string;
    fetchImpl?: typeof fetch;
    step: WorkflowStepLike;
}

/** Assemble the {@link WorkflowRunContext} passed to a `defineWorkflow` handler. */
const createWorkflowRunContext = <Params = Record<string, unknown>>(options: RunContextOptions<Params>): WorkflowRunContext<Params> => {
    return {
        env: options.env,
        event: options.event,
        log: createWorkflowLogger(options.exportName),
        params: options.event.payload,
        run: createWorkflowRunner({ env: options.env, fetchImpl: options.fetchImpl }),
        step: options.step,
    };
};

export { createWorkflowLogger, createWorkflowRunContext, createWorkflowRunner };
