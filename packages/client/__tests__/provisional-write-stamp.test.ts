import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeExpectedSubjectHeader, EXPECT_SUBJECT_HEADER } from "../../../shared/identity-header";
import { declareSessionSource, notifySessionChanged } from "../../../shared/session-change";
import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference, User } from "../src/types";

/**
 * A write composed on page load, before the first `/get-session` answer, used to
 * be stamped with the provisional `null` the fingerprint holds in that window.
 * Once the user's own session answered, the replay gate judged `null` against
 * `subj:<id>` as a different user and dropped the write — a click that landed a
 * few milliseconds too early was lost. The stamp now stands for whichever
 * identity this client settles on first, and nothing else: a reload, or a user
 * switch after the first answer, is judged exactly as a `null` stamp was.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const settle = async (): Promise<void> => {
    for (let index = 0; index < 10; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

const sockets: { open: () => void; receive: (payload: unknown) => void }[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readyState = 0;

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor() {
            sockets.push({
                open: () => {
                    this.readyState = 1;

                    for (const listener of this.listeners.get("open") ?? []) {
                        listener();
                    }
                },
                receive: (payload: unknown) => {
                    for (const listener of this.listeners.get("message") ?? []) {
                        listener({ data: JSON.stringify(payload) });
                    }
                },
            });
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public close(): void {
            this.readyState = 3;
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        // eslint-disable-next-line class-methods-use-this -- replays under test ride HTTP, not the socket
        public send(): void {}
    }

    return WS as unknown as typeof WebSocket;
};

const json = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" } });

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A `/get-session` answer: a user, nobody, a bare HTTP status, or a transport failure. */
type Answer = Error | number | User | null;

/**
 * A cookie-session client whose `/get-session` probes each wait for the test to
 * answer them. `declared` leaves resolution undeclared on the client itself, as
 * an app that reads its session through better-auth and `lunoraSessionSync()`.
 */
const cookieClient = (options: { declared?: boolean } = {}) => {
    const pendingAnswers: ((answer: Answer) => void)[] = [];
    const fetchMock = vi.fn<Fetch>(async (url, init) => {
        if (url.endsWith("/get-session")) {
            const answer = await new Promise<Answer>((resolve) => {
                pendingAnswers.push(resolve);
            });

            if (answer instanceof Error) {
                throw answer;
            }

            if (typeof answer === "number") {
                return new Response("", { status: answer });
            }

            return json(answer === null ? null : { session: {}, user: answer });
        }

        const { calls } = JSON.parse(init.body as string) as { calls?: { id: number }[] };

        return calls === undefined
            ? json({ result: { ok: true } })
            : json({
                  results: calls.map((call) => {
                      return { body: { result: { ok: true } }, id: call.id };
                  }),
              });
    });
    const client = new LunoraClient({
        fetch: fetchMock as unknown as typeof fetch,
        heartbeatIntervalMs: 0,
        offlineQueue: { queueBeforeFirstConnect: true },
        url: "http://app.test",
        WebSocket: createMockWebSocket(),
    });

    if (options.declared !== true) {
        // What `@lunora/client/auth`'s identity store does when it attaches.
        client.expectIdentityResolution();
    }

    /** Answer the probe already waiting — one the client started itself. */
    const answerProbe = async (answer: Answer): Promise<void> => {
        await vi.waitFor(() => {
            expect(pendingAnswers).toHaveLength(1);
        });

        pendingAnswers.shift()?.(answer);
        await settle();
    };

    /** Ask who is signed in, and answer `answer`. */
    const resolveSession = async (answer: Answer): Promise<void> => {
        const probe = client.getCurrentUser();

        await answerProbe(answer);
        await probe;
    };

    return { answerProbe, client, fetchMock, pendingAnswers, resolveSession };
};

const alice = { email: "alice@example.test", id: "user-a" } as User;
const bob = { email: "bob@example.test", id: "user-b" } as User;

