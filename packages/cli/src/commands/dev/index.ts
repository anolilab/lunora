import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";
import { TARGET_OPTION } from "../../util/deploy-target";

const devCommand: Command = {
    argument: {
        description: "Optional subcommand: stop (shut the running dev server down) | status (report it) | logs (print its captured output)",
        name: "args",
        type: String,
    },
    description: "Run the dev stack: wrangler worker + studio + codegen watch",
    examples: [
        ["lunora dev", "Run the worker + studio + codegen watch"],
        ["lunora dev --background", "Run detached: blocks until ready, prints URL + PID, then returns"],
        ["lunora dev stop", "Stop the background/tracked dev server (idempotent)"],
        ["lunora dev status", "Report the running dev server (URL, PID, uptime, ready/starting)"],
        ["lunora dev status --json", "Same as JSON — poll `.ready` to gate a dependent step in a task graph"],
        ["lunora dev logs", "Print the captured dev-server log (background runs)"],
        ["lunora dev --json", "Machine-readable JSON log lines (also LUNORA_LOG_JSON=1)"],
        ["lunora dev --emit-bindings dev-manifest.json", "Write what this worker needs + where it serves, for a task runner"],
        ["lunora dev --no-studio", "Skip the embedded studio server"],
        ["lunora dev --worker-port 8080", "Use a custom wrangler dev port"],
        ["lunora dev --remote", "Proxy D1/KV/R2 to the deployed worker (also LUNORA_REMOTE=1)"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "dev",
    // KEEP IN SYNC with `daemonArguments` in `./lifecycle.ts`: a new flag that
    // must reach a `--background` daemon has to be forwarded there explicitly.
    options: [
        { description: `Which API spec(s) codegen emits: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        {
            description: "Write the binding manifest (plus the dev origin) to <file>, for a supervisor that owns the rest of the graph",
            name: "emit-bindings",
            type: String,
        },
        { description: "Studio server port (default 6173)", name: "port", type: Number },
        TARGET_OPTION,
        { description: "wrangler dev port (default 8787)", name: "worker-port", type: Number },
        {
            description: "Run the dev server as a managed background process (auto-enabled when an AI agent is detected; LUNORA_AGENT_MODE=0 disables)",
            name: "background",
            type: Boolean,
        },
        { description: "Emit machine-readable JSON log lines (also LUNORA_LOG_JSON=1; auto-enabled for AI agents)", name: "json", type: Boolean },
        { description: "How many trailing lines `lunora dev logs` prints (default 100, 0 = all)", name: "lines", type: Number },
        // Both halves of each negatable boolean are declared explicitly, the way
        // `codegen`/`deploy` do it. Declaring ONLY the `no-*` name makes cerebro
        // synthesize the positive option by CLONING this one verbatim — including
        // its description — so `--help` listed `--studio` as "Don't start the
        // embedded studio server", the exact opposite of what it does.
        { description: "Serve the embedded studio at /__lunora (default)", name: "studio", type: Boolean },
        { description: "Don't start the embedded studio server", name: "no-studio", type: Boolean },
        { description: "Spawn wrangler dev for the worker (default)", name: "worker", type: Boolean },
        {
            description: "Don't spawn wrangler dev — an external task runner owns the worker; codegen watch + studio still run",
            name: "no-worker",
            type: Boolean,
        },
        { description: "Run codegen on startup and watch for changes (default)", name: "codegen", type: Boolean },
        { description: "Don't run codegen — no watch, no startup generate (or set LUNORA_CODEGEN=0)", name: "no-codegen", type: Boolean },
        { description: "Proxy D1/KV/R2 bindings to the deployed worker (or set LUNORA_REMOTE=1)", name: "remote", type: Boolean },
    ],
};

export { devCommand };

export type DevOptions = CreateOptions<{
    "api-spec": string | undefined;
    background: boolean | undefined;
    // Each of `codegen` / `studio` / `worker` is declared TWICE in `options` (the
    // positive form and its `no-*` counterpart, each with its own description);
    // cerebro exposes both under this one positive camelCase key. Neither form
    // carries a `defaultValue`, so the key is `undefined` until the user picks a
    // side — every reader treats that as "on" via `!== false`.
    codegen: boolean | undefined;
    "emit-bindings": string | undefined;
    json: boolean | undefined;
    lines: number | undefined;
    port: number | undefined;
    remote: boolean | undefined;
    studio: boolean | undefined;
    target: string | undefined;
    worker: boolean | undefined;
    "worker-port": number | undefined;
}>;
