import { describe, expect, it } from "vitest";

import { parseInboundEmail } from "../src/inbound/parse";

// Fixtures are raw RFC 822 strings — postal-mime is pure-JS and runs in plain
// Node, so no workerd is needed to exercise the parser. CRLF line endings are
// used (as a real wire message would have) so header folding/boundaries parse.
const crlf = (lines: string[]): string => lines.join("\r\n");

const MULTIPART_ALTERNATIVE = crlf([
    "From: Alice <alice@example.com>",
    "To: Bob <bob@example.test>",
    "Subject: Hello there",
    "Message-ID: <msg-1@example.com>",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Plain body line.",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>HTML body line.</p>",
    "--b1--",
    "",
]);

const WITH_ATTACHMENT = crlf([
    "From: sender@example.com",
    "To: rcpt@example.test",
    "Subject: Report attached",
    "Message-ID: <att-1@example.com>",
    'Content-Type: multipart/mixed; boundary="m1"',
    "",
    "--m1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attached.",
    "--m1",
    "Content-Type: text/plain; charset=utf-8",
    'Content-Disposition: attachment; filename="note.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    "aGVsbG8gd29ybGQ=",
    "--m1--",
    "",
]);

const THREADED_REPLY = crlf([
    "From: Carol <carol@example.com>",
    "To: Dave <dave@example.test>",
    "Subject: Re: Original",
    "Message-ID: <reply-1@example.com>",
    "In-Reply-To: <original-1@example.com>",
    "References: <root-0@example.com> <original-1@example.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Replying inline.",
    "",
]);

