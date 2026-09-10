/**
 * The build box's HTTP surface (GAPS.md A3).
 *
 * Three routes, and the reason there are three rather than one is the shape of
 * `BuildRunnerPorts.execute`:
 *
 * `POST /__lunora/build` is the real entry point. The body IS the repo tarball,
 * because `execute(source: ArrayBuffer, …)` holds the source in the Worker and
 * the exec contract has nowhere to put it: exec sends `{command,args,cwd,env}`
 * and nothing else, so a 40MB tarball cannot travel through it. The response is
 * NDJSON — one `{"line"}` per output line as it happens, then a final
 * `{"bundle","bundleHash"}` or `{"error"}` — which is also what lets the
 * dashboard tail a build live and sidesteps exec's 1MB buffered-response cap.
 * A real build log is bigger than that.
 *
 * `POST /__lunora/exec` is the `@lunora/container` exec contract, verbatim, so
 * `ctx.containers.<name>.exec()` works against this image and an operator can
 * poke at a wedged build box with the tooling that already exists.
 * `GET /__lunora/health` is the readiness probe.
 *
 * Zero dependencies on purpose: this image runs untrusted tenant code, and every
 * package added here is more attack surface sitting in the same filesystem as
 * the thing being defended against.
 */
/* eslint-disable sonarjs/no-os-command-from-path -- `tar` and the package managers are resolved through PATH on purpose. This module only ever runs as PID-adjacent code inside its own purpose-built image, where the Dockerfile owns PATH and the filesystem; hardcoding `/usr/bin/tar` and the corepack shim paths would instead break silently on a base-image rebase, which is the failure this rule cannot see. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An error whose message is written FOR the person who pushed the commit.
 *
 * The distinction matters because this server's replies end up in `buildLogs`,
 * which tenants read in the Studio. "no lockfile found" and "your project does
 * not depend on the Lunora CLI" are the whole point — a build box that hid them
 * would leave someone staring at a red build with no cause. But an unexpected
 * `ENOENT /workspace/build-a1b2/node_modules/…` is not their problem, is not
 * actionable, and describes this container's insides to someone outside it.
 *
 * So a `BuildError` is echoed and anything else is generalised, with the detail
 * going to the container's own log. CodeQL flagged the previous code for
 * information exposure and it was right: it echoed every `error.message` alike.
 */
class BuildError extends Error {}

/** Where the deploy path expects the entry module. `provision.ts` defaults `mainModule` to this. */
const ENTRY_MODULE = "index.js";

/** `lunora build`'s default out-dir (`DEFAULT_OUT_DIR` in the CLI's build handler). */
const OUT_DIR = ".lunora/build";

/**
 * Caps. Every one of these is a tenant-controlled quantity, so each needs a
 * ceiling or a single build can take the box down.
 */
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_LOG_LINE_CHARS = 8000;
const MAX_EXEC_OUTPUT_CHARS = 900_000;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const EXEC_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The message to send back for a thrown error, keeping internal detail out of it.
 *
 * @param {unknown} error Whatever was thrown.
 * @returns {string} A tenant-facing message. Internal failures are generalised and logged here instead.
 */
