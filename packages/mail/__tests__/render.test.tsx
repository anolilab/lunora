import { describe, expect, test } from "vitest";

import { createMailer } from "../src/create-mailer.js";
import { renderEmail } from "../src/render.js";
import type { MailTransport, SendPayload } from "../src/types.js";

const WelcomeEmail = ({ name }: { name: string }) => (
    <html>
        <body>
            <h1>Welcome, {name}!</h1>
            <p>Thanks for joining Cirrus.</p>
        </body>
    </html>
);

describe("renderEmail", () => {
    test("renders a React element to HTML and plain text", async () => {
        const result = await renderEmail(<WelcomeEmail name="Alice" />);

        // react-email injects HTML comment markers around interpolated text,
        // so assert on the surrounding text rather than the exact substring.
        expect(result.html).toContain("Alice");
        expect(result.html).toContain("Welcome");
        expect(result.html).toContain("<html");
        // react-email upper-cases <h1> headings in the plain text output.
        expect(result.text.toLowerCase()).toContain("welcome, alice!");
        expect(result.text).not.toContain("<h1>");
    });

    test("createMailer.send() renders react templates before handing off to transport", async () => {
        const captured: SendPayload[] = [];
        const transport: MailTransport = {
            send: async (payload) => {
                captured.push(payload);

                return { id: "render-1" };
            },
        };
        const mailer = createMailer({ from: "x@x.test", transport });

        await mailer.send({
            to: "bob@x.test",
            subject: "Hi",
            react: <WelcomeEmail name="Bob" />,
        });

        expect(captured[0]?.html).toContain("Bob");
        expect(captured[0]?.html).toContain("Welcome");
        expect(captured[0]?.text?.toLowerCase()).toContain("welcome, bob!");
    });
});