describe("a write stamped before the first session answer", () => {
    it("is held while unsettled, then replays as the user the first answer names", async () => {
        expect.hasAssertions();

        const { client, resolveSession } = cookieClient();
        const stamp = client.writeIdentityStamp();

        // The `null` it used to be is exactly what the first answer would refuse.
        expect(stamp).not.toBeNull();
        expect(client.replayIdentityVerdict(stamp).verdict).toBe("unknown");

        await resolveSession(alice);

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("match");
        expect(client.replayIdentityVerdict(null).verdict).toBe("mismatch");
    });

    it("stays bound to the first identity: a later switch to another user drops it", async () => {
        expect.hasAssertions();

        const { client, resolveSession } = cookieClient();
        const stamp = client.writeIdentityStamp();

        await resolveSession(alice);
        await resolveSession(bob);

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("mismatch");
    });

    it("binds to nobody when the first answer is no session, so a later sign-in drops it", async () => {
        expect.hasAssertions();

        const { client, resolveSession } = cookieClient();
        const stamp = client.writeIdentityStamp();

        await resolveSession(null);

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("match");

        await resolveSession(alice);

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("mismatch");
    });

    it("is not bound by a response that names nobody, so the answer after it binds it", async () => {
        expect.hasAssertions();

        const { client, resolveSession } = cookieClient();
        const stamp = client.writeIdentityStamp();

        // A 403 is as likely a WAF as the auth server: not a verdict on anyone.
        await resolveSession(403);
        await resolveSession(alice);

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("match");
    });

    it("is retired by a session change before the first answer, never bound to the identity after it", async () => {
        expect.hasAssertions();

        vi.stubGlobal("document", {});

        const { answerProbe, client } = cookieClient();
        const early = client.writeIdentityStamp();
        // A sign-in or sign-out — here, or in another tab — before anyone answered.
        const change = notifySessionChanged();
        const later = client.writeIdentityStamp();

        await answerProbe(bob);
        await change;

        expect(client.replayIdentityVerdict(early).verdict).toBe("mismatch");
        expect(client.replayIdentityVerdict(later).verdict).toBe("match");

        client.close();
        vi.unstubAllGlobals();
    });

    it("is not handed to a write composed after a bearer bound it and then signed out", () => {
        expect.assertions(2);

        const { client } = cookieClient();
        const early = client.writeIdentityStamp();

        client.setAuthToken("token-a", "user-a");
        client.setAuthToken(null);

        // Composed signed out: anonymous, not the early write's stamp bound to user-a.
        expect(client.writeIdentityStamp()).toBeNull();
        expect(client.writeIdentityStamp()).not.toBe(early);
    });

    it("is not bound by a stale socket answer from the session a change replaced", async () => {
        expect.hasAssertions();

        sockets.length = 0;
        vi.stubGlobal("document", {});

        const { answerProbe, client } = cookieClient();

        // A socket upgraded under alice's cookie: its identity frame is still on the way.
        client.subscribe(fnRef("todos.list"), {}, () => {});
        await settle();
        sockets.at(-1)?.open();
        await settle();

        // The session changes to bob before anything answered, and a write is composed.
        const change = notifySessionChanged();
        const later = client.writeIdentityStamp();

        // alice's delayed frame lands first, then bob's probe answers.
        sockets.at(-1)?.receive({ subject: "user-a", type: "identity" });
        await settle();
        await answerProbe(bob);
        await change;

        expect(client.currentIdentity()).toBe("subj:user-b");
        expect(client.replayIdentityVerdict(later).verdict).toBe("match");

        client.close();
        vi.unstubAllGlobals();
    });

    it("follows a same-credential relabel, so a token refresh keeps it", async () => {
        expect.hasAssertions();

        const { client, resolveSession } = cookieClient();
        const stamp = client.writeIdentityStamp();

        // Bound to the token hash, then relabelled to the subject that token resolves to.
        client.setAuthToken("token-a");
        await resolveSession(alice);
        client.setAuthToken("token-b", "user-a");

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("match");
    });

    it("is bound by a bearer the app sets itself, rather than held with no answer coming", () => {
        expect.assertions(1);

        const { client } = cookieClient();
        const stamp = client.writeIdentityStamp();

        client.setAuthToken("token-a", "user-a");

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("match");
    });

    it("reads as anonymous on another client, as a persisted `null` stamp did", async () => {
        expect.hasAssertions();

        const earlierPage = cookieClient().client;
        const stamp = earlierPage.writeIdentityStamp();
        const { client, resolveSession } = cookieClient();

        await resolveSession(alice);

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("mismatch");
    });

    it("is never minted once the identity has settled, nor by a client that resolves none", async () => {
        expect.hasAssertions();

        const { client, resolveSession } = cookieClient();

        await resolveSession(alice);

        expect(client.writeIdentityStamp()).toBe("subj:user-a");

        const noAuth = new LunoraClient({ fetch: vi.fn<Fetch>() as unknown as typeof fetch, url: "http://app.test", WebSocket: createMockWebSocket() });

        expect(noAuth.writeIdentityStamp()).toBeNull();
    });
});

