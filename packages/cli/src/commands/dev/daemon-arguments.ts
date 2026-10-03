/** The argv a detached daemon `lunora dev` re-invocation is started with (`--background`). */
import type { DevOptions } from "./index";
import { normalizeAllowMail } from "./tunnel";

/**
 * Rebuild the argv a detached daemon `lunora dev` re-invocation needs, from the
 * already-parsed options. `--background`/`--json` are deliberately NOT
 * forwarded: the daemon must run the foreground path (its detachment marker is
 * `DEV_DAEMON_ENV`), and JSON logging travels as `LUNORA_LOG_JSON=1` env.
 *
 * KEEP IN SYNC with the `dev` option table in `./index.ts`: any new flag that
 * must reach the detached daemon has to be forwarded here explicitly, or a
 * background start will silently drop it.
 */
const daemonArguments = (options: DevOptions, remote: boolean): string[] => {
    const args = ["dev"];

    if (options.apiSpec !== undefined) {
        args.push("--api-spec", options.apiSpec);
    }

    if (options.port !== undefined) {
        args.push("--port", String(options.port));
    }

    if (options.workerPort !== undefined) {
        args.push("--worker-port", String(options.workerPort));
    }

    // The daemon is the process that spawns `wrangler dev`, so an unforwarded
    // `--inspector-port` would leave the background run on wrangler's own
    // upward walk — the exact failure the flag exists to stop.
    if (options.inspectorPort !== undefined) {
        args.push("--inspector-port", String(options.inspectorPort));
    }

    // Forwarded, or a `--background` run would emit nothing: the daemon child is
    // the process that knows the resolved origin, and the supervisor asking for
    // the manifest is the same one that wanted the server detached.
    if (options.emitBindings !== undefined) {
        args.push("--emit-bindings", options.emitBindings);
    }

    if (options.codegen === false) {
        args.push("--no-codegen");
    }

    if (options.studio === false) {
        args.push("--no-studio");
    }

    if (options.worker === false) {
        args.push("--no-worker");
    }

    // Forwarded explicitly, like every other flag here: the daemon is a fresh
    // process that re-parses argv, so an unforwarded flag is silently dropped.
    // `lunora.config.*`'s target still reaches it (the daemon re-reads the config),
    // which is what makes a missing `--target` look accepted and do nothing.
    if (options.target !== undefined) {
        args.push("--target", options.target);
    }

    // The daemon owns the tunnel's cloudflared child, so both halves must reach it;
    // an unforwarded `--allow-mail` would turn a protected tunnel into a public one.
    if (options.tunnel === true) {
        args.push("--tunnel");

        for (const entry of normalizeAllowMail(options.allowMail).entries) {
            args.push("--allow-mail", entry);
        }
    }

    if (remote) {
        args.push("--remote");
    }

    if (options.local === true) {
        args.push("--local");
    }

    return args;
};

export default daemonArguments;
