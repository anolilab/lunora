/**
 * Detect whether the current process was spawned by an AI coding agent.
 *
 * Agents struggle with long-running processes: they shell out, wait for exit,
 * and read output — but a dev server never exits. When an agent is detected,
 * `lunora dev` flips into background mode (managed detached process, see
 * `dev-server-state.ts`) and machine-readable JSON logging automatically, so
 * agent workflows need no flags. Humans are unaffected: no marker, no change.
 *
 * Detection is by environment variable markers the agent harnesses themselves
 * set in spawned shells. The table is deliberately conservative — a marker
 * that also appears in interactive human terminals (or plain CI) must NOT be
 * listed, because auto-backgrounding a human's `lunora dev` would be a nasty
 * surprise. Setting the override env (see {@link AGENT_MODE_ENV}) to `1` or
 * `0` forces the detection on or off.
 */

/** Minimal env shape — `process.env` structurally, injectable for tests. */
type EnvLike = Readonly<Record<string, string | undefined>>;

/** One detected agent: which tool, and which env var gave it away. */
interface AgentDetection {
    /** Human-readable agent name, for the "agent detected" log line. */
    name: string;
    /** The environment variable that matched. */
    variable: string;
}

/** Env var that forces agent mode on (`1`/`true`) or off (`0`/`false`), overriding detection. */
const AGENT_MODE_ENV = "LUNORA_AGENT_MODE";

/**
 * Known agent markers, first match wins. Each is set by the agent harness in
 * the shells it spawns; none appear in interactive human terminals.
 */
const AGENT_ENV_MARKERS: ReadonlyArray<AgentDetection> = [
    { name: "Claude Code", variable: "CLAUDECODE" },
    { name: "Claude Code", variable: "CLAUDE_CODE" },
    { name: "Cursor agent", variable: "CURSOR_AGENT" },
    { name: "Codex", variable: "CODEX_SANDBOX" },
    { name: "Gemini CLI", variable: "GEMINI_CLI" },
    { name: "Cline", variable: "CLINE_ACTIVE" },
    { name: "Replit agent", variable: "REPLIT_AGENT" },
    { name: "Jules", variable: "JULES_AGENT" },
];

/** True when the env value spells an explicit "off" (`0` / `false`). */
const isDisabled = (value: string): boolean => value === "0" || value === "false";

/**
 * Detect the AI agent driving this process, or `undefined` when none is.
 * `LUNORA_AGENT_MODE` wins over the marker table in both directions.
 * Pure — pass a custom `env` in tests.
 */
const detectAiAgent = (env: EnvLike = process.env): AgentDetection | undefined => {
    const override = env[AGENT_MODE_ENV];

    if (override !== undefined && override !== "") {
        return isDisabled(override) ? undefined : { name: "agent (forced)", variable: AGENT_MODE_ENV };
    }

    for (const marker of AGENT_ENV_MARKERS) {
        const value = env[marker.variable];

        if (value !== undefined && value !== "" && !isDisabled(value)) {
            return marker;
        }
    }

    return undefined;
};

export type { AgentDetection };
export { AGENT_MODE_ENV, detectAiAgent };