const clientError = (error) => {
    if (error instanceof BuildError) {
        return error.message;
    }

    // The operator's copy. On `stderr` so it is not mistaken for build output,
    // and it never reaches the caller.
    process.stderr.write(`internal build-box failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);

    return "the build box failed unexpectedly; the platform operator has the details";
};

/**
 * Read a request body into one buffer, refusing anything over the cap.
 * @param {import("node:http").IncomingMessage} request Request whose body is read.
 * @param {number} limit Maximum bytes to accept before rejecting.
 * @returns {Promise<Buffer>} The whole body.
 */
const readBody = async (request, limit) => {
    const chunks = [];
    let total = 0;

    for await (const chunk of request) {
        total += chunk.length;

        if (total > limit) {
            throw new BuildError(`request body exceeded ${limit} bytes`);
        }

        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
};

/**
 * Run a command and hand each output line to `onLine` as it arrives.
 *
 * `shell: false` (the default, kept explicit) is the security-relevant part:
 * arguments never become a shell string, so a branch or commit value that
 * reaches an argument cannot inject a command. Resolves with the exit code —
 * a non-zero code is a result, not a throw, matching the exec contract.
 * @param {string} command Executable to run.
 * @param {string[]} args Arguments, passed unshelled.
 * @param {{ cwd?: string, env?: Record<string, string>, label?: string, timeoutMs?: number }} options Spawn options, the wall-clock kill, and how the phase is named if it fires.
 * @param {(line: string, stream: "stderr" | "stdout") => void} onLine Called once per output line.
 * @returns {Promise<number>} The process exit code.
 */
const run = (command, args, options, onLine) =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, shell: false, stdio: ["ignore", "pipe", "pipe"] });

        // Line-buffered per stream: a chunk boundary lands mid-line often
        // enough that unbuffered forwarding produces split log lines.
        const pending = { stderr: "", stdout: "" };

        const pump = (stream, name) => {
            stream.setEncoding("utf8");
            stream.on("data", (text) => {
                pending[name] += text;

                const lines = pending[name].split("\n");

                pending[name] = lines.pop() ?? "";

                for (const line of lines) {
                    onLine(line.slice(0, MAX_LOG_LINE_CHARS), name);
                }
            });
        };

        pump(child.stdout, "stdout");
        pump(child.stderr, "stderr");

        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new BuildError(`${options.label ?? "the command"} exceeded ${options.timeoutMs ?? BUILD_TIMEOUT_MS}ms and was killed`));
        }, options.timeoutMs ?? BUILD_TIMEOUT_MS);

        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });

        child.on("close", (code) => {
            clearTimeout(timer);

            // Flush whatever the process wrote without a trailing newline.
            for (const name of ["stdout", "stderr"]) {
                if (pending[name] !== "") {
                    onLine(pending[name].slice(0, MAX_LOG_LINE_CHARS), name);
                }
            }

            resolve(code ?? 0);
        });
    });

/**
 * Which package manager this project's lockfile was written by.
 *
 * The lockfile decides, never a default: installing a pnpm project with npm
 * resolves a different dependency graph than the one the tenant tested, and the
 * failure surfaces as a mysterious build error rather than as "wrong manager".
 * An unrecognised project is refused for the same reason.
 * @param {string} directory Extracted project root.
 * @returns {Promise<{ args: string[], command: string }>} The install command to run.
 */
const detectPackageManager = async (directory) => {
    const entries = new Set(await readdir(directory));

    if (entries.has("pnpm-lock.yaml")) {
        return { args: ["install", "--frozen-lockfile"], command: "pnpm" };
    }

    if (entries.has("package-lock.json")) {
        return { args: ["ci"], command: "npm" };
    }

    if (entries.has("yarn.lock")) {
        return { args: ["install", "--immutable"], command: "yarn" };
    }

    throw new BuildError("no lockfile found (pnpm-lock.yaml, package-lock.json or yarn.lock) — a reproducible build needs one");
};

/**
 * The project's own installed `lunora` binary.
 *
 * Deliberately NOT `pnpm exec` / `npm exec` / `yarn run`. Every package
 * manager's exec treats a missing binary as "resolve it from the registry":
 * verified against npm 10, where both `npm exec --no --` and `npx --no` still
 * fetch, so a project that never declared the CLI would be built by whatever
 * version is latest that day — a silent, unpinned, network-dependent toolchain
 * swap — and the build log would read `404 lunora` instead of naming the real
 * problem. Running `node_modules/.bin/lunora` can only ever be the version the
 * lockfile installed, and its absence is a clear error.
 *
 * (Yarn's PnP linker writes no `node_modules/.bin`. Such a project is refused
 * here rather than guessed at; the error says so.)
 * @param {string} directory Extracted project root.
 * @returns {Promise<string>} Absolute path to the project's own `lunora` binary.
 */
const resolveLunoraBin = async (directory) => {
    const binary = join(directory, "node_modules", ".bin", "lunora");

    try {
        await access(binary);
    } catch {
        throw new BuildError(
            "node_modules/.bin/lunora is missing after install — add the Lunora CLI to the project's dependencies " +
                "(`lunorash` or `@lunora/cli`). Yarn PnP projects are not supported by the build box.",
        );
    }

    return binary;
};

/**
 * Collect the built Worker module out of the out-dir.
 *
 * The deploy path uploads exactly ONE module (`api.ts` sets a single
 * `main_module` form part), so a build that produced several is refused here
 * rather than silently deployed as whichever file was picked first — a
 * multi-module tenant would otherwise get a Worker missing half its code, and
 * the first sign would be a runtime import error in production.
 * @param {string} projectDirectory Extracted project root.
 * @returns {Promise<{ bundle: string, bundleHash: string }>} Base64 module and its sha256.
 */
const collectBundle = async (projectDirectory) => {
    const outDirectory = join(projectDirectory, OUT_DIR);
    let entries;

    try {
        entries = await readdir(outDirectory, { recursive: true, withFileTypes: true });
    } catch {
        throw new BuildError(`\`lunora build\` wrote nothing to ${OUT_DIR}`);
    }

    // Same exclusions as the CLI's `bundle-size.ts`: sourcemaps, the esbuild
    // metafile and wrangler's README are in the out-dir but are not the Worker.
    const modules = entries.filter(
        (entry) => entry.isFile() && entry.name.endsWith(".js") && entry.name !== "bundle-meta.json" && !entry.name.endsWith(".map"),
    );

    if (modules.length === 0) {
        throw new BuildError(`no JavaScript module in ${OUT_DIR}`);
    }

    if (modules.length > 1) {
        const names = modules
            .map((entry) => entry.name)
            .toSorted()
            .join(", ");

        throw new BuildError(`\`lunora build\` produced ${modules.length} modules (${names}); the deploy path uploads a single ${ENTRY_MODULE}`);
    }

    const [module] = modules;
    const bytes = await readFile(join(module.parentPath, module.name));

    return { bundle: bytes.toString("base64"), bundleHash: createHash("sha256").update(bytes).digest("hex") };
};

