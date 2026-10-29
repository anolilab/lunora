import type { AgentBindingSpec } from "./types";

type ScheduleCall = (when: number, target: unknown, args?: unknown, options?: Record<string, unknown>) => Promise<string>;

/**
 * The shard DO's `ctx.scheduler`, with every agent target stamped with the scheduling
 * shard (`RunOptions.shardKey`) unless the app named one. A function job only lands on a
 * shard the app names, but a scheduled agent run is the same act as `ctx.agents.<name>.run`
 * from this shard, so its tools read this tenant's data like an immediate run's do. The
 * stamp travels on the scheduler record, which the worker trusts over the job's args
 * (`WorkerOptions.agentWorkflows`); it is applied before the deferral facade buffers the
 * call, so an outbox retry replays it.
 * @experimental
 */
const withAgentScheduleShard = <S extends object>(scheduler: S, specs: ReadonlyArray<AgentBindingSpec>, shardKey: string): S => {
    const agentClasses = new Set(specs.map((spec) => spec.className));
    const isAgentTarget = (target: unknown): boolean => {
        const className = (target as { className?: unknown } | null)?.className;

        return typeof target === "object" && typeof className === "string" && agentClasses.has(className);
    };

    return new Proxy(scheduler, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;

            if ((property !== "runAfter" && property !== "runAt") || typeof value !== "function") {
                return value;
            }

            const schedule = value as ScheduleCall;

            return async (when: number, scheduled: unknown, args?: unknown, options?: Record<string, unknown>): Promise<string> => {
                const stamped = isAgentTarget(scheduled) ? { ...options, shardKey: options?.["shardKey"] ?? shardKey } : options;

                return Reflect.apply(schedule, target, [when, scheduled, args, stamped]);
            };
        },
    });
};

export default withAgentScheduleShard;
