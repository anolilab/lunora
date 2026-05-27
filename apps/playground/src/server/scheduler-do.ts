import type { SchedulerDOState, SchedulerEnv } from "@cirrus/scheduler";
import { SchedulerDO as SchedulerDOBase } from "@cirrus/scheduler";

/**
 * Concrete SchedulerDO for the playground. The base class implements the
 * full alarm-driven dispatch loop; we subclass purely so the binding has a
 * concrete class to point at in `wrangler.jsonc`.
 */
export class SchedulerDO extends SchedulerDOBase {
    public constructor(state: SchedulerDOState, env: SchedulerEnv) {
        super(state, env);
    }
}
