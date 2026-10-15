import { defineContainer } from "@lunora/container";

/**
 * Control-plane containers (GAPS.md A3).
 *
 * Two, deliberately separate because they sit on opposite sides of a trust
 * line:
 * - the build box turns a tenant's repo tarball into the Worker module the
 *   deploy path uploads. It runs untrusted code and holds no credentials.
 * - the provision box runs Alchemy 2 to converge a tenant's Cloudflare
 *   resources. It holds the cell's Cloudflare API token and runs only our code.
 *
 * Each image's directory README documents the HTTP contract it serves.
 */

/**
 * The server-side build runner.
 *
 * `standard-2` because this runs a real `pnpm install` plus a bundler over a
 * tenant's whole dependency tree. The default (1/16 vCPU, 256 MiB) is a
 * fraction of what esbuild alone wants, and a build box that OOMs mid-install
 * fails a tenant's deploy with a log that looks like their fault.
 *
 * `sleepAfter` is short: builds arrive in bursts after a push and an idle box
 * is billed for nothing. The cron drains at most five builds a minute, so a
 * cold start every few minutes is the expected shape rather than a problem.
 */
export const buildBox = defineContainer({
    /**
     * **Egress is denied by default and opened by exception.** This container
     * executes untrusted tenant code — a `postinstall` and a build script are
     * both arbitrary code execution by design — with a GitHub installation
     * token's worth of source already on its disk. An open internet from here
     * is a data-exfiltration path with someone else's code driving it.
     *
     * What is allowed is what an install genuinely needs: the npm registry and
     * its CDN, plus the two hosts a lockfile legitimately points at for git and
     * tarball dependencies. Anything else fails closed, loudly, in the build
     * log — which is the right place for "your dependency reaches
     * somewhere we do not allow" to show up.
     */
    allowedHosts: ["registry.npmjs.org", "*.npmjs.org", "registry.yarnpkg.com", "codeload.github.com", "github.com"],
    defaultPort: 8080,
    enableInternet: false,
    image: "./containers/build",
    instanceType: "standard-2",
    // A ceiling, not a target: it bounds what one cell can spend on builds if
    // the queue is flooded. The per-tick drain cap is the real throttle.
    maxInstances: 5,
    sleepAfter: "2m",
});

/**
 * The provision box: Alchemy 2 converging tenant Workers and their per-project
 * resources — into this cell's account for `cloudflare-wfp`, into a customer's
 * connected account for `cloudflare-workers`, with the Alchemy state kept in
 * this cell's account either way. Both Cloudflare target drivers drive it
 * (`src/targets/provision-box/client.ts`).
 *
 * Not in the Worker because Alchemy wants a Node process with a filesystem for
 * its state and the full SDK surface; not in the build box because that one
 * runs tenant code, and the cell's API token must never share a machine with it.
 *
 * Small and short-lived: the work is API calls, not compute, and deploys arrive
 * in bursts. The control plane routes one project to one instance (`.get(alias)`),
 * so `maxInstances` bounds how many projects provision at once per cell.
 */
export const provisionBox = defineContainer({
    // The Cloudflare API, plus Alchemy's state store: a Worker named
    // `alchemy-state-store` on the cell's own workers.dev subdomain (see
    // containers/provision/README.md). The subdomain is per account, hence the
    // glob on the account label only. The npm version check is left blocked on
    // purpose — it times out in 3s and nothing depends on it.
    allowedHosts: ["api.cloudflare.com", "alchemy-state-store.*.workers.dev"],
    defaultPort: 8080,
    enableInternet: false,
    image: "./containers/provision",
    instanceType: "basic",
    maxInstances: 3,

    /**
     * Forwarded from the Worker's env into the container's at start. The
     * account id is a plain `var` and the token a `wrangler secret`; `secrets`
     * reads either off the Worker env, and a missing one fails the start
     * rather than booting a box that cannot authenticate.
     *
     * `LUNORA_CONTROL_PLANE_SCRIPT` names this Worker so the box can attach it
     * as the consumer of each per-project queue it creates (see
     * `src/fanout/queue.ts`); wrangler suffixes the env name, so it is per cell.
     */
    secrets: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "LUNORA_CONTROL_PLANE_SCRIPT"],
    sleepAfter: "2m",
});
