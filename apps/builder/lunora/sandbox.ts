import { LunoraError } from "lunorash/errors";

/**
 * The execution surface the build agent runs commands through.
 *
 * Two drivers implement it (see below), which is the whole reason it is an
 * interface rather than a concrete class: `CONTAINER` when the app has a
 * container binding, and an in-process simulation when it does not. Without a
 * second implementation this would be the premature abstraction `CLAUDE.md`
 * forbids; with one it is the seam that lets the builder run end to end today
 * and swap to a real sandbox without the agent noticing.
 *
 * This is the app-local stand-in for plan 335's **E1**
 * (`@lunora/container/sandbox`). E1 is deliberately blocked on the Phase 0
 * latency spike; when it lands, `containerDriver` becomes a thin call into it
 * and everything above this line is unchanged.
 */
interface SandboxDriver {
    /** Run one command against the project's working tree. */
    exec: (command: string, arguments_: ReadonlyArray<string>, files: ProjectFiles) => Promise<SandboxRun>;

    /** Human-readable driver name, surfaced in the workbench so nobody mistakes a simulation for a real run. */
    readonly kind: "container" | "simulated";
}

/** The project's working tree as the driver sees it: path → contents. */
type ProjectFiles = ReadonlyMap<string, string>;

/** The outcome of one command. Mirrors `ContainerExecResult`, plus what it changed. */
interface SandboxRun {
    code: number;
    stderr: string;
    stdout: string;

    /**
     * Files the command created or rewrote. Applied back to the `files` table by
     * the caller, so a command that scaffolds a project shows up in the
     * workbench without a second round trip.
     */
    writes?: ReadonlyMap<string, string>;
}

/** Commands the agent may run. Anything else is refused (plan 335 §D14). */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(["git", "lunora", "node", "pnpm", "wrangler"]);

/** Windows drive-letter prefix (`C:/…`) — another shape of "absolute". Hoisted so it is compiled once. */
const DRIVE_LETTER_PREFIX = /^[a-z]:/iu;

/** Upper bound on captured output, so one chatty command cannot flood a turn's context. */
const MAX_OUTPUT_CHARS = 8000;