/**
 * One build: extract → install → build → collect, streaming NDJSON as it goes.
 * @param {import("node:http").IncomingMessage} request Request whose body is the source tarball.
 * @param {import("node:http").ServerResponse} response Response the NDJSON stream is written to.
 * @returns {Promise<void>} Resolves once the stream is closed.
 */
const handleBuild = async (request, response) => {
    const source = await readBody(request, MAX_SOURCE_BYTES);

    response.writeHead(200, { "content-type": "application/x-ndjson", "transfer-encoding": "chunked" });

    // Flushed per line so the dashboard tails the build rather than receiving
    // the whole log at the end, which is the entire point of streaming here.
    const emit = (payload) => {
        response.write(`${JSON.stringify(payload)}\n`);
    };
    const onLine = (line) => {
        emit({ line });
    };

    // A fresh directory per build, removed in `finally`: two builds must never
    // see each other's `node_modules`, and a leftover tree is a cross-tenant
    // read on the next build to land on this instance.
    const workspace = await mkdtemp(join(process.env.HOME ?? tmpdir(), "build-"));

    try {
        emit({ line: "extracting source" });
        // `tar` reads the tarball from stdin, so the archive never touches disk
        // as a file of its own. `--strip-components=1` drops GitHub's
        // `<owner>-<repo>-<sha>/` wrapper directory.
        await new Promise((resolve, reject) => {
            const tar = spawn("tar", ["-xzf", "-", "-C", workspace, "--strip-components=1"], { shell: false, stdio: ["pipe", "ignore", "pipe"] });
            let stderr = "";

            tar.stderr.setEncoding("utf8");
            tar.stderr.on("data", (text) => {
                stderr += text;
            });
            tar.on("error", reject);
            tar.on("close", (code) =>
                code === 0 ? resolve() : reject(new BuildError(`the source archive could not be extracted (tar exit ${code}): ${stderr.trim()}`)),
            );
            tar.stdin.end(source);
        });

        const manager = await detectPackageManager(workspace);

        emit({ line: `installing dependencies with ${manager.command}` });

        const installCode = await run(manager.command, manager.args, { cwd: workspace, label: "dependency install", timeoutMs: BUILD_TIMEOUT_MS }, onLine);

        if (installCode !== 0) {
            emit({ error: `dependency install failed with exit code ${installCode}` });
            response.end();

            return;
        }

        emit({ line: "running lunora build" });

        // The PROJECT's own lunora CLI, off its lockfile — not a copy baked into
        // this image. A build box that pinned its own CLI version would build
        // tenants' code with a toolchain their lockfile never chose, and every
        // image bump would become a fleet-wide behaviour change.
        const lunora = await resolveLunoraBin(workspace);
        const buildCode = await run(lunora, ["build"], { cwd: workspace, label: "`lunora build`", timeoutMs: BUILD_TIMEOUT_MS }, onLine);

        if (buildCode !== 0) {
            emit({ error: `lunora build failed with exit code ${buildCode}` });
            response.end();

            return;
        }

        emit(await collectBundle(workspace));
    } catch (error) {
        emit({ error: clientError(error) });
    } finally {
        response.end();
        await rm(workspace, { force: true, recursive: true }).catch(() => {});
    }
};

