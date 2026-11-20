/**
 * What the studio says about a project's runtime (`src/project-runtime.ts`) —
 * kept apart from the components so the words are one list the tests read.
 */
import type { ProjectRuntime } from "../project-runtime";
import { PROJECT_RUNTIMES, RUNTIME_LABELS } from "../project-runtime";

/** One choice in a runtime picker. */
export interface RuntimeChoice {
    description: string;
    label: string;
    value: ProjectRuntime;
}

/** The runtimes a project can choose, the default first, each with what it means for the build. */
export const RUNTIME_CHOICES: ReadonlyArray<RuntimeChoice> = PROJECT_RUNTIMES.map((value) => {
    return {
        description:
            value === "lunora"
                ? "Built with the project's own lunora CLI (lunora build)."
                : "A wrangler.json, wrangler.jsonc or wrangler.toml project with no Lunora CLI, built with its own pinned wrangler (wrangler deploy --dry-run).",
        label: RUNTIME_LABELS[value],
        value,
    };
});

/** One thing a plain Cloudflare Worker project does not get, and why. */
export interface RuntimeGap {
    label: string;
    reason: string;
}

/**
 * What only a Lunora app has, for the studio to state on a Cloudflare Worker
 * project instead of offering it and failing: everything that reads the tenant's
 * `/_lunora/admin/*` API or its `ctx.log` events. Empty for a Lunora app.
 */
export const runtimeGaps = (runtime: ProjectRuntime): ReadonlyArray<RuntimeGap> =>
    runtime === "lunora"
        ? []
        : [
              {
                  label: "Backups and restore",
                  reason: "Lunora Cloud snapshots a Lunora app's data through its admin export. A plain Worker's data lives in the bindings it manages itself, so there is nothing for the platform to snapshot.",
              },
              {
                  label: "Data, functions and advisor views",
                  reason: "The studio's data browser, function runner and tenant advisors call a Lunora app's admin API, which a plain Worker does not serve.",
              },
              {
                  label: "Eject",
                  reason: "Eject packages the data export a Lunora app serves; a plain Worker already deploys anywhere wrangler does.",
              },
              {
                  label: "Structured log fields",
                  reason: "Logs show the Worker's console output — level, message and time — but not the function, user and trace fields a Lunora app's ctx.log carries.",
              },
          ];