describe("the built-in offline queue", () => {
    /** Queue one write before the first answer, through `answer`, then open the socket. */
    const queueAround = async (answer: (session: ReturnType<typeof cookieClient>) => Promise<void>) => {
        sockets.length = 0;

        const session = cookieClient();
        const { client, fetchMock } = session;

        client.subscribe(fnRef("todos.list"), {}, () => {});

        const outcome = client.mutation(fnRef("todos.add"), { text: "early click" }).then(
            () => "committed",
            (error: unknown) => String((error as { code?: string }).code),
        );

        await settle();
        await answer(session);
        sockets.at(-1)?.open();

        return { client, fetchMock, outcome };
    };

    it("sends a write queued before a response that names nobody, as nobody, instead of holding it", async () => {
        expect.hasAssertions();

        const { fetchMock, outcome } = await queueAround(async ({ resolveSession }) => resolveSession(403));

        await expect(outcome).resolves.toBe("committed");

        const replay = fetchMock.mock.calls.find(([url]) => url.endsWith("/_lunora/rpc") || url.endsWith("/_lunora/rpc-batch"));

        expect((replay?.[1].headers as Record<string, string> | undefined)?.[EXPECT_SUBJECT_HEADER]).toBe(encodeExpectedSubjectHeader(null));
    });

    it("rejects a write queued before a session change, rather than sending it as the user after it", async () => {
        expect.hasAssertions();

        vi.stubGlobal("document", {});

        const { client, outcome } = await queueAround(async ({ answerProbe }) => {
            const change = notifySessionChanged();

            await answerProbe(bob);
            await change;
        });

        await expect(outcome).resolves.toBe("OFFLINE_IDENTITY_CHANGED");

        client.close();
        vi.unstubAllGlobals();
    });

    it("replays a write queued before the first session answer as that user, naming them to the worker", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const { client, fetchMock, resolveSession } = cookieClient();
        const settled: { code?: string; status: string }[] = [];

        client.onMutationSettled((event) => {
            settled.push({ code: (event.error as { code?: string } | undefined)?.code, status: event.status });
        });
        client.subscribe(fnRef("todos.list"), {}, () => {});

        const outcome = client.mutation(fnRef("todos.add"), { text: "early click" }).then(
            () => "committed",
            (error: unknown) => String((error as { code?: string }).code),
        );

        await settle();
        await resolveSession(alice);
        sockets.at(-1)?.open();

        await expect(outcome).resolves.toBe("committed");
        expect(settled.map((event) => event.code)).not.toContain("OFFLINE_IDENTITY_CHANGED");

        const replay = fetchMock.mock.calls.find(([url]) => url.endsWith("/_lunora/rpc") || url.endsWith("/_lunora/rpc-batch"));

        expect((replay?.[1].headers as Record<string, string> | undefined)?.[EXPECT_SUBJECT_HEADER]).toBe(encodeExpectedSubjectHeader("user-a"));
    });
});

