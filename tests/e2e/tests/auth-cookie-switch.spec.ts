import type { Dialog, WebSocket } from "@playwright/test";

import { expect, test } from "../fixtures/lunora.js";

/**
 * Cookie-session identity changes inside one tab — no reload in between.
 *
 * A cookie session holds no token, so a sign-out and the next person's sign-in
 * change nothing the Lunora client can see on its own: the socket it opened
 * stays authenticated as the previous user, and the React cache keeps that
 * user's rows. These specs drive the playground (cookie auth, `notes:list`
 * over a live WS subscription, private per user) through both transitions and
 * check the previous user's rows never reach the next one.
 */

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("a sign-out and another user's sign-in in the same tab never show the previous user's notes", async ({ makeUser, signedInPage: page }) => {
    const userB = await makeUser("user-b");
    const stamp = Date.now();
    const secretA = `secret-A-${stamp}`;
    const mineB = `mine-B-${stamp}`;
    // Every Lunora socket the tab opens, and the `identity` frames they carry.
    const lunoraSockets: WebSocket[] = [];
    const identities: unknown[] = [];

    page.on("websocket", (socket) => {
        if (!socket.url().includes("/_lunora/ws")) {
            return;
        }

        lunoraSockets.push(socket);
        socket.on("framereceived", ({ payload }) => {
            if (typeof payload === "string" && payload.includes(`"type":"identity"`)) {
                identities.push(JSON.parse(payload));
            }
        });
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "My notes" })).toBeVisible();

    await page.getByPlaceholder("Add a note…").fill(secretA);
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByTestId("notes-list").getByText(secretA)).toBeVisible({ timeout: 5000 });

    const signedInSocket = lunoraSockets.at(-1);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // The socket A was authenticated on is retired at sign-out, not left
    // serving A's rows to whoever uses the tab next.
    await expect.poll(() => signedInSocket?.isClosed()).toBe(true);

    const subjectA = (identities.at(-1) as { subject?: unknown } | undefined)?.subject;

    expect(typeof subjectA).toBe("string");

    // B signs in through the form in the same tab.
    await page.getByLabel("Email").fill(userB.email);
    await page.getByLabel("Password").fill(userB.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "My notes" })).toBeVisible();

    // Positive control: B's own subscription is live.
    await page.getByPlaceholder("Add a note…").fill(mineB);
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByTestId("notes-list").getByText(mineB)).toBeVisible({ timeout: 5000 });

    await expect(page.getByTestId("notes-list")).not.toContainText(secretA);

    // ...served over a socket the server authenticated as B, not as A.
    const subjectB = (identities.at(-1) as { subject?: unknown } | undefined)?.subject;

    expect(typeof subjectB).toBe("string");
    expect(subjectB).not.toBe(subjectA);
});

test("a message A queued offline is never written as B after the cookie changes hands", async ({ browser, makeUser, signedInPage: page, user }) => {
    const userB = await makeUser("replay-user-b");
    const channel = `switch-${Date.now()}`;
    const queuedByA = `queued-by-A-${Date.now()}`;
    const context = page.context();
    // A second tab that stays A the whole time, watching the channel.
    const observerContext = await browser.newContext({ storageState: await user.request.storageState() });
    const observer = await observerContext.newPage();

    await page.goto("/");
    await observer.goto("/");

    page.once("dialog", async (dialog: Dialog) => dialog.accept(channel));
    await page.getByRole("button", { name: "+ New channel" }).click();
    await page.getByRole("button", { name: channel }).click();
    await observer.getByRole("button", { name: channel }).click();

    await context.setOffline(true);
    await page.getByPlaceholder("Type a message…").fill(queuedByA);
    await page.getByRole("button", { name: "Send" }).click();
    // Queued: painted optimistically, not sent.
    await expect(page.getByText(queuedByA)).toBeVisible();

    // While offline, A's cookie is replaced by B's — a sign-out and B's sign-in
    // the tab never hears about.
    await context.clearCookies();
    await context.addCookies((await userB.request.storageState()).cookies);

    // The replay of A's write, and the session probe its refusal triggers.
    const replay = page.waitForResponse((response) => response.url().endsWith("/_lunora/rpc") && (response.request().postData() ?? "").includes(queuedByA), {
        timeout: 15_000,
    });

    await context.setOffline(false);

    const refused = await replay;

    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "IDENTITY_MISMATCH" } });

    // The tab learns it is B, drops the write for good, and takes it off screen.
    await expect(page.getByText(queuedByA)).toBeHidden({ timeout: 10_000 });

    // Positive control: the observer's channel is live — its own message lands.
    const control = `control-${Date.now()}`;

    await observer.getByPlaceholder("Type a message…").fill(control);
    await observer.getByRole("button", { name: "Send" }).click();
    await expect(observer.getByText(control)).toBeVisible({ timeout: 5000 });
    await expect(observer.getByText(queuedByA)).toBeHidden();

    await observerContext.close();
});
