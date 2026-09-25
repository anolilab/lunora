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
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { celldEnvironment, freePort, pause, stopCelld } from "./celld-process";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const CELLD = process.env.LUNORA_CELLD_BIN ?? "celld";
const ENDPOINT = process.env.LUNORA_CELLD_S3_ENDPOINT;

/** A cell whose owner stopped is taken over once its lease lapses (~10 s); allow several. */
const TAKEOVER_DEADLINE_MS = 60_000;

type FleetNode = { directory: string; origin: string; output: string; process: ChildProcess };

/** Every node any test started, for teardown. */
const started: FleetNode[] = [];

const credentials = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
    celldEnvironment({
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
        AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
        ...extra,
    });

const run = async (args: ReadonlyArray<string>): Promise<string> =>
    new Promise((resolve, reject) => {
        const child = spawn(CELLD, args, { env: credentials(), stdio: ["ignore", "pipe", "pipe"] });
        let output = "";

        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`celld ${args.join(" ")} exited ${String(code)}:\n${output}`));
            }
        });
    });

/** A fresh bucket with the TCK worker deployed to it. */
const deployFleet = async (name: string): Promise<string> => {
    const bucket = `lunora-celld-${name}-${String(Date.now())}`;

    await fetch(`${String(ENDPOINT)}/${bucket}`, { method: "PUT" });
    await run(["deploy", HARNESS_DIR, "--bucket", `s3://${bucket}`, "--endpoint", String(ENDPOINT)]);

    return bucket;
};

const startNode = async (bucket: string, extra: NodeJS.ProcessEnv = {}): Promise<FleetNode> => {
    const port = await freePort();
    const directory = await mkdtemp(join(tmpdir(), "lunora-celld-node-"));
    const child = spawn(CELLD, ["--bucket", `s3://${bucket}`, "--endpoint", String(ENDPOINT), "--listen", `127.0.0.1:${String(port)}`], {
        cwd: directory,
        env: credentials(extra),
        stdio: ["ignore", "pipe", "pipe"],
    });
    const node: FleetNode = { directory, origin: `http://127.0.0.1:${String(port)}`, output: "", process: child };

    child.stdout?.on("data", (chunk: Buffer) => {
        node.output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        node.output += chunk.toString();
    });
    started.push(node);

    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`celld node exited before serving:\n${node.output}`);
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
            await fetch(`${node.origin}/ready`);

            return node;
        } catch {
            // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
            await pause(250);
        }
    }

    throw new Error(`celld node did not serve within the deadline:\n${node.output}`);
};

const probe = async (node: FleetNode, name: string, value?: string): Promise<string> => {
    const response = await fetch(`${node.origin}/fleet?name=${name}`, value === undefined ? {} : { body: value, method: "PUT" });

    return response.text();
};

/** Each live node's `owned_cells`, as `celld diagnose` probes them. */
const ownedCells = async (bucket: string): Promise<number[]> => {
    const report = await run(["diagnose", "--json", "--bucket", `s3://${bucket}`, "--endpoint", String(ENDPOINT)]).catch(String);

    return [...report.matchAll(/owned_cells=(\d+)/gu)].map((match) => Number(match[1]));
};

/** Read through `node` until it answers `expected` — a takeover is not instant. */
const readUntil = async (node: FleetNode, name: string, expected: string): Promise<string> => {
    const deadline = Date.now() + TAKEOVER_DEADLINE_MS;
    let last = "";

    while (Date.now() < deadline) {
        try {
            // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
            last = await probe(node, name);

            if (last === expected) {
                return last;
            }
        } catch (error) {
            last = String(error);
        }

        // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
        await pause(500);
    }

    return last;
};

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
            await stopCelld(node.process);
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
            first.process.kill("SIGKILL");

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
            const deadline = Date.now() + 60_000;
            let owned = await ownedCells(bucket);

            while (owned.filter((count) => count > 0).length < 2 && Date.now() < deadline) {
                // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
                await pause(1000);
                // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
                owned = await ownedCells(bucket);
            }

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
