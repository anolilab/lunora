/**
 * The provision box's HTTP surface.
 *
 * `POST /__lunora/provision` takes a `ProvisionJob` (JSON) and answers NDJSON
 * `ProvisionEvent`s: `log` lines as Alchemy runs, then exactly one `result` or
 * `error`. `GET /__lunora/health` is the readiness probe.
 *
 * This box holds the cell's Cloudflare API token — and, for the length of a
 * `cloudflare-workers` job, a customer's — so it only ever runs trusted code:
 * `program.mjs` (reviewed, static) through the pinned Alchemy CLI. The
 * tenant's bundle and assets are written to disk as data and uploaded, never
 * imported or executed; tenant strings reach Alchemy only through the JSON plan.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assetRelativePath, PlanError, planJob } from "./plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM = join(HERE, "program.mjs");
// Overridable only so the test suite can stand a stub in for Alchemy.
const ALCHEMY_CLI = process.env.LUNORA_ALCHEMY_CLI ?? join(HERE, "node_modules", "alchemy", "bin", "cli.js");

/** Bundle + assets arrive base64 in one JSON body. */
const MAX_BODY_BYTES = 256 * 1024 * 1024;
const MAX_LOG_LINE_CHARS = 8000;
/** Per stack. A first deploy into a cell also bootstraps the state store. */
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The Cloudflare credentials and state store one job's Alchemy child runs with.
 *
 * A `dispatch-namespace` job converges in the cell's own account with the box's
 * own credentials, and Alchemy keeps its state in that account's state store.
 * An `account` job converges in a customer's account with the token the job
 * carries — but its state stays in the PLATFORM's store, reached over HTTP
 * (`LUNORA_STATE_STORE_URL` + `LUNORA_STATE_STORE_TOKEN`, the cell's
 * `alchemy-state-store`): a customer must never hold the record of what was
 * converged for them (MULTIPLATFORM.md §5.3). A box without that store refuses
 * account jobs rather than keep their state in the customer's account.
 * @param {import("./plan.mjs").ProvisionJob} job The planned job.
 * @param {import("./plan.mjs").Plan} plan Its plan.
 * @returns {Record<string, string>} The env entries the child needs for them.
 */
const credentialsFor = (job, plan) => {
    if (plan.target.kind !== "account") {
        return { CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? "" };
    }

    const stateUrl = process.env.LUNORA_STATE_STORE_URL ?? "";
    const stateToken = process.env.LUNORA_STATE_STORE_TOKEN ?? "";

    if (stateUrl === "" || stateToken === "") {
        throw new PlanError(
            "this provision box has no platform state store (LUNORA_STATE_STORE_URL, LUNORA_STATE_STORE_TOKEN), so it cannot converge into a customer's account",
        );
    }

    const target = job.action === "deploy" ? job.spec.target : job.target;

    return {
        CLOUDFLARE_ACCOUNT_ID: plan.target.accountId,
        CLOUDFLARE_API_TOKEN: /** @type {{ apiToken: string }} */ (target).apiToken,
        LUNORA_STATE_STORE_TOKEN: stateToken,
        LUNORA_STATE_STORE_URL: stateUrl,
    };
};

/** One job at a time: the control plane serializes per project, this enforces it per instance. */
let busy = false;

/**
 * @param {import("node:http").IncomingMessage} request The request whose body is read.
 * @returns {Promise<Buffer | undefined>} The body, or `undefined` when over the cap.
 */
