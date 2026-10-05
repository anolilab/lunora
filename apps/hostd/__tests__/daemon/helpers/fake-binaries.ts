/**
 * Fake `celld` and `caddy` executables for the daemon tests: small Node
 * scripts that record how they were run and behave just enough like the real
 * ones — celld answers `deploy`, `diagnose`, `--version` and, run as a node,
 * serves its health route; Caddy answers `version` and serves an admin API
 * whose `POST /load` it records.
 *
 * A fleet's environment is cleared by the supervisor, so the scripts carry the
 * record directory and the Node binary baked in rather than reading them from
 * the environment or `PATH`.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One recorded run of a fake binary. */
interface Invocation {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    pid: number;
}

const CELLD_SCRIPT = (recordDirectory: string): string => String.raw`#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { join } = require("node:path");

const record = ${JSON.stringify(recordDirectory)};
const argv = process.argv.slice(2);
appendFileSync(join(record, "celld.jsonl"), JSON.stringify({ argv, cwd: process.cwd(), env: process.env, pid: process.pid }) + "\n");

if (argv[0] === "--version") {
    console.log("celld 0.6.0");
    process.exit(0);
}

if (argv[0] === "deploy") {
    const directory = argv[1];
    if (existsSync(join(record, "fail-deploy"))) {
        console.error("error: the bucket refused the upload");
        process.exit(1);
    }
    const config = JSON.parse(readFileSync(join(directory, "wrangler.json"), "utf8"));
    console.log("Bundled " + config.name + " (0.00 sec)");
    console.log(JSON.stringify({ dry_run: false, version: "v-test-1", worker: config.name }));
    process.exit(0);
}

if (argv[0] === "diagnose") {
    console.log(JSON.stringify({ check: "bucket s3://test", detail: "", verdict: "ok" }));
    console.log(JSON.stringify({ check: "bucket conditional write", detail: "create", verdict: "ok" }));
    process.exit(0);
}

const listen = argv[argv.indexOf("--listen") + 1];
const [host, port] = listen.split(":");
let draining = false;
const server = createServer((request, response) => {
    if (request.url === "/.well-known/celld/health") {
        response.writeHead(draining ? 503 : 200, { "content-type": "application/json" }).end(JSON.stringify({ ok: !draining }));
        return;
    }
    response.writeHead(200).end("fleet " + argv[argv.indexOf("--bucket") + 1] + " host " + request.headers["x-forwarded-host"]);
});
server.listen(Number(port), host);
// What celld's RUST_LOG=error,celld=warn lets through, on stderr; and app output on stdout.
console.error("2026-10-03T00:00:00Z  WARN celld::node: fake node listening on " + listen);
console.log("app console output");
process.on("SIGTERM", () => {
    draining = true;
    if (existsSync(join(record, "ignore-sigterm"))) {
        return;
    }
    setTimeout(() => process.exit(0), 50);
});
`;

const CADDY_SCRIPT = (recordDirectory: string): string => String.raw`#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { join } = require("node:path");

const record = ${JSON.stringify(recordDirectory)};
const argv = process.argv.slice(2);
appendFileSync(join(record, "caddy.jsonl"), JSON.stringify({ argv, cwd: process.cwd(), env: process.env, pid: process.pid }) + "\n");

if (argv[0] === "version") {
    console.log("v2.11.6 h1:fake");
    process.exit(0);
}

const config = JSON.parse(readFileSync(argv[argv.indexOf("--config") + 1], "utf8"));
const [host, port] = config.admin.listen.split(":");
createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
        // As Caddy does: a request with Sec-Fetch-Mode (a browser's — or Node fetch's) must carry the admin origin.
        if (request.headers["sec-fetch-mode"] !== undefined && request.headers.origin !== "http://" + config.admin.listen) {
            response.writeHead(403).end(JSON.stringify({ error: "client is not allowed to access from origin '" + (request.headers.origin ?? "") + "'" }));
            return;
        }
        if (request.method === "POST" && request.url === "/load") {
            if (existsSync(join(record, "reject-load"))) {
                response.writeHead(400).end("loading new config: http.handlers.nope: unknown module");
                return;
            }
            appendFileSync(join(record, "caddy-loads.jsonl"), body.replace(/\n/g, "") + "\n");
            response.writeHead(200).end();
            return;
        }
        response.writeHead(404).end();
    });
}).listen(Number(port), host);
process.on("SIGTERM", () => process.exit(0));
`;

/** Write executable fake `celld` and `caddy` into `binDirectory`, recording into `recordDirectory`. */
const writeFakeBinaries = (binDirectory: string, recordDirectory: string): { caddy: string; celld: string } => {
    mkdirSync(binDirectory, { recursive: true });
    mkdirSync(recordDirectory, { recursive: true });

    const celld = join(binDirectory, "celld");
    const caddy = join(binDirectory, "caddy");

    writeFileSync(celld, CELLD_SCRIPT(recordDirectory));
    writeFileSync(caddy, CADDY_SCRIPT(recordDirectory));
    chmodSync(celld, 0o755);
    chmodSync(caddy, 0o755);

    return { caddy, celld };
};

const readJsonLines = <T>(path: string): T[] => {
    try {
        return readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
};

/** Every recorded run of the fake celld. */
const celldInvocations = (recordDirectory: string): Invocation[] => readJsonLines<Invocation>(join(recordDirectory, "celld.jsonl"));

/** Every recorded run of the fake Caddy. */
const caddyInvocations = (recordDirectory: string): Invocation[] => readJsonLines<Invocation>(join(recordDirectory, "caddy.jsonl"));

/** Every config the fake Caddy loaded through `POST /load`, oldest first. */
const caddyLoads = (recordDirectory: string): Record<string, unknown>[] => readJsonLines<Record<string, unknown>>(join(recordDirectory, "caddy-loads.jsonl"));

/** Make the fake binaries misbehave: `fail-deploy`, `ignore-sigterm`, `reject-load`. */
type FakeFlag = "fail-deploy" | "ignore-sigterm" | "reject-load";

/** Set a flag the fake binaries read. */
const setFakeFlag = (recordDirectory: string, flag: FakeFlag): void => {
    writeFileSync(join(recordDirectory, flag), "");
};

/** Clear a flag {@link setFakeFlag} set. */
const clearFakeFlag = (recordDirectory: string, flag: FakeFlag): void => {
    rmSync(join(recordDirectory, flag), { force: true });
};

/** Every file directly in `directory`, for assertions. */
const listFiles = (directory: string): string[] => {
    try {
        return readdirSync(directory).toSorted((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
};

export type { Invocation };
export { caddyInvocations, caddyLoads, celldInvocations, clearFakeFlag, listFiles, setFakeFlag, writeFakeBinaries };
