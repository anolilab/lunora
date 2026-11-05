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
import { readProjectWrangler } from "./cloudflare/wrangler-path";

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

/** One hint row; each dev banner lays it out with {@link formatDevBannerRow}. */
interface DevTriggerHint {
    label: "Crons" | "Queues";
    text: string;
}

type TriggerShape = Pick<WranglerConfig, "queues"> & { triggers?: { crons?: unknown } | null };

const stringsOf = (values: unknown): string[] =>
    Array.isArray(values) ? values.filter((value): value is string => typeof value === "string" && value !== "") : [];

/** A cron expression as a `?cron=` value: spaces become `+`, as Cloudflare's own examples write it. */
const cronQuery = (cron: string): string => encodeURIComponent(cron).replaceAll("%20", "+");

const cronHint = (count: number, first: string, options: DevTriggerHintOptions): DevTriggerHint | undefined => {
    const ways = [
        options.studioUrl === undefined ? undefined : `run one now in ${options.studioUrl}/schedule`,
        options.scheduledUrl === undefined ? undefined : `curl "${options.scheduledUrl}?cron=${cronQuery(first)}"`,
    ].filter((way) => way !== undefined);

    return ways.length === 0 ? undefined : { label: "Crons", text: `${String(count)} scheduled → ${ways.join(", or ")}` };
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
    const parsed = readProjectWrangler<TriggerShape>(options.projectRoot)?.parsed;

    if (parsed === undefined) {
        return [];
    }

    const crons = [...new Set(stringsOf(parsed.triggers?.crons))];
    const queueEntries = [...(parsed.queues?.producers ?? []), ...(parsed.queues?.consumers ?? [])];
    const queues = [...new Set(stringsOf(queueEntries.map((entry) => entry?.queue)))];
    const [firstCron] = crons;

    return [
        firstCron === undefined ? undefined : cronHint(crons.length, firstCron, options),
        queues.length === 0 ? undefined : queueHint(queues, options.studioUrl),
    ].filter((hint) => hint !== undefined);
};

/**
 * One `  ➜  Label:  value` banner row, the label padded to `width` (colon
 * included) so the values line up. `style` decorates the arrow and the label
 * after padding, so escape codes never count toward the width — Vite's banner
 * colours both, `lunora dev`'s colours neither. A label wider than `width` gets
 * no padding rather than an error.
 */
const formatDevBannerRow = (
    label: string,
    value: string,
    width: number,
    style: { arrow?: (text: string) => string; label?: (text: string) => string } = {},
): string => {
    const padding = `${label}:`.padEnd(width).slice(label.length);

    return `  ${style.arrow?.("➜") ?? "➜"}  ${style.label?.(label) ?? label}${padding}${value}`;
};

export type { DevTriggerHint, DevTriggerHintOptions };
export { devTriggerHints, formatDevBannerRow };
