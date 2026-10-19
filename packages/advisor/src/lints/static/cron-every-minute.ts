import { parse } from "@visulima/cron-parser/cloudflare";

import type { AdvisorCron } from "../../crons";
import emit from "../../finding";
import type { Lint } from "../../types";

const WHITESPACE = /\s+/;

/**
 * How a five-field cron expression fires every minute: `"always"` when no field
 * restricts it, `"windowed"` when only the minute field is unrestricted and the
 * hour, day or month limits it (`* 9-17 * * 1-5`), `undefined` otherwise.
 *
 * Fields are judged by the values they permit, read through the same parser the
 * scheduler validates with, so a list (`0-29,30-59`), a step or a name counts the
 * same as the spelling it equals. Anything but five fields is not judged, and
 * neither is an expression the parser rejects — Cloudflare Cron Triggers reject both.
 */
const everyMinuteKind = (expression: string): "always" | "windowed" | undefined => {
    const text = expression.trim();

    if (text.split(WHITESPACE).length !== 5) {
        return undefined;
    }

    try {
        const { dayOfMonth, dayOfWeek, hour, minute, month } = parse(text).fields;

        if (minute.values.length !== 60) {
            return undefined;
        }

        return hour.values.length === 24 && dayOfMonth.values.length === 31 && month.values.length === 12 && dayOfWeek.values.length === 7
            ? "always"
            : "windowed";
    } catch {
        return undefined;
    }
};

/** What one fire runs, in the words the finding uses. */
const targetOf = (job: AdvisorCron): string =>
    job.workflow === undefined ? (job.functionPath ?? "its target") : `a new instance of workflow "${job.workflow.exportName}"`;

/**
 * Flags a cron job that fires every minute — the fastest cadence a Cloudflare
 * Cron Trigger allows (1,440 fires a day, about 43,200 a month). A schedule that
 * runs every minute only inside a window still polls once a minute while it is
 * open, so it is flagged too, without the all-day monthly figure.
 *
 * Every fire is a Worker `scheduled()` invocation that dispatches its target, so
 * the cost is paid whether or not there was work: a Worker request (shared by
 * every job on the same expression — codegen emits one trigger per distinct
 * expression), the Durable Object request behind each dispatch, and whatever
 * rows the target reads to discover it has nothing to do. A job that starts a workflow creates a
 * new instance each minute. That is often the intended polling cadence, hence
 * `INFO`: a prompt to confirm the cadence, not a defect.
 *
 * Only runs when the codegen feeder supplied cron evidence (`context.crons`
 * present); a runtime caller flags nothing.
 */
const cronEveryMinute: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A cron job fires every minute, the fastest cadence Cloudflare Cron Triggers allow. Each fire is a Worker invocation (shared by jobs on the same schedule) plus a dispatch to its target (a Durable Object request, or a new workflow instance), billed whether or not there was work to do.",
    facing: "INTERNAL",
    level: "INFO",
    name: "cron_every_minute",
    remediation:
        "Confirm the cadence is needed. If the job only reacts to new work, drop it to a coarser interval, or replace the poll with `ctx.scheduler.runAfter(…)` armed by the write that creates the work. Whatever the cadence, make the target return early on an indexed read when there is nothing to do.",
    run: (context) =>
        (context.crons ?? []).flatMap((job) => {
            const kind = everyMinuteKind(job.cron);

            if (kind === undefined) {
                return [];
            }

            const cadence =
                kind === "always"
                    ? `fires every minute — about 43,200 dispatches a month of ${targetOf(job)}`
                    : `fires every minute while its window is open, dispatching ${targetOf(job)} once a minute`;

            return [
                emit(cronEveryMinute, {
                    cacheKey: `cron_every_minute:${job.name}`,
                    detail: `Cron job "${job.name}" (\`${job.cron}\`) ${cadence}, whether or not there is work. Jobs on the same schedule share one Worker invocation.`,
                    metadata: { cron: job.cron, job: job.name, window: kind === "windowed" },
                }),
            ];
        }),
    source: "static",
    title: "Cron job fires every minute",
};

export default cronEveryMinute;
