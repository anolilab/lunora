import { describe, expect, it } from "vitest";

import createMailer from "../src/create-mailer";
import renderEmail from "../src/render";
import type { MailTransport, SendPayload } from "../src/types";

const WelcomeEmail = ({ name }: { name: string }) => (
    <html lang="en">
        <body>
            <h1>Welcome, {name}!</h1>
            <p>Thanks for joining Lunora.</p>
        </body>
    </html>
);

describe("renderEmail", () => {
    it("renders a React element to HTML and plain text", async () => {
        expect.assertions(5);

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

    it("createMailer.send() renders react templates before handing off to transport", async () => {
        expect.assertions(3);

        const captured: SendPayload[] = [];
        const transport: MailTransport = {
            send: async (payload) => {
                captured.push(payload);

                return { id: "render-1" };
            },
        };
        const mailer = createMailer({ from: "x@x.test", transport });

        await mailer.send({
            react: <WelcomeEmail name="Bob" />,
            subject: "Hi",
            to: "bob@x.test",
        });

        expect(captured[0]?.html).toContain("Bob");
        expect(captured[0]?.html).toContain("Welcome");
        expect(captured[0]?.text?.toLowerCase()).toContain("welcome, bob!");
    });
});
