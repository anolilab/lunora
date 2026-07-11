/**
 * Custom-domain DNS verification (GAPS.md B1, Zeitwork's flow adapted). A
 * domain is verified when its `_lunora.&lt;hostname>` TXT record equals the
 * domain row's token AND the hostname resolves toward the platform (CNAME to
 * the app domain, or any resolution when `platformTargets` is empty). Pure
 * over an injected DNS-over-HTTPS resolver, so it unit-tests without network.
 */

export interface DnsAnswer {
    data: string;
    type: number;
}

export type DnsResolve = (name: string, type: "CNAME" | "TXT") => Promise<DnsAnswer[]>;

/** TXT record label prefix carrying the verification token. */
export const TXT_PREFIX = "_lunora";

/**
 * Build a resolver over Cloudflare's DNS-over-HTTPS JSON API (1.1.1.1).
 * Injectable fetch for tests; resolution failures return an empty answer set
 * (→ verification simply fails, never throws).
 */
export const createDohResolver =
    (fetchImpl: typeof fetch = fetch): DnsResolve =>
    async (name, type) => {
        try {
            const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
            const response = await fetchImpl(url, { headers: { accept: "application/dns-json" } });

            if (!response.ok) {
                return [];
            }

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Response.json() is `unknown` under workers-types; tsc requires the assertion
            const { Answer: answers } = (await response.json()) as { Answer?: DnsAnswer[] };

            return answers ?? [];
        } catch {
            return [];
        }
    };

const stripQuotesAndDot = (value: string): string => value.replaceAll('"', "").replace(/\.$/u, "").toLowerCase();

export interface VerifyDomainOptions {
    /** Hostnames the domain must CNAME toward (e.g. the app apex). Empty = skip the pointing check. */
    platformTargets?: ReadonlyArray<string>;
    resolve: DnsResolve;
    /** Expected `_lunora.&lt;hostname>` TXT value. */
    txtToken: string;
}

export interface VerifyDomainResult {
    pointing: boolean;
    txtOk: boolean;
    verified: boolean;
}

/** Check the TXT token and (optionally) that the hostname CNAMEs at the platform. */
export const verifyDomain = async (hostname: string, options: VerifyDomainOptions): Promise<VerifyDomainResult> => {
    const host = hostname.toLowerCase();
    const txtAnswers = await options.resolve(`${TXT_PREFIX}.${host}`, "TXT");
    const txtOk = txtAnswers.some((answer) => stripQuotesAndDot(answer.data) === options.txtToken.toLowerCase());

    const targets = (options.platformTargets ?? []).map((target) => target.toLowerCase());
    let pointing = targets.length === 0;

    if (!pointing) {
        const cnameAnswers = await options.resolve(host, "CNAME");

        pointing = cnameAnswers.some((answer) => {
            const target = stripQuotesAndDot(answer.data);

            return targets.some((expected) => target === expected || target.endsWith(`.${expected}`));
        });
    }

    return { pointing, txtOk, verified: txtOk && pointing };
};
