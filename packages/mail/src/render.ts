import type { ReactElement } from "react";

/**
 * Render a React element to an HTML/text pair suitable for inlining into a
 * provider payload. Wraps `@react-email/render` so we can swap to
 * `@visulima/email`'s react-email template engine without touching callers.
 *
 * The renderer is imported lazily so its top-level evaluation (prettier and
 * html-to-text, in its workerd build) is deferred until the first React render
 * instead of running on cold start. Bundlers may still include the code.
 */
const renderEmail = async (element: ReactElement): Promise<{ html: string; text: string }> => {
    const { render, toPlainText } = await import("@react-email/render");

    // One React pass: `render(el, { plainText: true })` is `toPlainText` over the
    // same markup, so a second pass would only re-render the tree (and could
    // disagree with the HTML for a component that is not deterministic).
    const html = await render(element, { pretty: false });

    return { html, text: toPlainText(html) };
};

export default renderEmail;
