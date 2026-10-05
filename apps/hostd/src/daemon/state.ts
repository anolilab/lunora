/**
 * The box's local record of its fleets (plan 458 W4, "Local state"):
 * `{dataDir}/state.json`. The control plane is the source of truth; this file
 * is what `hello.fleets` reports on every connect, what the daemon restarts
 * after a reboot, and which ports each fleet holds.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FleetState, FleetSummary } from "../wire/types";
import { isAlias, isProtocolId } from "../wire/validate";
import { writeFileAtomic } from "./config";

/** One fleet as the box keeps it. */
interface FleetRecord {
    /** The deployment the fleet last ran, once one was deployed into it. */
    deploymentId?: string;
    /** Its loopback peer/operator listener. */
    internalPort: number;
    /** Its loopback Worker listener, which Caddy proxies to. */
    publicPort: number;
    /** `running` once started, `stopped` when stopped on purpose, `failed` when it would not stay up. */
    state: FleetState;
    updatedAt: number;
}

interface HostdState {
    fleets: Record<string, FleetRecord>;
    version: 1;
}

const STATE_FILE = "state.json";

const FLEET_STATES = new Set<FleetState>(["failed", "running", "starting", "stopped"]);

const isPort = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65_536;

/** A fleet record off disk, or `undefined` when it is not one. A malformed entry is dropped, never trusted. */
const readRecord = (value: unknown): FleetRecord | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    const { deploymentId, internalPort, publicPort, state, updatedAt } = record;

    if (!isPort(internalPort) || !isPort(publicPort) || !FLEET_STATES.has(state as FleetState) || typeof updatedAt !== "number") {
        return undefined;
    }

    return { ...(isProtocolId(deploymentId) ? { deploymentId } : {}), internalPort, publicPort, state: state as FleetState, updatedAt };
};

/** The state file of `dataDirectory`; a fresh, empty state when there is none yet. */
const loadState = (dataDirectory: string): HostdState => {
    let raw: unknown;

    try {
        raw = JSON.parse(readFileSync(join(dataDirectory, STATE_FILE), "utf8"));
    } catch {
        return { fleets: {}, version: 1 };
    }

    const fleets: Record<string, FleetRecord> = {};
    const source = typeof raw === "object" && raw !== null ? (raw as { fleets?: unknown }).fleets : undefined;

    for (const [alias, value] of Object.entries(typeof source === "object" && source !== null ? source : {})) {
        const record = readRecord(value);

        if (isAlias(alias) && record !== undefined) {
            fleets[alias] = record;
        }
    }

    return { fleets, version: 1 };
};

/** Persist `state` atomically (mode 0600). */
const saveState = (dataDirectory: string, state: HostdState): void => {
    writeFileAtomic(join(dataDirectory, STATE_FILE), `${JSON.stringify(state, undefined, 4)}\n`, 0o600);
};

/** `hello.fleets`: every fleet the box holds, sorted by alias, capped at the protocol's limit. */
const fleetSummaries = (state: HostdState, limit: number): FleetSummary[] =>
    Object.entries(state.fleets)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .slice(0, limit)
        .map(([alias, record]) => {
            return { alias, ...(record.deploymentId === undefined ? {} : { deploymentId: record.deploymentId }), state: record.state };
        });

export type { FleetRecord, HostdState };
export { fleetSummaries, loadState, saveState };