const readBody = async (request) => {
    const chunks = [];
    let total = 0;

    for await (const chunk of request) {
        total += chunk.length;

        if (total > MAX_BODY_BYTES) {
            return undefined;
        }

        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
};

/**
 * Replace every secret value in a line before it leaves the box. Alchemy renders
 * `Redacted` values as such already; this is the backstop for anything that
 * echoes a raw value (an API error quoting a request, a stack trace).
 * @param {string[]} secrets Values that must never leave the box.
 * @returns {(line: string) => string} Maps a line to its scrubbed form.
 */
const scrubber = (secrets) => {
    const values = secrets.filter((value) => value.length >= 4).toSorted((a, b) => b.length - a.length);

    return (line) => {
        let text = line;

        for (const value of values) {
            text = text.replaceAll(value, "[redacted]");
        }

        return text;
    };
};

/**
 * Run one Alchemy CLI invocation, forwarding each output line.
 * @param {string[]} args CLI arguments after the entrypoint.
 * @param {{ cwd: string, env: Record<string, string> }} options Working directory and the complete child env.
 * @param {(line: string) => void} onLine Called once per output line.
 * @returns {Promise<number>} The exit code; a timeout kills the process and rejects.
 */
const run = (args, options, onLine) =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ALCHEMY_CLI, ...args], { ...options, shell: false, stdio: ["ignore", "pipe", "pipe"] });

        for (const stream of [child.stdout, child.stderr]) {
            let pending = "";

            stream.setEncoding("utf8");
            stream.on("data", (/** @type {string} */ text) => {
                const lines = (pending + text).split("\n");

                pending = lines.pop() ?? "";

                for (const line of lines) {
                    onLine(line.slice(0, MAX_LOG_LINE_CHARS));
                }
            });
            stream.on("end", () => {
                if (pending !== "") {
                    onLine(pending.slice(0, MAX_LOG_LINE_CHARS));
                }
            });
        }

        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new PlanError(`alchemy ${args[0]} exceeded ${STEP_TIMEOUT_MS}ms and was killed`));
        }, STEP_TIMEOUT_MS);

        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve(code ?? 1);
        });
    });

/**
 * Write the tenant's bundle and assets into the workspace. Data only: the
 * bundle is uploaded byte-for-byte by Alchemy and never loaded here.
 * @param {string} workspace The job's temp directory.
 * @param {import("./plan.mjs").ProvisionJob & { action: "deploy" }} job The planned deploy job.
 * @returns {Promise<{ assetsDirectory: string, workerMain: string }>} Where the program finds its inputs.
 */
const writeInputs = async (workspace, job) => {
    const workerMain = join(workspace, "worker", "index.js");
    const assetsDirectory = join(workspace, "assets");

    await mkdir(dirname(workerMain), { recursive: true });
    await writeFile(workerMain, Buffer.from(job.spec.bundle, "base64"));

    for (const file of job.spec.assets?.files ?? []) {
        const target = join(assetsDirectory, assetRelativePath(file.path));

        // eslint-disable-next-line no-await-in-loop -- sequential writes keep memory flat for large sites
        await mkdir(dirname(target), { recursive: true });
        // eslint-disable-next-line no-await-in-loop -- same
        await writeFile(target, Buffer.from(file.content, "base64"));
    }

    return { assetsDirectory, workerMain };
};

/**
 * One job: plan → write inputs → run each stack step → result.
 * @param {unknown} job The parsed request body.
 * @param {(event: import("../../src/targets/provision-box/contract").ProvisionEvent) => void} emit Writes one NDJSON line.
 * @returns {Promise<void>} Resolves once the terminal event is emitted.
 */
