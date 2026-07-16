import { expect, test } from "../fixtures/lunora.js";

/**
 * Auth + Row-Level Security E2E — two real users, each with their own session
 * cookie and their own WS live-query subscription to `notes:list`. The server
 * narrows the table via the `rls()` read policy in
 * `apps/playground/lunora/notes.ts`; the handler itself reads the WHOLE table,
 * so any note that shows up cross-user is a genuine policy (or subscription
 * identity) leak, not a missing WHERE clause.
 *
 * Why the live path matters: RPC reads run the policy per request, but WS
 * subscriptions are long-lived — a delta broadcast keyed only on
 * (function, args) and not on the socket's identity would push user A's rows
 * into user B's cache. This spec keeps B subscribed while A writes, with a
 * positive control (B's own note arriving live) so a dead subscription can't
 * fake a pass.
 */
const WORKER_URL = process.env.LUNORA_E2E_WORKER_URL ?? "http://localhost:5173";

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("one user's notes are invisible to another through the live WS path", async ({ browser, makeUser, user }) => {
    const userB = await makeUser("user-b");

    const contextA = await browser.newContext({ storageState: await user.request.storageState() });
    const contextB = await browser.newContext({ storageState: await userB.request.storageState() });

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto("/");
    await pageB.goto("/");

    // Both users are signed in and their notes panels are live-subscribed.
    await expect(pageA.getByRole("heading", { name: "My notes" })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "My notes" })).toBeVisible();

    const stamp = Date.now();
    const secretA = `secret-A-${stamp}`;
    const mineB = `mine-B-${stamp}`;

    // A writes a private note and sees it arrive over A's own subscription.
    await pageA.getByPlaceholder("Add a note…").fill(secretA);
    await pageA.getByRole("button", { name: "Add note" }).click();
    await expect(pageA.getByTestId("notes-list").getByText(secretA)).toBeVisible({ timeout: 5000 });

    // Positive control: B's subscription is alive — B's own note arrives live.
    await pageB.getByPlaceholder("Add a note…").fill(mineB);
    await pageB.getByRole("button", { name: "Add note" }).click();
    await expect(pageB.getByTestId("notes-list").getByText(mineB)).toBeVisible({ timeout: 5000 });

    // The leak check: A's note must never have reached B's panel.
    await expect(pageB.getByText(secretA)).toBeHidden();

    // A writes ANOTHER note while B stays subscribed — the write triggers an
    // invalidation on the shared notes table, so B's subscription re-runs
    // server-side. It must re-run under B's identity and still exclude A's rows.
    const secretA2 = `secret-A2-${stamp}`;

    await pageA.getByPlaceholder("Add a note…").fill(secretA2);
    await pageA.getByRole("button", { name: "Add note" }).click();
    await expect(pageA.getByTestId("notes-list").getByText(secretA2)).toBeVisible({ timeout: 5000 });

    // B still shows its own note (subscription healthy) and neither secret.
    await expect(pageB.getByTestId("notes-list").getByText(mineB)).toBeVisible();
    await expect(pageB.getByText(secretA)).toBeHidden();
    await expect(pageB.getByText(secretA2)).toBeHidden();

    // Symmetric check: A never received B's note either.
    await expect(pageA.getByText(mineB)).toBeHidden();

    await contextA.close();
    await contextB.close();
});

test("notes:list over RPC is scoped by the read policy per caller", async ({ makeUser, user }) => {
    const userB = await makeUser("rpc-user-b");
    const stamp = Date.now();

    const add = async (who: typeof user, text: string): Promise<void> => {
        const response = await who.request.post(`/_lunora/rpc`, {
            data: { args: { createdAt: Date.now(), text }, functionPath: "notes:add" },
        });

        expect(response.ok()).toBe(true);
    };

    const list = async (who: typeof user): Promise<string[]> => {
        const response = await who.request.post(`/_lunora/rpc`, {
            data: { args: {}, functionPath: "notes:list" },
        });

        expect(response.ok()).toBe(true);

        const body = (await response.json()) as { result: { text: string }[] };

        return body.result.map((row) => row.text);
    };

    await add(user, `rpc-secret-A-${stamp}`);
    await add(userB, `rpc-mine-B-${stamp}`);

    const listA = await list(user);
    const listB = await list(userB);

    expect(listA).toContain(`rpc-secret-A-${stamp}`);
    expect(listA).not.toContain(`rpc-mine-B-${stamp}`);

    expect(listB).toContain(`rpc-mine-B-${stamp}`);
    expect(listB).not.toContain(`rpc-secret-A-${stamp}`);
});

test("anonymous callers can neither read nor write notes", async ({ request, user }) => {
    const stamp = Date.now();

    // Seed one real note so an RLS bypass would have something to leak.
    const seeded = await user.request.post(`/_lunora/rpc`, {
        data: { args: { createdAt: Date.now(), text: `anon-bait-${stamp}` }, functionPath: "notes:add" },
    });

    expect(seeded.ok()).toBe(true);

    // `request` here is Playwright's plain, cookie-less API context.
    const readResponse = await request.post(`${WORKER_URL}/_lunora/rpc`, {
        data: { args: {}, functionPath: "notes:list" },
        headers: { Origin: WORKER_URL },
    });

    if (readResponse.ok()) {
        const body = (await readResponse.json()) as { result: { text: string }[] };

        // The read policy returns `false` for anonymous → zero rows.
        expect(body.result).toEqual([]);
    } else {
        // Rejecting outright is fine too — either way nothing leaks.
        expect(readResponse.status()).toBeGreaterThanOrEqual(400);
    }

    // The insert policy pins ownerId to the caller's id; anonymous has none.
    const writeResponse = await request.post(`${WORKER_URL}/_lunora/rpc`, {
        data: { args: { createdAt: Date.now(), text: `anon-write-${stamp}` }, functionPath: "notes:add" },
        headers: { Origin: WORKER_URL },
    });

    expect(writeResponse.status()).toBeGreaterThanOrEqual(400);
});
