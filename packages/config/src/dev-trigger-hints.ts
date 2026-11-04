/**
 * The dev-start pointers to the manual triggers for cron jobs and queues.
 *
 * Neither fires on its own in a dev session — a cron waits for its schedule and a
 * queue consumer for a message — so a project that declares them has nothing to
 * look at until it finds the Studio's "Run now" and "send test message" controls.
 * Read off `wrangler.jsonc` rather than the codegen IR because that is what the
 * dev worker actually booted with: codegen syncs `triggers.crons` and the queue
 * reconcile writes `queues.*` before the worker starts.
 */
import type { WranglerConfig } from "./cloudflare/wrangler-config";
import { findWranglerFile, readWranglerJsonc } from "./cloudflare/wrangler-path";

/** How many queue names a hint lists before it summarizes the rest. */
const LISTED_QUEUES = 3;

interface DevTriggerHintOptions {
    projectRoot: string;

    /**
     * The dev worker's scheduled-trigger endpoint (no query), when the dev server
     * exposes one, for a ready-to-run `curl`. Omitted, the cron hint names only
     * the Studio page.
     */
    scheduledUrl?: string;

    /** The Studio's root URL (`…/__lunora`), or `undefined` when it is not served. */
    studioUrl?: string;
}

/** One hint row; each dev banner formats the label its own way. */
interface DevTriggerHint {
    label: "Crons" | "Queues";
    text: string;
}

type TriggerShape = Pick<WranglerConfig, "queues"> & { triggers?: { crons?: unknown } | null };

const stringsOf = (values: unknown): string[] =>
    Array.isArray(values) ? values.filter((value): value is string => typeof value === "string" && value !== "") : [];

const readTriggerShape = (projectRoot: string): TriggerShape | undefined => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (wranglerPath === undefined) {
        return undefined;
    }

    try {
        return readWranglerJsonc<TriggerShape>(wranglerPath).parsed;
    } catch {
        return undefined;
    }
};

/** A cron expression as a `?cron=` value: spaces become `+`, as Cloudflare's own examples write it. */
const cronQuery = (cron: string): string => encodeURIComponent(cron).replaceAll("%20", "+");

const cronHint = (crons: ReadonlyArray<string>, options: DevTriggerHintOptions): DevTriggerHint | undefined => {
    const ways: string[] = [];

    if (options.studioUrl !== undefined) {
        ways.push(`run one now in ${options.studioUrl}/schedule`);
    }

    if (options.scheduledUrl !== undefined) {
        ways.push(`curl "${options.scheduledUrl}?cron=${cronQuery(crons[0] as string)}"`);
    }

    if (ways.length === 0) {
        return undefined;
    }

    return { label: "Crons", text: `${String(crons.length)} scheduled → ${ways.join(", or ")}` };
};

const queueHint = (queues: ReadonlyArray<string>, studioUrl: string | undefined): DevTriggerHint | undefined => {
    if (studioUrl === undefined) {
        return undefined;
    }

    const listed = queues.slice(0, LISTED_QUEUES).join(", ");
    const more = queues.length > LISTED_QUEUES ? ` +${String(queues.length - LISTED_QUEUES)} more` : "";

    return { label: "Queues", text: `${listed}${more} → send a test message in ${studioUrl}/queues` };
};

/**
 * The hint rows for the project's crons and queues — empty when it declares
 * neither, when `wrangler.jsonc` is missing or unparseable, or when there is no
 * surface to point at. Never throws: it only decorates a startup banner.
 */
const devTriggerHints = (options: DevTriggerHintOptions): DevTriggerHint[] => {
    const parsed = readTriggerShape(options.projectRoot);

    if (parsed === undefined) {
        return [];
    }

    const crons = [...new Set(stringsOf(parsed.triggers?.crons))];
    const queueEntries = [...(parsed.queues?.producers ?? []), ...(parsed.queues?.consumers ?? [])];
    const queues = [...new Set(stringsOf(queueEntries.map((entry) => entry?.queue)))];
    const hints: DevTriggerHint[] = [];
    const cron = crons.length > 0 ? cronHint(crons, options) : undefined;
    const queue = queues.length > 0 ? queueHint(queues, options.studioUrl) : undefined;

    if (cron !== undefined) {
        hints.push(cron);
    }

    if (queue !== undefined) {
        hints.push(queue);
    }

    return hints;
};

export type { DevTriggerHint, DevTriggerHintOptions };
export { devTriggerHints };
