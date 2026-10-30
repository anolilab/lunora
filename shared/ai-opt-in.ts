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
 * a second one at the worker would be the copy that drifts. Anything
 * unrecognised — a typo in a wrangler var, an absent binding — takes
 * {@link DEFAULT_AI_OPT_IN_LEVEL} rather than the top tier, so a misconfiguration
 * fails closed.
 */
const asOptInLevel = (raw: unknown): AiOptInLevel =>
    typeof raw === "string" && (OPT_IN_LADDER as ReadonlyArray<string>).includes(raw) ? (raw as AiOptInLevel) : DEFAULT_AI_OPT_IN_LEVEL;

export { asOptInLevel, OPT_IN_LADDER };
