import { defineContainer } from "@lunora/container";

/**
 * Control-plane containers (GAPS.md A3).
 *
 * One so far: the build box that turns a tenant's repo tarball into the Worker
 * module the deploy path uploads. Its image lives in `containers/build/` —
 * see that directory's README for the contract it serves and why it serves a
 * build route alongside the exec one.
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
