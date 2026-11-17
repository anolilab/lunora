import { render, toPlainText } from "@react-email/render";
import { bench, describe } from "vitest";

/**
 * `renderEmail` needs an HTML body and a plain-text body for every send()/
 * queue() that uses a `react` template.
 *
 * two passes — `render(el)` and `render(el, { plainText: true })`: React renders
 * the element twice; the second pass then runs html-to-text over its own HTML.
 * one pass — `render(el)` once, then `toPlainText(html)` over that same HTML,
 * which is exactly what `render`'s plainText branch does internally.
 */

const rows = Array.from({ length: 30 }, (_, index) => `Line item ${String(index)} — a product with a reasonably long description`);

const element = (
    <html lang="en">
        <head>
            <title>Your order</title>
        </head>
        <body>
            <h1>Welcome, Alice!</h1>
            <p>Thanks for joining Lunora. We are glad to have you on board.</p>
            <img alt="logo" src="https://example.com/logo.png" />
            <table>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row}>
                            <td>{row}</td>
                            <td>
                                <a href="https://example.com/item">View</a>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </body>
    </html>
);

describe("renderEmail: HTML + plain text", () => {
    bench("two render passes (old)", async () => {
        await Promise.all([render(element, { pretty: false }), render(element, { plainText: true })]);
    });

    bench("one render pass + toPlainText (new)", async () => {
        const html = await render(element, { pretty: false });

        toPlainText(html);
    });
});
