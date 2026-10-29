import type { Page, WebSocket } from "@playwright/test";

import { expect, test } from "../fixtures/lunora.js";

/**
 * A cookie-session sign-out in one tab, seen from another.
 *
 * Both pages share one browser context, so one cookie jar: signing out in page 1
 * signs page 2 out too. Page 2's app re-renders off better-auth's own cross-tab
 * message, but its Lunora client has to hear of it as well — otherwise its
 * socket stays authenticated as the previous user and keeps serving their rows
 * to whatever mounts next, until it happens to reconnect.
 */

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

/** Every Lunora socket the page opens, and the `identity` frames they carry. */
const trackLunoraSockets = (page: Page): { identities: { subject: unknown }[]; sockets: WebSocket[] } => {
    const sockets: WebSocket[] = [];
    const identities: { subject: unknown }[] = [];

    page.on("websocket", (socket) => {
        if (!socket.url().includes("/_lunora/ws")) {
            return;
        }

        sockets.push(socket);
        socket.on("framereceived", ({ payload }) => {
            if (typeof payload === "string" && payload.includes(`"type":"identity"`)) {
                identities.push(JSON.parse(payload) as { subject: unknown });
            }
        });
    });

    return { identities, sockets };
};

test("a sign-out in one tab retires the other tab's session without a reload", async ({ signedInPage: first }) => {
    const second = await first.context().newPage();
    const secretA = `cross-tab-secret-A-${Date.now()}`;
    const { identities, sockets } = trackLunoraSockets(second);
    let secondLoads = 0;

    await first.goto("/");
    await second.goto("/");
    second.on("load", () => {
        secondLoads += 1;
    });

    await expect(second.getByRole("heading", { name: "My notes" })).toBeVisible();
    await second.getByPlaceholder("Add a note…").fill(secretA);
    await second.getByRole("button", { name: "Add note" }).click();
    await expect(second.getByTestId("notes-list").getByText(secretA)).toBeVisible({ timeout: 5000 });

    const signedInSocket = sockets.at(-1);
    const subjectA = identities.at(-1)?.subject;

    expect(typeof subjectA).toBe("string");

    // Page 1 signs out; page 2 is never touched.
    await first.getByRole("button", { name: "Sign out" }).click();
    await expect(first.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // Page 2's Lunora client retired A's session: the socket authenticated as A
    // is closed, and no socket it opens afterwards is authenticated as A (the
    // playground refuses anonymous upgrades, so a replacement may carry none).
    const framesBefore = identities.length;

    await expect.poll(() => signedInSocket?.isClosed(), { timeout: 5000 }).toBe(true);
    await expect(second.getByText(secretA)).toBeHidden();
    expect(identities.slice(framesBefore).filter((frame) => frame.subject === subjectA)).toStrictEqual([]);
    expect(secondLoads).toBe(0);

    await second.close();
});