describe("parseInboundEmail", () => {
    it("parses a multipart/alternative message into text + html", async () => {
        expect.assertions(6);

        const parsed = await parseInboundEmail(MULTIPART_ALTERNATIVE);

        expect(parsed.from).toBe("Alice <alice@example.com>");
        expect(parsed.to).toStrictEqual(["Bob <bob@example.test>"]);
        expect(parsed.subject).toBe("Hello there");
        expect(parsed.messageId).toBe("<msg-1@example.com>");
        expect(parsed.text?.trim()).toBe("Plain body line.");
        expect(parsed.html?.trim()).toBe("<p>HTML body line.</p>");
    });

    it("surfaces a decoded attachment", async () => {
        expect.assertions(3);

        const parsed = await parseInboundEmail(WITH_ATTACHMENT);

        expect(parsed.attachments).toHaveLength(1);

        const [attachment] = parsed.attachments;

        expect(attachment?.filename).toBe("note.txt");
        expect(attachment?.disposition).toBe("attachment");
    });

    it("preserves threading headers (In-Reply-To / References)", async () => {
        expect.assertions(3);

        const parsed = await parseInboundEmail(THREADED_REPLY);

        expect(parsed.inReplyTo).toBe("<original-1@example.com>");
        expect(parsed.references).toContain("<original-1@example.com>");
        expect(parsed.headers["subject"]).toBe("Re: Original");
    });

    it("parses DKIM/SPF/DMARC verdicts from Authentication-Results", async () => {
        expect.assertions(1);

        const authed = crlf([
            "From: Eve <eve@example.com>",
            "To: rcpt@example.test",
            "Subject: Authed",
            "Message-ID: <auth-1@example.com>",
            "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass; dmarc=fail",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "body",
            "",
        ]);

        const parsed = await parseInboundEmail(authed);

        // A method with no identifier property reports a `null` domain — a
        // consumer cannot align it and must treat the pass as unauthenticated.
        expect(parsed.authentication).toStrictEqual({
            dkim: [{ domain: "example.com", result: "pass" }],
            dmarc: [{ domain: null, result: "fail" }],
            spf: [{ domain: null, result: "pass" }],
        });
    });

    it("keeps the domain each verdict is about, through comments and a full smtp.mailfrom address", async () => {
        expect.assertions(1);

        // The shape Cloudflare Email Routing stamps: a parenthesised SPF comment
        // (with `;`-free but `=`-bearing prose), extra properties per method, and
        // `smtp.mailfrom` as a full address rather than a bare domain.
        const authed = crlf([
            "From: Alice <alice@Example.COM>",
            "To: rcpt@example.test",
            "Subject: Authed",
            "Message-ID: <auth-2@example.com>",
            "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=Example.com header.s=s1 header.b=abc; spf=pass (mx.cloudflare.net: domain of alice@example.com designates 1.2.3.4 as permitted sender) smtp.helo=mail.example.com smtp.mailfrom=alice@example.com; arc=none smtp.remote-ip=1.2.3.4; dmarc=pass header.from=example.com policy.dmarc=none",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "body",
            "",
        ]);

        const parsed = await parseInboundEmail(authed);

        expect(parsed.authentication).toStrictEqual({
            dkim: [{ domain: "example.com", result: "pass" }],
            dmarc: [{ domain: "example.com", result: "pass" }],
            spf: [{ domain: "example.com", result: "pass" }],
        });
    });

    it("parses CFWS-spaced method and property fields as valid Authentication-Results", async () => {
        expect.assertions(1);

        // RFC 8601 allows CFWS around the `=` separators, so `dkim = pass
        // header.d = example.com` is as valid as the tight form. Requiring the
        // tight form read these as "method not reported" and had the inbound
        // gate fail a message the receiving MX had fully authenticated.
        const spaced = crlf([
            "From: Eve <eve@example.com>",
            "To: rcpt@example.test",
            "Subject: Spaced",
            "Message-ID: <auth-spaced-1@example.com>",
            "Authentication-Results: mx.cloudflare.net; dkim = pass header.d = example.com; spf = pass smtp.mailfrom = eve@example.com; dmarc = pass header.from = example.com",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "body",
            "",
        ]);

        const parsed = await parseInboundEmail(spaced);

        expect(parsed.authentication).toStrictEqual({
            dkim: [{ domain: "example.com", result: "pass" }],
            dmarc: [{ domain: "example.com", result: "pass" }],
            spf: [{ domain: "example.com", result: "pass" }],
        });
    });

    it("keeps every reported clause when a method appears more than once", async () => {
        expect.assertions(1);

        // RFC 8601 lets one header report a method repeatedly, and real mail does:
        // an ESP-relayed message is DKIM-signed by both the relay and the author
        // domain, and the MX stamps a clause per signature in verification order.
        // Keeping only the first discarded the aligned one whenever it was listed
        // second, and the consumer rejected an authenticated message.
        const relayed = crlf([
            "From: Alice <alice@example.com>",
            "To: rcpt@example.test",
            "Subject: Relayed",
            "Message-ID: <auth-multi-1@example.com>",
            "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=esp.example; dkim=pass header.d=example.com; spf=fail smtp.mailfrom=bounce@esp.example; spf=pass smtp.mailfrom=alice@example.com",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "body",
            "",
        ]);

        const parsed = await parseInboundEmail(relayed);

        expect(parsed.authentication).toStrictEqual({
            dkim: [
                { domain: "esp.example", result: "pass" },
                { domain: "example.com", result: "pass" },
            ],
            dmarc: [],
            spf: [
                { domain: "esp.example", result: "fail" },
                { domain: "example.com", result: "pass" },
            ],
        });
    });

    it("keeps the attacker's identifiers when SPF/DKIM pass for a domain other than From", async () => {
        expect.assertions(1);

        // `spf=pass` + `dkim=pass` here vouch for evil.example, not for the forged
        // victim.example `From`; the domains are what let a consumer tell.
        const forged = crlf([
            "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=evil.example; dmarc=fail (p=REJECT) header.from=victim.example",
            "From: CEO <ceo@victim.example>",
            "To: rcpt@example.test",
            "Subject: approve the wire",
            "Message-ID: <1@evil.example>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "please approve",
            "",
        ]);

        const parsed = await parseInboundEmail(forged);

        expect(parsed.authentication).toStrictEqual({
            dkim: [{ domain: "evil.example", result: "pass" }],
            dmarc: [{ domain: "victim.example", result: "fail" }],
            spf: [{ domain: "evil.example", result: "pass" }],
        });
    });

    it("reads verdicts from the topmost Authentication-Results, ignoring lower spoofed ones", async () => {
        expect.assertions(4);

        // The genuine receiving-MX header is prepended (topmost) per RFC 8601.
        // A lower Authentication-Results is attacker-injectable in the raw message
        // and MUST NOT override the topmost verdicts (which here are all failures).
        const spoofed = crlf([
            "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=evil.example; spf=fail; dmarc=fail",
            "Authentication-Results: forged.invalid; dkim=pass header.d=example.com; spf=pass; dmarc=pass",
            "From: Mallory <mallory@evil.example>",
            "To: rcpt@example.test",
            "Subject: Spoofed",
            "Message-ID: <spoof-1@evil.example>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "body",
            "",
        ]);

        const parsed = await parseInboundEmail(spoofed);

        expect(parsed.authentication.dkim).toStrictEqual([{ domain: "evil.example", result: "fail" }]);
        expect(parsed.authentication.spf).toStrictEqual([{ domain: null, result: "fail" }]);
        expect(parsed.authentication.dmarc).toStrictEqual([{ domain: null, result: "fail" }]);
        // The raw flattened map keeps its documented last-wins behavior.
        expect(parsed.headers["authentication-results"]).toContain("forged.invalid");
    });

    it("reports empty verdict lists when Authentication-Results is absent", async () => {
        expect.assertions(1);

        const parsed = await parseInboundEmail(MULTIPART_ALTERNATIVE);

        expect(parsed.authentication).toStrictEqual({ dkim: [], dmarc: [], spf: [] });
    });

    it("accepts an ArrayBuffer as well as a string", async () => {
        expect.assertions(1);

        const bytes = new TextEncoder().encode(THREADED_REPLY);
        const parsed = await parseInboundEmail(bytes.buffer);

        expect(parsed.from).toBe("Carol <carol@example.com>");
    });
});
