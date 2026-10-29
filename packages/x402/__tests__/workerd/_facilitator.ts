/**
 * A facilitator double at the fetch boundary, shared by the workerd suites.
 *
 * The suites run in the same isolate as the test worker, so stubbing the global
 * `fetch` reaches the worker's own facilitator calls too. No real network, no
 * chain.
 */
import { vi } from "vitest";

/** The payer the double reports (the public Hardhat/Anvil account #0). */
const PAYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

interface FacilitatorDouble {
    /** The last path segment of every facilitator call, in order. */
    readonly calls: string[];
    /** The raw `/verify` request bodies. */
    readonly verifyBodies: string[];
}

interface FacilitatorOptions {
    /** How `/settle` answers: success, or an insufficient-funds refusal. Omit for a flow that must never verify or settle. */
    settles?: boolean;
    /** The CAIP-2 network `/supported` lists. Default: Base mainnet. */
    supported?: string;
}

const requestUrl = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

/** Stub the global `fetch` as a facilitator; restore with `vi.unstubAllGlobals()`. */
const stubFacilitator = ({ settles, supported = "eip155:8453" }: FacilitatorOptions = {}): FacilitatorDouble => {
    const double: FacilitatorDouble = { calls: [], verifyBodies: [] };

    vi.stubGlobal(
        "fetch",
        vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
            const url = requestUrl(input);

            double.calls.push(url.split("/").pop() ?? url);

            if (url.endsWith("/supported")) {
                return Response.json({ kinds: [{ network: supported, scheme: "exact", x402Version: 2 }] });
            }

            if (settles !== undefined && url.endsWith("/verify")) {
                double.verifyBodies.push(typeof init?.body === "string" ? init.body : "");

                return Response.json({ isValid: true, payer: PAYER });
            }

            if (settles !== undefined && url.endsWith("/settle")) {
                return Response.json(
                    settles
                        ? { network: supported, payer: PAYER, success: true, transaction: "0xabc" }
                        : { errorReason: "insufficient_funds", network: supported, success: false, transaction: "" },
                );
            }

            throw new Error(`unexpected facilitator call: ${url}`);
        }),
    );

    return double;
};

export type { FacilitatorDouble };
export { PAYER, requestUrl, stubFacilitator };
