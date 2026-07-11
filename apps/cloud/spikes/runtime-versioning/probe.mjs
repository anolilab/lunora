// Fat-vs-thin spike probe (Node 22, zero deps). Env:
//   PLATFORM_URL  — the deployed platform-runtime worker origin
//   TENANT_URL    — the thin-tenant's public URL (through the platform dispatcher)
//   TENANT_SCRIPT — the tenant's dispatch-namespace script id (default: lunora-spike-thin-tenant)
//
// Usage: PLATFORM_URL=https://… TENANT_URL=https://… node probe.mjs

const PLATFORM_URL = process.env.PLATFORM_URL;
const TENANT_URL = process.env.TENANT_URL;
const TENANT_SCRIPT = process.env.TENANT_SCRIPT ?? "lunora-spike-thin-tenant";

if (!PLATFORM_URL || !TENANT_URL) {
    console.error("PLATFORM_URL and TENANT_URL are required");
    process.exit(1);
}

const results = [];
const record = (name, pass, detail) => {
    results.push({ detail, name, pass });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

// H1 — cross-script DO binding from a namespaced worker.
try {
    const response = await fetch(`${TENANT_URL}/do-binding`);
    const body = await response.json();

    record("H1 cross-script DO binding", response.ok && body.bound === true, JSON.stringify(body));
} catch (error) {
    record("H1 cross-script DO binding", false, String(error));
}

// H2 — callback round-trip cost: 30 samples of a 10-hop chain.
try {
    const perHop = [];

    for (let index = 0; index < 30; index += 1) {
        const response = await fetch(`${PLATFORM_URL}/callback?tenant=${encodeURIComponent(TENANT_SCRIPT)}&hops=10`);
        const body = await response.json();

        if (!response.ok) {
            throw new Error(JSON.stringify(body));
        }

        perHop.push(body.perHopMs);
    }

    perHop.sort((a, b) => a - b);

    const p50 = percentile(perHop, 50);
    const p99 = percentile(perHop, 99);

    // The thin-viability line from the README: < 1 ms p50 per hop.
    record("H2 callback per-hop cost", p50 < 1, `p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms (thin viable only if p50 < 1ms)`);

    // H3 arithmetic — the fat path's patch throughput at ~4 API calls/release
    // inside the 1,200 req / 5 min account budget.
    const releasesPerHour = Math.floor(((1200 / 4) * 60) / 5);

    console.log(`H3   fat fleet re-release throughput: ~${releasesPerHour} tenants/hour/cell (API budget bound, health gates run off-budget)`);
    console.log(`H3   a 10k-tenant cell patches in ~${(10000 / releasesPerHour).toFixed(1)}h; shard cells or raise limits to go faster`);
} catch (error) {
    record("H2 callback per-hop cost", false, String(error));
}

console.log(`\n${results.filter((entry) => entry.pass).length}/${results.length} hypotheses passed`);
process.exit(results.every((entry) => entry.pass) ? 0 : 1);
