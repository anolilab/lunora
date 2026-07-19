/**
 * Test entry-point Worker for `@lunora/x402` workerd integration tests.
 *
 * Mounts a `withX402`-gated handler the way a Lunora HTTP action would, so the
 * charge middleware (facilitator init + the 402 challenge flow) runs inside a
 * real worker `fetch` handler. The facilitator's `/supported` endpoint is
 * mocked at the fetch boundary by the test (the worker runs in the same
 * isolate as the tests, so the stubbed global `fetch` applies to this worker's
 * outbound calls too) — no real chain, no network.
 */
import { withX402 } from "../../src/charge/http-action";
import type { X402ChargeConfig } from "../../src/config";

const chargeConfig: X402ChargeConfig = {
    network: "base",
    price: "$0.01",
    recipient: { evm: "0x1111111111111111111111111111111111111111" },
};

/** The paid resource: only reachable once payment verifies (never, in this suite). */
const gated = withX402(chargeConfig, () => new Response("paid-secret", { status: 200 }));

const testWorker = {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/paid/report") {
            return gated({}, request);
        }

        return new Response("x402-test-worker", { status: 200 });
    },
};

export default testWorker;
export { chargeConfig };
