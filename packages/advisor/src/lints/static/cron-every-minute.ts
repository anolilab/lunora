import type { AdvisorCron } from "../../crons";
import emit from "../../finding";
import type { Lint } from "../../types";

/** The minute-field spellings that mean "every minute", including a step of 1 and the full range. */
const EVERY_MINUTE_FIELD = /^(?:\*|\*\/1|0-59|0-59\/1)$/;

const WHITESPACE = /\s+/;

/**
 * Whether a five-field cron expression fires on every minute: an every-minute
 * minute field with every other field unrestricted. Anything but five fields is
 * not judged — Cloudflare Cron Triggers reject the rest.
 */
const firesEveryMinute = (expression: string): boolean => {
    const fields = expression.trim().split(WHITESPACE);
    const [minute, ...rest] = fields;

    return fields.length === 5 && EVERY_MINUTE_FIELD.test(minute as string) && rest.every((field) => field === "*");
};

/** What one fire runs, in the words the finding uses. */
const targetOf = (job: AdvisorCron): string =>
    job.workflow === undefined ? (job.functionPath ?? "its target") : `a new instance of workflow "${job.workflow.exportName}"`;

/**
 * Flags a cron job that fires every minute — the fastest cadence a Cloudflare
 * Cron Trigger allows (1,440 fires a day, about 43,200 a month).
 *
 * Every fire is a Worker `scheduled()` invocation that dispatches its target, so
 * the cost is paid whether or not there was work: a Worker request, the
 * Durable Object request behind the dispatch, and whatever rows the target
 * reads to discover it has nothing to do. A job that starts a workflow creates a
 * new instance each minute. That is often the intended polling cadence, hence
 * `INFO`: a prompt to confirm the cadence, not a defect.
 *
 * Only runs when the codegen feeder supplied cron evidence (`context.crons`
 * present); a runtime caller flags nothing.
 */
const cronEveryMinute: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A cron job fires every minute, the fastest cadence Cloudflare Cron Triggers allow. Each fire is a Worker invocation plus a dispatch to its target (a Durable Object request, or a new workflow instance), billed whether or not there was work to do.",
    facing: "INTERNAL",
    level: "INFO",
    name: "cron_every_minute",
    remediation:
        "Confirm the cadence is needed. If the job only reacts to new work, drop it to a coarser interval, or replace the poll with `ctx.scheduler.runAfter(…)` armed by the write that creates the work. Whatever the cadence, make the target return early on an indexed read when there is nothing to do.",
    run: (context) =>
        (context.crons ?? [])
            .filter((job) => firesEveryMinute(job.cron))
            .map((job) =>
                emit(cronEveryMinute, {
                    cacheKey: `cron_every_minute:${job.name}`,
                    detail: `Cron job "${job.name}" (\`${job.cron}\`) fires every minute — about 43,200 invocations a month, each dispatching ${targetOf(job)} whether or not there is work.`,
                    metadata: { cron: job.cron, job: job.name },
                }),
            ),
    source: "static",
    title: "Cron job fires every minute",
};

export default cronEveryMinute;
