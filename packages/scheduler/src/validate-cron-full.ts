/**
 * Build-time cron validation reached only through `@lunora/scheduler/validate`
 * (codegen, CLI). It is the SAME check the runtime `cronJobs()` builder applies —
 * both run `@visulima/cron-parser` in the `cloudflare` dialect (see
 * `./validate-cron.ts`) — so codegen can never accept an expression the runtime
 * would reject at app startup, and there is only one grammar to keep in step.
 */
export { isValidCronExpression as default } from "./validate-cron";
