/**
 * `vis generate lunora-cron` — add a code-first cron job to lunora/crons.ts.
 *
 * If crons.ts doesn't exist yet we write a fresh one from a template. If it
 * does, we use ts-morph (via `_helpers/insert-cron.ts`) to AST-edit the
 * existing file — appending one more `crons.<kind>(...)` registration after the
 * last one so the `export default crons`, comments and formatting survive.
 *
 * The generated registration uses the `crons.interval(...)` form as a starting
 * point; swap it for `crons.daily` / `crons.weekly` / `crons.monthly` /
 * `crons.cron` and point it at a real `internal.<file>.<fn>` reference.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTemplate } from "@visulima/vis/generate";

import { insertCronJob } from "./_helpers/insert-cron.js";

const freshCrons = (jobName: string): string => `import { cronJobs } from "@lunora/scheduler";

import { internal } from "./_generated/api.js";

/**
 * Code-first cron registry. Each registration runs the referenced internal
 * function on the given schedule. \`@lunora/codegen\` discovers this default
 * export and emits the wrangler triggers plus the dispatcher map — you never
 * edit wrangler.jsonc by hand.
 *
 * Schedule forms:
 *   crons.interval(name, { minutes: 30 }, fn, args)            // every N seconds/minutes/hours (hours: 1-23)
 *   crons.hourly(name, { minuteUTC: 17 }, fn, args)            // hourly, at a chosen minute past the hour
 *   crons.daily(name, { hourUTC: 9, minuteUTC: 0 }, fn, args)  // daily at a UTC time
 *   crons.weekly(name, { dayOfWeek: "monday", hourUTC: 9, minuteUTC: 0 }, fn, args)
 *   crons.monthly(name, { day: 1, hourUTC: 9, minuteUTC: 0 }, fn, args)
 *   crons.cron(name, "0 9 * * 1L", fn, args)                   // raw cron escape hatch (full cron-parser grammar)
 *
 * The target can be an \`internal.<file>.<fn>\` function reference (one-shot
 * dispatch) OR a durable workflow via the generated \`workflows.<name>\`
 * reference — targeting a workflow starts a fresh, multi-step, retried instance
 * on each fire (the args, type-checked against the workflow's \`params\`, become
 * its \`params\`):
 *   import { workflows } from "./_generated/api.js";
 *   crons.daily(name, { hourUTC: 9, minuteUTC: 0 }, workflows.digestPipeline, args)
 */
const crons = cronJobs();

crons.interval("${jobName}", { minutes: 60 }, internal.example.run, {});

export default crons;
`;

export default createTemplate({
    about: {
        description: "Add a cron job to lunora/crons.ts (creates the file if missing)",
        name: "lunora-cron",
    },
    options: {
        name: {
            prompt: "Cron job name (human-readable; must be unique within crons.ts)",
            required: true,
            type: "string",
        },
    },
    produce: ({ builtins, options }) => {
        const raw = String(options.name).trim();

        if (raw === "") {
            throw new Error(`invalid cron job name: name must be a non-empty string`);
        }

        const cronsPath = join(builtins.dest_dir, "lunora", "crons.ts");

        if (!existsSync(cronsPath)) {
            return {
                files: { lunora: { "crons.ts": freshCrons(raw) } },
                suggestions: [
                    `Created lunora/crons.ts with job "${raw}".`,
                    `Point the registration at a real internal.<file>.<fn> reference, then run \`lunora codegen\`.`,
                ],
            };
        }

        const original = readFileSync(cronsPath, "utf8");
        const result = insertCronJob(original, raw);

        if (!result.ok) {
            if (result.reason === "duplicate") {
                throw new Error(`cron job "${raw}" already exists in ${cronsPath} — pick a different name.`);
            }

            throw new Error(
                `cannot edit ${cronsPath}: no \`const crons = cronJobs()\` registry found. Re-run with a fresh file or add the registration manually.`,
            );
        }

        return {
            files: { lunora: { "crons.ts": result.text } },
            filesMeta: { "lunora/crons.ts": { force: true } },
            suggestions: [
                `Added cron job "${raw}" to lunora/crons.ts.`,
                `Edit the schedule/target, then run \`lunora codegen\` to regenerate the wrangler triggers.`,
            ],
        };
    },
});