/** The page-wide declaration lives on a `Symbol.for` global; clear it between tests. */
const clearDeclaration = (): void => {
    const holder = (globalThis as unknown as Record<symbol, { sourceDeclared?: boolean } | undefined>)[Symbol.for("lunora:session-change")];

    if (holder !== undefined) {
        holder.sourceDeclared = false;
    }
};

describe("a page whose session source is declared (`lunoraSessionSync()`)", () => {
    afterEach(() => {
        clearDeclaration();
        vi.unstubAllGlobals();
    });

    /**
     * Queue one write before anything has answered, open the socket, and hand it
     * `subject` as its first identity frame.
     *
     * `declared: false` is the identity store's declaration instead, with no
     * probe running — the store's own probe failed — so the frame is the only
     * answer the client gets.
     */
    const queueThenAnswer = async (subject: null | string, { declared = true }: { declared?: boolean } = {}) => {
        sockets.length = 0;

        if (declared) {
            vi.stubGlobal("document", {});
            declareSessionSource();
        }

        const { client, fetchMock } = cookieClient({ declared });

        client.subscribe(fnRef("todos.list"), {}, () => {});

        const stamp = client.writeIdentityStamp();
        const outcome = client.mutation(fnRef("todos.add"), { text: "early click" }).then(
            () => "committed",
            (error: unknown) => String((error as { code?: string }).code),
        );

        await settle();
        sockets.at(-1)?.open();
        await settle();
        sockets.at(-1)?.receive({ subject, type: "identity" });

        const replay = async (): Promise<Record<string, string> | undefined> => {
            await vi.waitFor(() => {
                expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/_lunora/rpc") || url.endsWith("/_lunora/rpc-batch"))).toBe(true);
            });

            return fetchMock.mock.calls.find(([url]) => url.endsWith("/_lunora/rpc") || url.endsWith("/_lunora/rpc-batch"))?.[1].headers as
                | Record<string, string>
                | undefined;
        };

        return { client, outcome, replay, stamp };
    };

    it("stamps a write composed before the first identity frame provisionally, and replays it as the user the frame names", async () => {
        expect.hasAssertions();

        const { outcome, replay, stamp } = await queueThenAnswer("user-a");

        expect(stamp).not.toBeNull();
        await expect(outcome).resolves.toBe("committed");

        const headers = await replay();

        expect(headers?.[EXPECT_SUBJECT_HEADER]).toBe(encodeExpectedSubjectHeader("user-a"));
    });

    it("replays a held write once the first identity frame answers nobody, with no probe running", async () => {
        expect.hasAssertions();

        // Nobody changes no identity, so `setAuthToken` re-flushes nothing, and
        // with no probe in flight `releaseSessionProbe` never runs either.
        const { outcome, replay } = await queueThenAnswer(null, { declared: false });

        await expect(outcome).resolves.toBe("committed");

        // Queued by nobody, so the worker must find nobody.
        const headers = await replay();

        expect(headers?.[EXPECT_SUBJECT_HEADER]).toBe(encodeExpectedSubjectHeader(null));
    });

    it("asks who is signed in itself when the declaration is all it has, so no socket answer is needed", async () => {
        expect.hasAssertions();

        vi.stubGlobal("document", {});
        declareSessionSource();

        const { answerProbe, client } = cookieClient({ declared: true });
        // No socket ever opens: a ticketed upgrade, or WebSockets blocked outright.
        const stamp = client.writeIdentityStamp();

        await answerProbe(alice);

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("match");
        expect(client.currentIdentity()).toBe("subj:user-a");
    });

    it("asks again once the connection is live, when its own probe could not reach the endpoint", async () => {
        expect.hasAssertions();

        sockets.length = 0;
        vi.stubGlobal("document", {});
        declareSessionSource();

        const { answerProbe, client } = cookieClient({ declared: true });
        const stamp = client.writeIdentityStamp();

        await answerProbe(new TypeError("network down"));

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("unknown");

        client.subscribe(fnRef("todos.list"), {}, () => {});
        await settle();
        sockets.at(-1)?.open();
        await answerProbe(alice);

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("match");
    });

    it("asks again after a backoff when its probe fails while the connection is already live", async () => {
        expect.hasAssertions();

        sockets.length = 0;
        vi.stubGlobal("document", {});
        declareSessionSource();

        const { client, pendingAnswers } = cookieClient({ declared: true });

        client.subscribe(fnRef("todos.list"), {}, () => {});
        await settle();
        sockets.at(-1)?.open();
        await settle();

        // Live before the probe starts, so no status transition will follow its failure.
        const stamp = client.writeIdentityStamp();

        await vi.waitFor(() => {
            expect(pendingAnswers).toHaveLength(1);
        });

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        try {
            pendingAnswers.shift()?.(new TypeError("network down"));
            await vi.advanceTimersByTimeAsync(0);

            expect(pendingAnswers).toHaveLength(0);

            await vi.advanceTimersByTimeAsync(1000);
        } finally {
            vi.useRealTimers();
        }

        await vi.waitFor(() => {
            expect(pendingAnswers).toHaveLength(1);
        });
        pendingAnswers.shift()?.(alice);
        await settle();

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("match");

        client.close();
    });

    it("keeps asking at a capped delay while the endpoint stays down, never giving up", async () => {
        expect.hasAssertions();

        sockets.length = 0;
        vi.stubGlobal("document", {});
        declareSessionSource();

        const { client, pendingAnswers } = cookieClient({ declared: true });

        client.subscribe(fnRef("todos.list"), {}, () => {});
        await settle();
        sockets.at(-1)?.open();
        await settle();

        const stamp = client.writeIdentityStamp();

        await vi.waitFor(() => {
            expect(pendingAnswers).toHaveLength(1);
        });

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        try {
            // The first probe and six re-asks fail: past any fixed retry count. Each
            // step advances exactly to the next re-ask (1s doubling, capped at 30s),
            // short of that probe's own deadline.
            for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
                pendingAnswers.shift()?.(new TypeError("network down"));
                // eslint-disable-next-line no-await-in-loop -- each re-ask is scheduled only after the previous one fails
                await vi.advanceTimersByTimeAsync(delay);

                expect(pendingAnswers).toHaveLength(1);
            }
        } finally {
            vi.useRealTimers();
        }

        // The endpoint recovers: the next re-ask is answered and the early write is bound.
        pendingAnswers.shift()?.(alice);
        await settle();

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("match");

        client.close();
    });

    it("gives up on a probe that never answers, so the retry can ask again", async () => {
        expect.hasAssertions();

        sockets.length = 0;
        vi.stubGlobal("document", {});
        declareSessionSource();

        const { client, fetchMock, pendingAnswers } = cookieClient({ declared: true });

        client.subscribe(fnRef("todos.list"), {}, () => {});
        await settle();
        sockets.at(-1)?.open();
        await settle();

        const probes = () => fetchMock.mock.calls.filter(([url]) => url.endsWith("/get-session"));

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        let stamp: null | string;

        try {
            // A stalled proxy: the first probe never answers at all.
            stamp = client.writeIdentityStamp();
            await vi.advanceTimersByTimeAsync(0);

            expect(probes()).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(10_000);

            expect(probes()[0]?.[1].signal?.aborted).toBe(true);

            await vi.advanceTimersByTimeAsync(1000);

            expect(probes()).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }

        // The re-ask is answered; the stalled one, answered late, changes nothing.
        pendingAnswers.pop()?.(alice);
        await settle();
        pendingAnswers.pop()?.(bob);
        await settle();

        expect(client.replayIdentityVerdict(stamp).verdict).toBe("match");
        expect(client.currentIdentity()).toBe("subj:user-a");

        client.close();
    });

    it("declares nothing off the browser, where one process serves every request", () => {
        expect.assertions(1);

        declareSessionSource();

        expect(cookieClient({ declared: true }).client.writeIdentityStamp()).toBeNull();
    });
});
