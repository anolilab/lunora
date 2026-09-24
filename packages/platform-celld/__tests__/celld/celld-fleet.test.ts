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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_BIN = join(HARNESS_DIR, "..", "..", "node_modules", ".bin");
const CELLD = process.env.LUNORA_CELLD_BIN ?? "celld";
const ENDPOINT = process.env.LUNORA_CELLD_S3_ENDPOINT;

/** A cell whose owner stopped is taken over once its lease lapses (~10 s); allow several. */
const TAKEOVER_DEADLINE_MS = 60_000;

const freePort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer();

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            server.close(() => {
                resolve(typeof address === "object" && address !== null ? address.port : 0);
            });
        });
    });

const pause = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

type FleetNode = { directory: string; origin: string; output: string; process: ChildProcess };

const fleet = { bucket: `lunora-celld-fleet-${String(Date.now())}`, nodes: [] as FleetNode[] };

const credentials = (): NodeJS.ProcessEnv => {
    return {
        ...process.env,
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
        AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
        PATH: `${PACKAGE_BIN}:${process.env.PATH ?? ""}`,
    };
};

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

const startNode = async (): Promise<FleetNode> => {
    const port = await freePort();
    const directory = await mkdtemp(join(tmpdir(), "lunora-celld-node-"));
    const child = spawn(CELLD, ["--bucket", `s3://${fleet.bucket}`, "--endpoint", String(ENDPOINT), "--listen", `127.0.0.1:${String(port)}`], {
        cwd: directory,
        env: credentials(),
        stdio: ["ignore", "pipe", "pipe"],
    });
    const node: FleetNode = { directory, origin: `http://127.0.0.1:${String(port)}`, output: "", process: child };

    child.stdout?.on("data", (chunk: Buffer) => {
        node.output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        node.output += chunk.toString();
    });
    fleet.nodes.push(node);

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

describe.skipIf(ENDPOINT === undefined && process.env.CI === undefined)("celld host across a two-node fleet", () => {
    beforeAll(async () => {
        if (ENDPOINT === undefined) {
            throw new Error("LUNORA_CELLD_S3_ENDPOINT is unset — the fleet test needs an S3-compatible endpoint (moto's server in CI)");
        }

        await fetch(`${ENDPOINT}/${fleet.bucket}`, { method: "PUT" });
        await run(["deploy", HARNESS_DIR, "--bucket", `s3://${fleet.bucket}`, "--endpoint", ENDPOINT]);
        await startNode();
        await startNode();
    });

    afterAll(async () => {
        for (const node of fleet.nodes) {
            node.process.kill("SIGKILL");
            // eslint-disable-next-line no-await-in-loop -- tear down one node at a time
            await rm(node.directory, { force: true, recursive: true });
        }
    });

    it("serves a write made through one node when read through another", async () => {
        expect.assertions(2);

        const [first, second] = fleet.nodes as [FleetNode, FleetNode];

        await expect(probe(first, "routed", "through-first")).resolves.toBe("stored");
        // The second node does not own the cell; it has to forward to the owner.
        await expect(probe(second, "routed")).resolves.toBe("through-first");
    });

    it("keeps an acknowledged write when the owning node dies, and takes the cell over", async () => {
        expect.assertions(3);

        const [first, second] = fleet.nodes as [FleetNode, FleetNode];

        await expect(probe(first, "takeover", "before-crash")).resolves.toBe("stored");

        // Not a drain: the owner vanishes mid-lease, as a crashed machine would.
        first.process.kill("SIGKILL");

        await expect(readUntil(second, "takeover", "before-crash")).resolves.toBe("before-crash");
        // The surviving node now owns the cell and accepts writes to it.
        await expect(probe(second, "takeover", "after-crash")).resolves.toBe("stored");
    });
});
