/**
 * The architecture diff `lunora deploy` prints beside the schema-drift gate:
 * modules and edges (calls, table reads/writes, enqueues, …) this deploy adds
 * or removes, measured against the manifest the last successful deploy shipped.
 * Informational only — it never blocks.
 *
 * Like the schema baseline, the manifest is recorded only AFTER the deploy
 * succeeds, so a failed deploy keeps diffing against what is actually live.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ArchitectureEdge, ArchitectureManifest } from "../../../../shared/architecture-manifest";
import type { Logger } from "./logger";

/** Lines listed per section before the rest collapse into a count. */
const MAX_LINES = 20;

interface ArchitectureDiff {
    addedEdges: string[];
    addedModules: string[];
    removedEdges: string[];
    removedModules: string[];
}

const edgeLabel = (edge: ArchitectureEdge): string => `${edge.from} -${edge.kind}-> ${edge.to}`;

/** `entries` missing from `base`, sorted. */
const missingFrom = (base: ReadonlyArray<string>, entries: ReadonlyArray<string>): string[] => {
    const known = new Set(base);

    return entries.filter((entry) => !known.has(entry)).toSorted((a, b) => a.localeCompare(b));
};

const diffArchitecture = (previous: ArchitectureManifest, current: ArchitectureManifest): ArchitectureDiff => {
    const previousModules = previous.modules.map((entry) => entry.name);
    const currentModules = current.modules.map((entry) => entry.name);
    const previousEdges = previous.edges.map((edge) => edgeLabel(edge));
    const currentEdges = current.edges.map((edge) => edgeLabel(edge));

    return {
        addedEdges: missingFrom(previousEdges, currentEdges),
        addedModules: missingFrom(previousModules, currentModules),
        removedEdges: missingFrom(currentEdges, previousEdges),
        removedModules: missingFrom(currentModules, previousModules),
    };
};

const renderSection = (marker: string, title: string, entries: ReadonlyArray<string>): string[] => {
    if (entries.length === 0) {
        return [];
    }

    const shown = entries.slice(0, MAX_LINES).map((entry) => `  ${marker} ${entry}`);
    const rest = entries.length - shown.length;

    return [`${title}:`, ...shown, ...(rest > 0 ? [`  … and ${rest.toString()} more`] : [])];
};

/** The printable diff, or `undefined` when nothing changed. */
const formatArchitectureDiff = (diff: ArchitectureDiff): string | undefined => {
    const lines = [
        ...renderSection("+", "modules added", diff.addedModules),
        ...renderSection("-", "modules removed", diff.removedModules),
        ...renderSection("+", "edges added", diff.addedEdges),
        ...renderSection("-", "edges removed", diff.removedEdges),
    ];

    return lines.length === 0 ? undefined : `architecture changes since the last deploy:\n${lines.join("\n")}`;
};

// ponytail: per-checkout baseline under the gitignored `.lunora/`, so a deploy from
// another machine or CI prints no diff the first time. Commit it beside
// `.lunora-schema.json` if teams deploy from several places.
const baselinePath = (cwd: string, environment: string | undefined): string =>
    join(cwd, ".lunora", environment === undefined ? "architecture.json" : `architecture.${environment}.json`);

const readBaseline = (path: string): ArchitectureManifest | undefined => {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        return JSON.parse(readFileSync(path, "utf8")) as ArchitectureManifest;
    } catch {
        // A corrupt baseline only costs this run's diff; the success path overwrites it.
        return undefined;
    }
};

/**
 * Print what this deploy changes in the architecture, and return the thunk that
 * records the current manifest as the new baseline — to be invoked only once the
 * deploy succeeded. `undefined` when the app declares no module.
 */
const reportArchitectureDiff = (options: {
    current: ArchitectureManifest | undefined;
    cwd: string;
    environment: string | undefined;
    logger: Logger;
}): (() => void) | undefined => {
    const { current, cwd, environment, logger } = options;

    if (current === undefined) {
        return undefined;
    }

    const path = baselinePath(cwd, environment);
    const previous = readBaseline(path);
    const message = previous === undefined ? undefined : formatArchitectureDiff(diffArchitecture(previous, current));

    if (message !== undefined) {
        logger.info(message);
    }

    return () => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(current, undefined, 2)}\n`, "utf8");
    };
};

export { diffArchitecture, formatArchitectureDiff, reportArchitectureDiff };