/** Trim command output to the cap, marking the truncation so a reader knows it happened. */
const capOutput = (text: string): string => (text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated]`);

/**
 * Reject a path an untrusted model chose before it reaches storage.
 *
 * Absolute paths and `..` segments are the escape a model reaches for when it
 * decides it needs `/etc/passwd` or `../../other-project`; a leading `.` on the
 * first segment is how it would try to rewrite `.git` or `.dev.vars`. The check
 * is here rather than at each call site because "every write is checked" is only
 * true if there is one place that can be read to confirm it.
 */
const assertSafePath = (path: string): string => {
    const normalized = path.trim().replaceAll("\\", "/");

    if (normalized.length === 0 || normalized.length > 400) {
        throw new LunoraError("BAD_REQUEST", `sandbox: refusing an empty or over-long path (${String(normalized.length)} chars)`);
    }

    if (normalized.startsWith("/") || DRIVE_LETTER_PREFIX.test(normalized)) {
        throw new LunoraError("BAD_REQUEST", `sandbox: refusing the absolute path "${path}" — project paths are relative`);
    }

    const segments = normalized.split("/");

    if (segments.includes("..")) {
        throw new LunoraError("BAD_REQUEST", `sandbox: refusing "${path}" — it escapes the project root`);
    }

    // `.dev.vars` holds secrets and `lunora/_generated` is codegen's output;
    // both are written by the toolchain, never by the model (plan 335 §3.6).
    if (normalized === ".dev.vars" || normalized.startsWith("lunora/_generated/")) {
        throw new LunoraError("FORBIDDEN", `sandbox: "${path}" is written by the toolchain, not by hand`);
    }

    return normalized;
};

/** Refuse a command outside the allowlist, naming what is permitted. */
const assertAllowedCommand = (command: string): void => {
    if (!ALLOWED_COMMANDS.has(command)) {
        throw new LunoraError(
            "FORBIDDEN",
            `sandbox: "${command}" is not an allowed command. Permitted: ${[...ALLOWED_COMMANDS].toSorted((left, right) => left.localeCompare(right)).join(", ")}. ` +
                `There is no shell — pass the program and its arguments separately.`,
        );
    }
};

/**
 * The simulated driver: enough of the toolchain to drive the product end to end
 * with no container at all.
 *
 * It is **not** a mock in the test sense — it is the driver the app runs on
 * until E1 lands, and the workbench labels it as simulated so a user is never
 * told a command ran when it did not. It answers the handful of commands the
 * agent's loop actually issues and refuses the rest loudly, which is far more
 * useful than a stub that pretends every command succeeded.
 */
const simulatedDriver = (): SandboxDriver => {
    return {
        // `async` despite having nothing to await, and that is the point: the
        // guard below throws, and a NON-async function throws synchronously. The
        // container driver is genuinely async, so its guard surfaces as a
        // rejection — leaving this one sync meant `driver.exec(…).catch(…)`
        // caught a refusal from one driver and sailed straight past the other.
        // An interface that returns a promise has to reject, not throw.
        exec: async (command, arguments_, files) => {
            // Awaits nothing of substance — its only job is to make this function
            // genuinely async, so the guard below rejects instead of throwing.
            await Promise.resolve();

            assertAllowedCommand(command);

            const argv = arguments_.join(" ");

            if (command === "lunora" && arguments_[0] === "verify") {
                // The one check worth simulating honestly: a project with no schema
                // cannot verify, and saying so is the feedback the fix loop needs.
                const hasSchema = [...files.keys()].includes("lunora/schema.ts");

                return hasSchema
                    ? { code: 0, stderr: "", stdout: "verify: project is valid (simulated)" }
                    : { code: 1, stderr: "verify: lunora/schema.ts not found", stdout: "" };
            }

            if (command === "pnpm" && arguments_[0] === "install") {
                return { code: 0, stderr: "", stdout: `install: ${String(files.size)} files present, dependencies assumed warm (simulated)` };
            }

            return { code: 0, stderr: "", stdout: `simulated: ${command} ${argv}`.trim() };
        },
        kind: "simulated",
    };
};

/**
 * The container driver: runs the command for real through
 * `ctx.containers.<name>.exec`, the first-class contract added to
 * `@lunora/container`.
 *
 * Note what it does *not* do: sync the working tree in or read it back. That
 * needs the fs half of E1, so until then this driver runs commands against
 * whatever the image ships. It is wired and typed so the swap is a one-file
 * change rather than a re-architecture, and `resolveSandbox` only selects it
 * when a binding is actually present.
 */
const containerDriver = (accessor: ContainerAccessorLike, sessionId: string): SandboxDriver => {
    return {
        exec: async (command, arguments_) => {
            assertAllowedCommand(command);

            const result = await accessor.get(sessionId).exec(command, { args: [...arguments_], timeoutMs: 120_000 });

            return { code: result.code, stderr: capOutput(result.stderr), stdout: capOutput(result.stdout) };
        },
        kind: "container",
    };
};

/** The slice of `ctx.containers.<name>` this module needs — structural, so it is testable without a binding. */
interface ContainerAccessorLike {
    get: (name: string) => {
        exec: (command: string, options?: { args?: ReadonlyArray<string>; timeoutMs?: number }) => Promise<{ code: number; stderr: string; stdout: string }>;
    };
}

/**
 * Pick a driver for this project.
 *
 * Falls back to the simulation rather than throwing when no container binding
 * exists, because the alternative is an app that cannot start locally — but the
 * choice is surfaced (`kind`) all the way to the workbench, so "no container
 * configured" is visible rather than silently degraded.
 */
const resolveSandbox = (containers: Record<string, ContainerAccessorLike> | undefined, projectId: string): SandboxDriver => {
    const accessor = containers?.["sandbox"];

    return accessor === undefined ? simulatedDriver() : containerDriver(accessor, projectId);
};

export type { ProjectFiles, SandboxDriver, SandboxRun };
export { ALLOWED_COMMANDS, assertAllowedCommand, assertSafePath, capOutput, containerDriver, resolveSandbox, simulatedDriver };
