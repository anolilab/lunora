import { vi } from "vitest";

/** A single DoH JSON `Answer` entry: `type` 1 = A (IPv4), 28 = AAAA (IPv6). */
interface DohAnswer {
    data: string;
    type: number;
}

/**
 * A public A record. `resolveDns` is ON by default, so every navigation in the
 * browser suites issues a DoH lookup — without a stub they would hit the real
 * Cloudflare resolver, making the tests network-dependent and slow.
 */
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- a public IP fixture so the DoH re-check passes; no connection is made
const PUBLIC_A_RECORD: DohAnswer = { data: "93.184.216.34", type: 1 };

/**
 * Stub global `fetch` to answer Cloudflare DoH JSON. With no argument every
 * lookup resolves to a public address, so the re-check is a no-op and the guard
 * under test is the only thing deciding; pass `answersByType` to drive a specific
 * verdict (`{ 1: [...], 28: [...] }`, keyed by record type).
 *
 * Shared by both browser suites — they previously each pasted the same stub, and
 * the file-scope copy needed extra lint suppressions the describe-scoped one did
 * not. Restore with `vi.unstubAllGlobals()`.
 */
const stubDohFetch = (answersByType?: Record<number, DohAnswer[]>): ReturnType<typeof vi.fn<(input: string) => Promise<Response>>> => {
    const defaultAnswers: Record<number, DohAnswer[]> = { 1: [PUBLIC_A_RECORD], 28: [] };

    const fetchMock = vi.fn<(input: string) => Promise<Response>>(async (input) => {
        const type = Number(new URL(input).searchParams.get("type"));
        const answer = (answersByType ?? defaultAnswers)[type] ?? [];

        return {
            json: async () => {
                return { Answer: answer };
            },
            ok: true,
        } as unknown as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
};

export type { DohAnswer };
export { PUBLIC_A_RECORD, stubDohFetch };
