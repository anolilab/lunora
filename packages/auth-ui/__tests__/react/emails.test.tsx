import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MagicLinkEmail, OrganizationInvitationEmail, OtpEmail, ResetPasswordEmail, SecurityNoticeEmail, VerifyEmail } from "../../src/emails";

/**
 * These are rendered by `@react-email/render` in production, not by
 * testing-library — but that package walks the same React tree, so rendering
 * here is enough to catch the failure that actually happens: a template whose
 * action URL or code never reaches the markup, which ships as an email nobody
 * can act on.
 */
const html = (element: Parameters<typeof render>[0]): string => render(element).container.innerHTML;

describe("auth email templates", () => {
    it("puts the action URL in the markup, and in copyable plain text", () => {
        expect.assertions(4);

        // Twice on purpose: once as the button's href, once as visible text.
        // Mail clients mangle buttons often enough that the bare URL is the
        // only reliable way for a user to act on the message.
        for (const element of [<VerifyEmail key="verify" url="https://x.dev/v?t=1" />, <ResetPasswordEmail key="reset" url="https://x.dev/r?t=2" />]) {
            const markup = html(element);

            expect(markup).toContain("href=");
            expect(markup.split("https://x.dev").length - 1).toBeGreaterThanOrEqual(2);
        }
    });

    it("renders the magic link", () => {
        expect.assertions(1);

        expect(html(<MagicLinkEmail url="https://x.dev/m" />)).toContain("https://x.dev/m");
    });

    it("renders the one-time code", () => {
        expect.assertions(1);

        expect(html(<OtpEmail code="123456" />)).toContain("123456");
    });

    it("names the organization and the inviter", () => {
        expect.assertions(2);

        const markup = html(<OrganizationInvitationEmail inviterEmail="ada@x.dev" organizationName="Acme" url="https://x.dev/i" />);

        expect(markup).toContain("Acme");
        expect(markup).toContain("ada@x.dev");
    });

    it("still reads sensibly when the inviter is unknown", () => {
        expect.assertions(1);

        // `inviterEmail` is optional in better-auth's invitation payload, so the
        // sentence has to work without it rather than rendering "undefined".
        const markup = html(<OrganizationInvitationEmail organizationName="Acme" url="https://x.dev/i" />);

        expect(markup).not.toContain("undefined");
    });

    it("renders a security notice without an action URL", () => {
        expect.assertions(2);

        const markup = html(<SecurityNoticeEmail heading="Your password was changed" message="This happened just now." />);

        expect(markup).toContain("Your password was changed");
        expect(markup).not.toContain("href=");
    });

    it("uses the app's own product name in the masthead", () => {
        expect.assertions(1);

        expect(html(<VerifyEmail product="Acme" url="https://x.dev/v" />)).toContain("Acme");
    });
});
