/**
 * The celld host across a real two-node fleet.
 *
 * `celld-tck.test.ts` runs the contract suites on one `celld dev` node, which
 * never moves a cell. What a fleet adds is exactly what a single node cannot
 * show: a write through one node is served by the owning node when read
 * through another, and a cell whose owner dies is taken over from the bucket
 * with its acknowledged writes intact. This drives both through the celld
 * host's `ShardKvStore` (the TCK worker's `/fleet` probe).
 *
 * It needs an S3-compatible endpoint that accepts unsigned bucket creation and
 * conditional writes — moto's server in CI — named by
 * `LUNORA_CELLD_S3_ENDPOINT`. On CI a missing endpoint fails rather than
 * skips, so the job cannot go green without the fleet having run.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CapturedProcess } from "./celld-process";
import { celldEnvironment, freePort, pause, pollUntil, runCelld, spawnCaptured, stopCelld, waitUntilServing } from "./celld-process";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.env.LUNORA_CELLD_S3_ENDPOINT;

/** A cell whose owner stopped is taken over once its lease lapses (~10 s); allow several. */
const TAKEOVER_DEADLINE_MS = 60_000;

type FleetNode = CapturedProcess & { directory: string; origin: string };

/** Every node any test started, for teardown. */
const started: FleetNode[] = [];

const credentials = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
    celldEnvironment({
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
        AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
        ...extra,
    });

/** A fresh bucket with the TCK worker deployed to it. */
const deployFleet = async (name: string): Promise<string> => {
    const bucket = `lunora-celld-${name}-${String(Date.now())}`;

    await fetch(`${String(ENDPOINT)}/${bucket}`, { method: "PUT" });
    await runCelld(["deploy", HARNESS_DIR, "--bucket", `s3://${bucket}`, "--endpoint", String(ENDPOINT)], credentials());

    return bucket;
};

const startNode = async (bucket: string, extra: NodeJS.ProcessEnv = {}): Promise<FleetNode> => {
    const port = await freePort();
    const directory = await mkdtemp(join(tmpdir(), "lunora-celld-node-"));
    const captured = spawnCaptured(["--bucket", `s3://${bucket}`, "--endpoint", String(ENDPOINT), "--listen", `127.0.0.1:${String(port)}`], {
        cwd: directory,
        env: credentials(extra),
    });
    const node: FleetNode = { ...captured, directory, origin: `http://127.0.0.1:${String(port)}` };

    started.push(node);
    await waitUntilServing(node.origin, node, 60_000);

    return node;
};

const probe = async (node: FleetNode, name: string, value?: string): Promise<string> => {
    const response = await fetch(`${node.origin}/fleet?name=${name}`, value === undefined ? {} : { body: value, method: "PUT" });

    return response.text();
};

/** Each live node's `owned_cells`, as `celld diagnose` probes them. */
const ownedCells = async (bucket: string): Promise<number[]> => {
    const report = await runCelld(["diagnose", "--json", "--bucket", `s3://${bucket}`, "--endpoint", String(ENDPOINT)], credentials()).catch(String);

    return [...report.matchAll(/owned_cells=(\d+)/gu)].map((match) => Number(match[1]));
};

/** Read through `node` until it answers `expected` — a takeover is not instant. */
const readUntil = async (node: FleetNode, name: string, expected: string): Promise<string> =>
    pollUntil(
        async () => probe(node, name).catch(String),
        (value) => value === expected,
        { deadlineMs: TAKEOVER_DEADLINE_MS, intervalMs: 500 },
    );

const needsEndpoint = ENDPOINT === undefined && process.env.CI === undefined;

const assertEndpoint = (): void => {
    if (ENDPOINT === undefined) {
        throw new Error("LUNORA_CELLD_S3_ENDPOINT is unset — the fleet test needs an S3-compatible endpoint (moto's server in CI)");
    }
};

describe("celld fleet", () => {
    afterAll(async () => {
        for (const node of started) {
            // eslint-disable-next-line no-await-in-loop -- tear down one node at a time
            await stopCelld(node.child);
            // eslint-disable-next-line no-await-in-loop -- tear down one node at a time
            await rm(node.directory, { force: true, recursive: true });
        }
    });

    describe.skipIf(needsEndpoint)("celld host across a two-node fleet", () => {
        const nodes: FleetNode[] = [];

        beforeAll(async () => {
            assertEndpoint();

            const bucket = await deployFleet("fleet");

            nodes.push(await startNode(bucket), await startNode(bucket));
        });

        it("serves a write made through one node when read through another", async () => {
            expect.assertions(2);

            const [first, second] = nodes as [FleetNode, FleetNode];

            await expect(probe(first, "routed", "through-first")).resolves.toBe("stored");
            // The second node does not own the cell; it has to forward to the owner.
            await expect(probe(second, "routed")).resolves.toBe("through-first");
        });

        it("keeps an acknowledged write when the owning node dies, and takes the cell over", async () => {
            expect.assertions(3);

            const [first, second] = nodes as [FleetNode, FleetNode];

            await expect(probe(first, "takeover", "before-crash")).resolves.toBe("stored");

            // Not a drain: the owner vanishes mid-lease, as a crashed machine would.
            first.child.kill("SIGKILL");

            await expect(readUntil(second, "takeover", "before-crash")).resolves.toBe("before-crash");
            // The surviving node now owns the cell and accepts writes to it.
            await expect(probe(second, "takeover", "after-crash")).resolves.toBe("stored");
        });
    });

    /**
     * celld's own balancing: a node that joins takes hibernated cells from the
     * node holding the most, without any traffic for them. Only an idle,
     * hibernated cell moves, so both nodes run with a short idle eviction and
     * sample interval to make that observable in seconds rather than minutes.
     */
    describe.skipIf(needsEndpoint)("celld rebalancing onto a node that joins", () => {
        const CELLS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
        const TUNING = { CELLD_IDLE_EVICT_S: "2", CELLD_REBALANCE_INTERVAL_MS: "1000" };

        it("moves idle cells to the new node, which then serves every value", async () => {
            expect.assertions(2);

            assertEndpoint();

            const bucket = await deployFleet("rebalance");
            const first = await startNode(bucket, TUNING);

            for (const name of CELLS) {
                // eslint-disable-next-line no-await-in-loop -- one write per cell
                await probe(first, name, `value-${name}`);
            }

            // Let the cells go idle and hibernate on the only node.
            await pause(5000);

            const second = await startNode(bucket, TUNING);
            const owned = await pollUntil(
                async () => ownedCells(bucket),
                (counts) => counts.filter((count) => count > 0).length >= 2,
                { deadlineMs: 60_000, intervalMs: 1000 },
            );

            // Both nodes own cells: some moved to the one that joined, unprompted.
            expect(owned.filter((count) => count > 0)).toHaveLength(2);

            const values = [];

            for (const name of CELLS) {
                // eslint-disable-next-line no-await-in-loop -- one read per cell
                values.push(await probe(second, name));
            }

            expect(values).toStrictEqual(CELLS.map((name) => `value-${name}`));
        });
    });
});
