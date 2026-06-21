import type { SchedulerDOState, SchedulerEnv } from "@lunora/scheduler";
import { SchedulerDO as SchedulerDOBase } from "@lunora/scheduler";

/**
 * Concrete SchedulerDO subclass. The base class implements alarm-driven
 * dispatch; we subclass purely so `wrangler.jsonc` has a class name to
 * point the `SCHEDULER` binding at.
 */
export class SchedulerDO extends SchedulerDOBase {
    public constructor(state: SchedulerDOState, env: SchedulerEnv) {
        super(state, env);
    }
}
