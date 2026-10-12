/**
 * The workflow context both suites hand to the app's workflow handlers. The node suite and the workerd
 * suite differ only in how a port call reaches the shard (`run`) and which tombstone store `env` holds,
 * so each passes those two and shares the rest. Not a `.test.ts` file: neither project runs it as a suite.
 */
import type { WorkflowRunContext } from "@lunora/workflow";

/** The in-memory tombstone store: the namespace surface the app's port reads, and the keys it holds. */
interface TombstoneNamespaceDouble {
    readonly get: () => { add: (key: string, erasedAt: number) => Promise<void>; keys: () => Promise<string[]> };
    readonly idFromName: (name: string) => string;
    readonly keys: Map<string, number>;
}

/** An in-memory stand-in for the `PRIVACY_TOMBSTONES` Durable Object. The workerd suite runs the real one. */
const tombstoneNamespace = (): TombstoneNamespaceDouble => {
    const keys = new Map<string, number>();
    const stub = {
        add: async (key: string, erasedAt: number) => {
            keys.set(key, erasedAt);
        },
        keys: async () => [...keys.keys()],
    };

    return { get: () => stub, idFromName: (name: string) => name, keys };
};

/** What a test can observe of, and do during, a workflow run. */
interface RunHooks {
    /** Runs while the workflow sleeps through the grace window, as a subject's cancel would. */
    readonly duringSleep?: () => Promise<void>;
    /** Every step the run reached, in order; a durable sleep reads as `sleep:<name>`. */
    readonly steps?: string[];
}

/** How a step's `ctx.run` reaches the app's internal `privacyPort` mutation in one suite. */
type PortRun = (reference: unknown, args: { method: string; payload: string }) => Promise<unknown>;

interface WorkflowContextOptions<Params> {
    readonly env: Record<string, unknown>;
    readonly params: Params;
    readonly run: PortRun;
}

/**
 * A workflow context over a suite's shard. `step.do` runs its callback at once, since the tests have
 * no durable replay, and `step.sleepUntil` returns at once after running the `duringSleep` hook.
 */
const workflowContext = <Params>({ env, params, run }: WorkflowContextOptions<Params>, hooks: RunHooks = {}): WorkflowRunContext<Params> => {
    const step = {
        do: async (name: string, callback: () => Promise<unknown>) => {
            hooks.steps?.push(name);

            return callback();
        },
        sleepUntil: async (name: string) => {
            hooks.steps?.push(`sleep:${name}`);
            await hooks.duringSleep?.();
        },
    };

    // The suites have no durable runner, so these doubles stand in for the platform's context.
    return { env, params, run, step } as unknown as WorkflowRunContext<Params>;
};

export type { RunHooks };
export { tombstoneNamespace, workflowContext };
