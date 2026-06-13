export type { TestHarness, TestIdentity } from "./harness";
export { cirrusTest } from "./harness";

/**
 * `@cirrus/testing` — the user-facing toolkit for end-to-end testing a Cirrus app.
 *
 * Today it surfaces the dev mail-catcher helpers from `@cirrus/mail/testing`: in
 * `cirrus dev` every outbound email (sign-up verification, forgot-password, magic
 * links) is captured into the studio's root-shard inbox instead of hitting a real
 * provider, and these helpers read that inbox over the admin RPC so a Playwright
 * test can drive "request reset → read the email → follow the link → set a new
 * password" deterministically.
 *
 * This is the home for E2E fixtures to grow into — auth helpers and more — so
 * tests import one package (`@cirrus/testing`) rather than reaching into each
 * sub-package's `/testing` entry.
 */
export type { InboxOptions, WaitForMailOptions } from "@cirrus/mail/testing";
export { extractLink, listCapturedMail, waitForMail } from "@cirrus/mail/testing";
