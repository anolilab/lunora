/**
 * The Lunora pail reporter — one renderer for the whole CLI and the Vite plugin.
 *
 * It paints every log line in the create-astro-style badged look defined in
 * `./tui-theme`: a colored ` level ` / ` step ` badge box followed by the
 * message, with continuation lines (and dimmed step answers) indented to align
 * under it. There are no timestamps, scope tags, or dotted fills — just the
 * badge + text — so the standard `info`/`warn`/`error`/`success` output matches
 * the `init` flow's step transcript.
 *
 * It is duck-typed to pail's reporter surface (a `log(meta)` method plus optional
 * stream/state setters) so it can be passed to `createPail` without importing
 * pail — keeping `@lunora/config` free of a pail dependency.
 */
import type { BadgeName, BadgeSpec } from "./tui-theme";
import { BADGES, badgeWidth, paintBadge } from "./tui-theme";

/** Minimal view of a pail meta object — only the fields we render. */
interface ReporterMeta {
    context?: unknown[];
    message: unknown;
    type: { level?: string; name: string };
}

/** Type names (and a couple of aliases) that map onto a badge. */
const NAME_ALIASES: Record<string, BadgeName> = {
    informational: "info",
    warning: "warn",
};

/** Levels that belong on stderr; everything else goes to stdout. */
const STDERR_LEVELS = new Set(["alert", "critical", "emergency", "error", "warn", "warning"]);

const resolveBadge = (name: string): BadgeSpec | undefined => {
    if (name in BADGES) {
        return BADGES[name as BadgeName];
    }

    const alias = NAME_ALIASES[name];

    return alias === undefined ? undefined : BADGES[alias];
};

/** Render a single context arg appended to a line (Errors show their stack). */
const renderContextArgument = (value: unknown): string => {
    if (value instanceof Error) {
        return `\n${value.stack ?? value.message}`;
    }

    if (typeof value === "object" && value !== null) {
        try {
            return ` ${JSON.stringify(value)}`;
        } catch {
            return " [unserializable]";
        }
    }

    return ` ${String(value)}`;
};

/**
 * Build the full text for a line: the (string-coerced) message plus any extra
 * context args. Kept separate from badge framing so the indent math is simple.
 */
const composeMessage = (meta: ReporterMeta): string => {
    const base = typeof meta.message === "string" ? meta.message : String(meta.message);
    const context = meta.context ?? [];

    return context.length === 0 ? base : base + context.map((value) => renderContextArgument(value)).join("");
};

export default class LunoraReporter {
    #stdout: NodeJS.WriteStream = process.stdout;

    #stderr: NodeJS.WriteStream = process.stderr;

    public setStdout(stdout: NodeJS.WriteStream): void {
        this.#stdout = stdout;
    }

    public setStderr(stderr: NodeJS.WriteStream): void {
        this.#stderr = stderr;
    }

    // Note: pail's other reporter setters (setLoggerTypes / setInteractiveManager /
    // setIsInteractive) are optional and intentionally omitted — this reporter keeps
    // no type or interactive state; it only needs the two stream setters above.

    public log(meta: unknown): void {
        const data = meta as ReporterMeta;
        const badge = resolveBadge(data.type.name);
        const stream = STDERR_LEVELS.has(data.type.level ?? data.type.name) ? this.#stderr : this.#stdout;

        stream.write(LunoraReporter.#render(badge, composeMessage(data)));
    }

    /**
     * Frame `text` under `badge`: `<badge> <first line>`, with any further lines
     * indented to align beneath the message. Without a badge (unknown type) the
     * message is written plain.
     */
    static #render(badge: BadgeSpec | undefined, text: string): string {
        if (badge === undefined) {
            return `${text}\n`;
        }

        const [first = "", ...rest] = text.split("\n");
        const indent = " ".repeat(badgeWidth(badge) + 1);
        const lines = [`${paintBadge(badge)} ${first}`, ...rest.map((line) => `${indent}${line}`)];

        return `${lines.join("\n")}\n`;
    }
}
