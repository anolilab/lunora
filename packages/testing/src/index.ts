export type { FakeScheduledJob, FakeSchedulerControls, FunctionRegistry, LunoraTestOptions, TestHarness, TestIdentity, TestSubscription } from "./harness";
export { lunoraTest } from "./harness";

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
