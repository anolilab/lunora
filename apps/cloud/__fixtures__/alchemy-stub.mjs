/**
 * Stands in for the Alchemy CLI in `provision-container.test.ts`: reports what
 * the provision box handed it, and misbehaves on cue. Cues ride on the dispatch
 * namespace (the plan's stage) because the box gives its child an explicit env
 * allowlist.
 */
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const plan = JSON.parse(readFileSync(String(process.env.LUNORA_PROVISION_PLAN), "utf8"));
const report = {
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
    args: process.argv.slice(2),
    bundle: plan.workerMain ? readFileSync(plan.workerMain, "utf8") : undefined,
    cwd: process.cwd(),
    hasSecrets: process.env.LUNORA_SECRETS !== undefined,
    stack: process.env.LUNORA_PROVISION_STACK,
    stateStore: process.env.LUNORA_STATE_STORE_URL,
};

process.stdout.write(`${JSON.stringify(report)}\n`);

if (process.env.LUNORA_SECRETS !== undefined) {
    // What a careless error message would do; the box must scrub it.
    process.stderr.write(`echoing ${JSON.parse(process.env.LUNORA_SECRETS).API_KEY}\n`);
}

// The same carelessness with the Cloudflare token the job runs with.
process.stderr.write(`token ${String(process.env.CLOUDFLARE_API_TOKEN)}\n`);

if (plan.stage === "lunora-slow") {
    await sleep(1500);
}

if (plan.stage === "lunora-fail" && report.stack === "worker") {
    process.exitCode = 3;
}