const provision = async (job, emit) => {
    const plan = planJob(/** @type {import("./plan.mjs").ProvisionJob} */ (job), { controlPlaneScript: process.env.LUNORA_CONTROL_PLANE_SCRIPT });
    const deploy = /** @type {import("./plan.mjs").ProvisionJob} */ (job).action === "deploy";
    const secrets = deploy ? /** @type {import("./plan.mjs").ProvisionJob & { action: "deploy" }} */ (job).spec.secrets : {};
    const credentials = credentialsFor(/** @type {import("./plan.mjs").ProvisionJob} */ (job), plan);
    // Every credential this job holds, the box's own included, is scrubbed from what leaves it.
    const scrub = scrubber([
        ...Object.values(secrets),
        process.env.CLOUDFLARE_API_TOKEN ?? "",
        credentials.CLOUDFLARE_API_TOKEN ?? "",
        credentials.LUNORA_STATE_STORE_TOKEN ?? "",
    ]);
    const workspace = await mkdtemp(join(tmpdir(), "provision-"));

    try {
        const inputs = deploy
            ? await writeInputs(workspace, /** @type {import("./plan.mjs").ProvisionJob & { action: "deploy" }} */ (job))
            : { assetsDirectory: "", workerMain: "" };
        const planFile = join(workspace, "plan.json");

        await writeFile(planFile, JSON.stringify({ ...plan, ...inputs }));

        for (const step of plan.steps) {
            emit({ line: `${step.op} ${step.stackName} (stage ${plan.stage})`, type: "log" });

            // An explicit allowlist, not `...process.env`: the program needs the
            // Cloudflare credentials and its inputs, nothing else from this box.
            /** @type {Record<string, string>} */
            const env = {
                ALCHEMY_TELEMETRY_DISABLED: "1",
                CI: "true",
                ...credentials,
                DO_NOT_TRACK: "1",
                // Alchemy keeps credentials caches and logs under HOME; the
                // workspace is removed after the job, so nothing outlives it.
                HOME: workspace,
                LUNORA_PROVISION_PLAN: planFile,
                LUNORA_PROVISION_STACK: step.kind,
                NO_COLOR: "1",
                PATH: process.env.PATH ?? "",
            };

            if (step.kind === "worker" && step.op === "deploy") {
                env.LUNORA_SECRETS = JSON.stringify(secrets);
            }

            // eslint-disable-next-line no-await-in-loop -- the Worker references the project stack, so steps are ordered
            const code = await run([step.op, PROGRAM, "--stage", plan.stage, "--yes", "--no-input"], { cwd: workspace, env }, (line) => {
                emit({ line: scrub(line), type: "log" });
            });

            if (code !== 0) {
                emit({ message: `alchemy ${step.op} of ${step.stackName} failed with exit code ${code}`, type: "error" });

                return;
            }
        }

        // No URL: a dispatch-namespace Worker has none of its own (the dispatcher
        // routes to it), and an account Worker's is the control plane's to compute.
        emit({ type: "result" });
    } finally {
        await rm(workspace, { force: true, recursive: true }).catch(() => {});
    }
};

/**
 * @param {import("node:http").IncomingMessage} request The provision request.
 * @param {import("node:http").ServerResponse} response The NDJSON response.
 * @returns {Promise<void>} Resolves once the response is closed.
 */
const handleProvision = async (request, response) => {
    const body = await readBody(request);

    if (body === undefined) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `request body exceeded ${MAX_BODY_BYTES} bytes` }));

        return;
    }

    let job;

    try {
        job = JSON.parse(body.toString("utf8"));
    } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "body is not valid JSON" }));

        return;
    }

    response.writeHead(200, { "content-type": "application/x-ndjson" });

    /** @param {import("../../src/targets/provision-box/contract").ProvisionEvent} event The event to send. */
    const emit = (event) => {
        response.write(`${JSON.stringify(event)}\n`);
    };

    try {
        await provision(job, emit);
    } catch (error) {
        if (error instanceof PlanError) {
            emit({ message: error.message, type: "error" });
        } else {
            // The operator's copy stays in the container log; the caller gets no internals.
            process.stderr.write(`internal provision-box failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
            emit({ message: "the provision box failed unexpectedly; the platform operator has the details", type: "error" });
        }
    } finally {
        response.end();
    }
};

const server = createServer((request, response) => {
    const route = `${request.method} ${(request.url ?? "").split("?")[0]}`;

    if (route === "GET /__lunora/health") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");

        return;
    }

    if (route === "POST /__lunora/provision") {
        if (busy) {
            response.writeHead(409, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "a provision job is already running on this instance" }));

            return;
        }

        busy = true;
        handleProvision(request, response)
            .finally(() => {
                busy = false;
            })
            .catch((error) => {
                process.stderr.write(`internal provision-box failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);

                if (!response.headersSent) {
                    response.writeHead(500, { "content-type": "application/json" });
                }

                response.end();
            });

        return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "no such route" }));
});

server.listen(Number(process.env.PORT ?? 8080), () => {
    const address = server.address();

    process.stdout.write(`provision box listening on ${typeof address === "object" && address !== null ? String(address.port) : "?"}\n`);
});
