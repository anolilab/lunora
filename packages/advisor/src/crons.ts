/**
 * One `cronJobs()` registration — the input the `cron_every_minute` lint
 * consumes. A structural subset of codegen's `CronJobIR`, so the feeder passes
 * the IR array straight through without conversion (as `AdvisorQueue` does for
 * `QueueIR`). Runtime callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorCron {
    /** The compiled standard five-field cron expression, e.g. `"0 9 * * *"`. */
    cron: string;
    /** The `namespace:fn` the job dispatches; absent when the job starts a workflow. */
    functionPath?: string;
    /** Unique job name. */
    name: string;
    /** Set when each fire starts a workflow instance instead of dispatching a function. */
    workflow?: { exportName: string };
}
