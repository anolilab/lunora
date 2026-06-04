import { render } from "@react-email/render";
import type { ReactElement } from "react";
import { bench, describe } from "vitest";

/**
 * `renderEmail` runs two passes over the same React element on every send()/
 * queue() that uses a `react` template — one HTML pass and one plain-text pass.
 * The two passes share no state, so we run them concurrently with Promise.all.
 *
 * React rendering is primarily synchronous CPU work on a single thread, so the
 * concurrent variant does NOT halve wall-clock time; the win is bounded by the
 * async/IO portion of `@react-email/render`. This bench contrasts the old
 * sequential `await`s against the new `Promise.all` so the (modest) delta is
 * observable rather than asserted.
 */

const Welcome = ({ name }: { name: string }): ReactElement => (
    <html lang="en">
        <body>
            <h1>Welcome, {name}!</h1>
            <p>Thanks for joining Cirrus. We are glad to have you on board.</p>
            <ul>
                <li>Set up your profile</li>
                <li>Invite your team</li>
                <li>Read the docs</li>
            </ul>
        </body>
    </html>
);

const element = <Welcome name="Alice" />;

const renderSequential = async (): Promise<{ html: string; text: string }> => {
    const html = await render(element, { pretty: false });
    const text = await render(element, { plainText: true });

    return { html, text };
};

const renderConcurrent = async (): Promise<{ html: string; text: string }> => {
    const [html, text] = await Promise.all([render(element, { pretty: false }), render(element, { plainText: true })]);

    return { html, text };
};

describe("renderEmail: HTML + plain-text passes", () => {
    bench("sequential awaits (old)", async () => {
        await renderSequential();
    });

    bench("Promise.all (new)", async () => {
        await renderConcurrent();
    });
});
