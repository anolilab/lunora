export type { AgentHarness, AgentHarnessOptions, AgentRunOverrides, HarnessDispatch, HarnessMessage, HarnessThread } from "./agent-harness";
export { agentHarness, finalTurn, toolCallTurn } from "./agent-harness";
export type { EvaluationAttributeValue, EvaluationSpanHandle, RecordEvaluationInput } from "./evaluation-telemetry";
export { evaluationAttributes, recordEvaluation } from "./evaluation-telemetry";
export type {
    FakeScheduledJob,
    FakeSchedulerControls,
    FunctionRegistry,
    LunoraTestOptions,
    ScheduledJobFailure,
    SweepOptions,
    TestHarness,
    TestIdentity,
    TestSubscription,
} from "./harness";
export { lunoraTest } from "./harness";
export type { EvalCase, EvalItemResult, EvalResult, Scorer, ScoreResult, ScorerSample } from "./scorer";
export { containsScorer, evaluate, exactMatchScorer, keywordScorer, llmScorer, regexScorer, scoreSample } from "./scorer";

/**
 * `@lunora/testing` — the user-facing toolkit for end-to-end testing a Lunora app.
 *
 * Today it surfaces the dev mail-catcher helpers from `@lunora/mail/testing`: in
 * `lunora dev` every outbound email (sign-up verification, forgot-password, magic
 * links) is captured into the studio's root-shard inbox instead of hitting a real
 * provider, and these helpers read that inbox over the admin RPC so a Playwright
 * test can drive "request reset → read the email → follow the link → set a new
 * password" deterministically.
 *
 * This is the home for E2E fixtures to grow into — auth helpers and more — so
 * tests import one package (`@lunora/testing`) rather than reaching into each
 * sub-package's `/testing` entry.
 */
export type { InboxOptions, WaitForMailOptions } from "@lunora/mail/testing";
export { extractLink, listCapturedMail, waitForMail } from "@lunora/mail/testing";
