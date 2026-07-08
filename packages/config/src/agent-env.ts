/**
 * Detect whether the current process was spawned by an AI coding agent.
 *
 * Agents struggle with long-running processes: they shell out, wait for exit,
 * and read output — but a dev server never exits. When an agent is detected,
 * `lunora dev` flips into background mode (managed detached process, see
 * `dev-server-state.ts`) and machine-readable JSON logging automatically, so
 * agent workflows need no flags. Humans are unaffected: no marker, no change.
 *
 * The marker table itself lives in `@visulima/find-ai-runner`
 * (`detectAiSession`), where it is maintained once for the whole ecosystem —
 * every entry is sourced from a shipping implementation, and platform-only
 * "ambient" markers (e.g. a Cursor editor terminal, where a human may be
 * typing) are excluded by default, which is exactly the behavior-switch
 * semantics Lunora needs. This module only layers Lunora's explicit override
 * on top: setting {@link AGENT_MODE_ENV} to `1` or `0` forces the detection
 * on or off.
 */
import { detectAiSession } from "@visulima/find-ai-runner";

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

/** True when the env value spells an explicit "off" (`0` / `false`, any casing). */
const isDisabled = (value: string): boolean => {
    const normalized = value.trim().toLowerCase();

    return normalized === "0" || normalized === "false";
};

/**
 * Detect the AI agent driving this process, or `undefined` when none is.
 * `LUNORA_AGENT_MODE` wins over `@visulima/find-ai-runner`'s marker table in
 * both directions. Pure — pass a custom `env` in tests.
 */
const detectAiAgent = (env: EnvLike = process.env): AgentDetection | undefined => {
    const override = env[AGENT_MODE_ENV];

    if (override !== undefined && override !== "") {
        return isDisabled(override) ? undefined : { name: "agent (forced)", variable: AGENT_MODE_ENV };
    }

    const session = detectAiSession(env);

    return session === undefined ? undefined : { name: session.agent, variable: session.signal };
};

export type { AgentDetection };
export { AGENT_MODE_ENV, detectAiAgent };
