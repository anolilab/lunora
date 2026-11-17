/**
 * The data-sharing ladder, split from `ai-chat.ts` so the shard DO — which only
 * narrows `LUNORA_AI_OPT_IN` — does not bundle the whole chat engine to do it.
 * Zero-dependency, like its neighbours.
 */

/**
 * How much of the deployment the assistant may read.
 *
 * Set SERVER-SIDE (the worker reads it off `env`) and never accepted from the
 * caller, because a level the browser could choose is not a gate — it is a
 * suggestion. The studio displays the level it is given and can only ask for
 * less by not using a tool, never for more.
 *
 * The ladder is ordered, and {@link allowsTool} compares by index, so adding a
 * tier is a one-line data change rather than a new branch per tool.
 */
export type AiOptInLevel = "disabled" | "schema" | "schema_and_log" | "schema_and_log_and_data";

/**
 * The ladder, lowest first. Index order IS the comparison — see {@link allowsTool}.
 *
 * Exported because the Studio's Settings readout renders the whole ladder to say
 * where the deployment sits on it. It reads the ladder rather than restating it,
 * so a tier added here cannot leave the readout describing a ladder that no
 * longer exists.
 */
const OPT_IN_LADDER: ReadonlyArray<AiOptInLevel> = ["disabled", "schema", "schema_and_log", "schema_and_log_and_data"];

/**
 * What a deployment gets when it configures nothing.
 *
 * `schema` rather than the top tier, deliberately. The operator already holds an
 * admin bearer that can run any read statement themselves, so this gate is not
 * protecting them from their own database — it decides whether rows their END
 * USERS wrote are sent to an inference provider. That is a disclosure, and a
 * disclosure defaults to off; the refusal text names the level so an operator who
 * wants it knows exactly what to set.
 */
const DEFAULT_AI_OPT_IN_LEVEL: AiOptInLevel = "schema";

/**
 * Narrow a configured value to a level.
 *
 * Lives here because {@link OPT_IN_LADDER} is the only list of valid levels, and
 * a second one at the worker would be the copy that drifts.
 *
 * An UNSET value (no var, or an empty one) takes {@link DEFAULT_AI_OPT_IN_LEVEL}.
 * A value that is set but is not a level turns the assistant OFF: an operator who
 * writes `off`, `false` or `Disabled` meant to stop it, and falling back to the
 * default would keep sending schema names to the inference provider while the
 * deployment looked switched off. A typo therefore never shares more than the
 * operator asked for, and the Studio shows `disabled`, so the mistake is visible.
 */
const asOptInLevel = (raw: unknown): AiOptInLevel => {
    if (raw === undefined || raw === null || raw === "") {
        return DEFAULT_AI_OPT_IN_LEVEL;
    }

    return typeof raw === "string" && (OPT_IN_LADDER as ReadonlyArray<string>).includes(raw) ? (raw as AiOptInLevel) : "disabled";
};

export { asOptInLevel, OPT_IN_LADDER };