/**
 * The `@lunora/container` exec contract: `{command,args,cwd,env,timeoutMs}` → `{code,stdout,stderr}`.
 * @param {import("node:http").IncomingMessage} request Request carrying the JSON exec document.
 * @param {import("node:http").ServerResponse} response Response the result is written to.
 * @returns {Promise<void>} Resolves once answered.
 */
const handleExec = async (request, response) => {
    const raw = await readBody(request, 1024 * 1024);
    let body;

    try {
        body = JSON.parse(raw.toString("utf8"));
    } catch {
        // A 400 naming the problem, rather than the generic 500 an escaping
        // SyntaxError would produce — and the parser's message, which quotes
        // the input back, never leaves the box.
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "body is not valid JSON" }));

        return;
    }

    if (typeof body.command !== "string" || body.command === "") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "`command` is required" }));

        return;
    }

    const captured = { stderr: "", stdout: "" };
    // Capped: the contract says the whole document is buffered to be parsed, so
    // an uncapped command output here becomes the caller's memory problem.
    const collect = (line, stream) => {
        if (captured[stream].length < MAX_EXEC_OUTPUT_CHARS) {
            captured[stream] += `${line}\n`;
        }
    };

    try {
        const code = await run(
            body.command,
            Array.isArray(body.args) ? body.args.map(String) : [],
            {
                cwd: typeof body.cwd === "string" ? body.cwd : process.env.HOME,
                env: { ...process.env, ...(typeof body.env === "object" && body.env !== null ? body.env : {}) },
                timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : EXEC_TIMEOUT_MS,
            },
            collect,
        );

        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ code, stderr: captured.stderr, stdout: captured.stdout }));
    } catch (error) {
        // A command that could not be RUN is a 500; a command that ran and
        // failed is a non-zero `code` above. The contract draws that line and
        // the caller's error handling depends on it.
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: clientError(error) }));
    }
};

/** The routes this server answers. See the `Map` note in the request handler. */
const ROUTES = new Map([
    ["POST /__lunora/build", handleBuild],
    ["POST /__lunora/exec", handleExec],
]);

const server = createServer((request, response) => {
    const route = `${request.method} ${(request.url ?? "").split("?")[0]}`;

    if (route === "GET /__lunora/health") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");

        return;
    }

    // A `Map`, not an object literal. An object lookup keyed on a
    // user-controlled string walks the prototype chain, so `route` naming an
    // inherited member resolves to a function that is not a route handler and
    // is then called — CodeQL's "unvalidated dynamic method call". A `Map` has
    // no such chain, so an unrecognised route can only ever be `undefined`.
    const handler = ROUTES.get(route);

    if (handler === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `no route for ${route}` }));

        return;
    }

    handler(request, response).catch((error) => {
        // Headers are already sent on the streaming route, so this can only
        // append or close — never re-answer.
        if (!response.headersSent) {
            response.writeHead(500, { "content-type": "application/json" });
        }

        response.end(JSON.stringify({ error: clientError(error) }));
    });
});

// `PORT=0` binds an ephemeral port and the line below reports which — that is
// how the test harness talks to a server it did not choose a port for, and it
// is the log line an operator looks for when a build box will not accept work.
server.listen(Number(process.env.PORT ?? 8080), () => {
    const address = server.address();

    process.stdout.write(`build box listening on ${typeof address === "object" && address !== null ? String(address.port) : "?"}\n`);
});
