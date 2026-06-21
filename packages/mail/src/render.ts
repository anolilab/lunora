import { render } from "@react-email/render";
import type { ReactElement } from "react";

/**
 * Render a React element to an HTML/text pair suitable for inlining into a
 * provider payload. Wraps `@react-email/render` so we can swap to
 * `@visulima/email`'s react-email template engine without touching callers.
 */
const renderEmail = async (element: ReactElement): Promise<{ html: string; text: string }> => {
    // The two passes share no state and neither depends on the other, so run
    // them together — any async/IO work inside @react-email/render can overlap.
    const [html, text] = await Promise.all([render(element, { pretty: false }), render(element, { plainText: true })]);

    return { html, text };
};

export default renderEmail;
