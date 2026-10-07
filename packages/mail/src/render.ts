import type { ReactElement } from "react";

/**
 * Render a React element to an HTML/text pair suitable for inlining into a
 * provider payload. Wraps `@react-email/render` so we can swap to
 * `@visulima/email`'s react-email template engine without touching callers.
 *
 * The renderer is imported lazily: its workerd build evaluates prettier and
 * html-to-text at module top (~400 KiB), which an app sending pre-rendered
 * HTML should never pay for on cold start.
 */
const renderEmail = async (element: ReactElement): Promise<{ html: string; text: string }> => {
    const { render } = await import("@react-email/render");

    // The two passes share no state and neither depends on the other, so run
    // them together — any async/IO work inside @react-email/render can overlap.
    const [html, text] = await Promise.all([render(element, { pretty: false }), render(element, { plainText: true })]);

    return { html, text };
};

export default renderEmail;
