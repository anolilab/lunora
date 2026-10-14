import emit from "../../finding";
import type { Lint } from "../../types";

/** An idle window longer than this keeps a finished instance running, and billed, for an hour or more. */
const LONG_IDLE_SECONDS = 60 * 60;

const DURATION_UNIT_SECONDS: Readonly<Record<string, number>> = { h: 3600, m: 60, s: 1 };

/** The `<digits><s|m|h>` grammar `defineContainer` validates for `sleepAfter` and `hardTimeout`. */
const DURATION = /^(\d+)([smh])$/u;

/**
 * A `sleepAfter` / `hardTimeout` value in seconds: a number is seconds, a string follows
 * {@link DURATION}. `undefined` for anything else, so an unreadable value is never flagged.
 */
const durationSeconds = (value: number | string): number | undefined => {
    if (typeof value === "number") {
        return value;
    }

    const match = DURATION.exec(value);

    if (match === null) {
        return undefined;
    }

    const [, digits = "0", unit = "s"] = match;

    return Number(digits) * (DURATION_UNIT_SECONDS[unit] ?? 1);
};

/**
 * Flags a container whose idle window is longer than an hour. An instance that stops
 * receiving work keeps running, and billed, until `sleepAfter` elapses, so a long
 * window is a standing cost for every idle instance. The window an instance can really
 * idle for is the shorter of `sleepAfter` and `hardTimeout`, since `hardTimeout` stops
 * the instance however active it is. The check uses that effective window.
 *
 * A `sleepAfter` that was not a static literal, or that was omitted (the platform's
 * 10 minute default), is not flagged. Runs only when the codegen feeder supplied the
 * container declarations, so a runtime caller flags nothing.
 */
const containerLongSleepAfter: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A container's idle window (its `sleepAfter`, capped by any `hardTimeout`) is longer than an hour, so every idle instance keeps running, and billed, for that whole window.",
    facing: "INTERNAL",
    level: "WARN",
    name: "container_long_sleep_after",
    remediation:
        "Lower `sleepAfter` to the idle window the workload needs (the default is 10m), or add a `hardTimeout` that caps how long an instance may live.",
    run: (context) => {
        const findings = [];

        for (const container of context.containers ?? []) {
            const { hardTimeout, sleepAfter } = container;

            if (sleepAfter === undefined) {
                continue;
            }

            const idle = durationSeconds(sleepAfter);

            if (idle === undefined) {
                continue;
            }

            const cap = hardTimeout === undefined ? undefined : durationSeconds(hardTimeout);
            const effective = cap === undefined ? idle : Math.min(idle, cap);

            if (effective <= LONG_IDLE_SECONDS) {
                continue;
            }

            findings.push(
                emit(containerLongSleepAfter, {
                    cacheKey: `container_long_sleep_after:${container.exportName}`,
                    detail: `Container "${container.exportName}" can sit idle for ${effective.toString()} s before it sleeps (sleepAfter ${String(sleepAfter)}${cap === undefined ? "" : `, capped by hardTimeout ${String(hardTimeout)}`}); every idle instance is billed for that whole window.`,
                    metadata: { container: container.exportName, effectiveIdleSeconds: effective, hardTimeout, sleepAfter },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Long container idle window",
};

export default containerLongSleepAfter;
