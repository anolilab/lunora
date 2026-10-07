/**
 * The internet as the workerd suite sees it: miniflare's `outboundService` for
 * the test worker, so every global `fetch` the package makes leaves workerd for
 * real and lands here (in Node) instead of on the network. It answers the two
 * hosts `@lunora/browser` calls itself.
 *
 * Cloudflare DoH (`cloudflare-dns.com/dns-query`) answers by the queried name:
 * `rebind.example` resolves private, `servfail.example` answers SERVFAIL,
 * `slow-dns.example` answers only after the lookup's ceiling has passed, and
 * every other name resolves to a public address. The Browser Run REST API
 * (`api.cloudflare.com`) answers 429. `fake-internet.test/lookups` reports how
 * many DoH queries arrived for a name, so a suite can count what a guard costs.
 */
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- the public answer the rebinding guard must accept; no connection is made
const PUBLIC_ADDRESS = "93.184.216.34";

/** DoH queries received, by queried name. */
const lookups = new Map<string, number>();

const doh = async (url: URL): Promise<Response> => {
    const name = url.searchParams.get("name");

    lookups.set(name ?? "", (lookups.get(name ?? "") ?? 0) + 1);

    const type = Number(url.searchParams.get("type"));
    const record = (data: string): Response => Response.json({ Answer: type === 1 ? [{ data, type: 1 }] : [], Status: 0 });

    switch (name) {
        case "rebind.example": {
            // eslint-disable-next-line sonarjs/no-hardcoded-ip -- the private answer the rebinding guard must refuse; no connection is made
            return record("10.0.0.7");
        }
        case "servfail.example": {
            return Response.json({ Status: 2 });
        }
        case "slow-dns.example": {
            await new Promise((resolve) => {
                setTimeout(resolve, 1500);
            });

            return record(PUBLIC_ADDRESS);
        }
        default: {
            return record(PUBLIC_ADDRESS);
        }
    }
};

const fakeInternet = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.hostname === "cloudflare-dns.com") {
        return doh(url);
    }

    if (url.hostname === "fake-internet.test" && url.pathname === "/lookups") {
        return Response.json({ count: lookups.get(url.searchParams.get("name") ?? "") ?? 0 });
    }

    if (url.hostname === "api.cloudflare.com") {
        return Response.json({ errors: [{ message: "rate limited" }], success: false }, { status: 429 });
    }

    return new Response(`no route to ${url.hostname} in the fake internet`, { status: 502 });
};

export default fakeInternet;
