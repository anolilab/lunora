import { describe, expect, it } from "vitest";

import type { InboundEmail } from "../src/inbound/parse";
import { authenticatesFrom, parseInboundEmail } from "../src/inbound/parse";

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

    it("parses a method version and CFWS around a property's dot", async () => {
        expect.assertions(1);

        // RFC 8601: `method = Keyword [ [CFWS] "/" [CFWS] 1*DIGIT ]` and
        // `propspec = ptype [CFWS] "." [CFWS] property [CFWS] "=" [CFWS] pvalue`.
        // A clause written either way reported NOTHING — the method regex stopped
        // at the version and the property regex at the spaced dot — so a fully
        // authenticated message read as unauthenticated and the inbound gate
        // rejected it.
        const versioned = crlf([
            "From: Alice <alice@example.com>",
            "To: rcpt@example.test",
            "Subject: Versioned",
            "Message-ID: <auth-version-1@example.com>",
            "Authentication-Results: mx.cloudflare.net; dkim/1=pass header . d = example.com; spf / 1 = pass smtp . mailfrom = alice@example.com; dmarc/1=pass header.from=example.com",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "body",
            "",
        ]);

        const parsed = await parseInboundEmail(versioned);

        expect(parsed.authentication).toStrictEqual({
            dkim: [{ domain: "example.com", result: "pass" }],
            dmarc: [{ domain: "example.com", result: "pass" }],
            spf: [{ domain: "example.com", result: "pass" }],
        });
    });

    it("does not let a quoted value forge a CFWS-spaced property the MX never wrote", async () => {
        expect.assertions(1);

        // Accepting CFWS around the `ptype.property` dot is what RFC 8601 asks
        // for, but a quoted local part is sender text sitting INSIDE the clause
        // and EARLIER than the genuine property — first match wins. So an `=`
        // inside a quoted-string is neutralised along with `;`: without that,
        // this header would report `header.d=victim.example` on a DKIM clause the
        // MX failed.
        const injected = crlf([
            'Authentication-Results: mx.cloudflare.net; dkim=fail header.i="x header . d = victim.example" header.d=evil.example; spf=fail; dmarc=fail header.from=victim.example',
            "From: CEO <ceo@victim.example>",
            "To: rcpt@example.test",
            "Subject: approve the wire",
            "Message-ID: <inject-propspec@evil.example>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "please approve",
            "",
        ]);

        const parsed = await parseInboundEmail(injected);

        expect(parsed.authentication).toStrictEqual({
            dkim: [{ domain: "evil.example", result: "fail" }],
            dmarc: [{ domain: "victim.example", result: "fail" }],
            spf: [{ domain: null, result: "fail" }],
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

    // A sender-chosen `;` inside a quoted-string is NOT a clause separator. RFC
    // 8601 lets a property value be a quoted-string and RFC 5321 lets a local
    // part be quoted, so an MX echoing a crafted `MAIL FROM` into
    // `smtp.mailfrom=` puts attacker text — semicolons included — inside one
    // clause's value. Splitting there manufactures a whole extra clause the
    // receiving MX never asserted, and a consumer asking "does ANY clause pass
    // and align?" then accepts a message that authenticated nothing.
    it("does not split a clause on a `;` inside a quoted smtp.mailfrom value", async () => {
        expect.assertions(1);

        const injected = crlf([
            'Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom="x;spf=pass smtp.mailfrom=root@victim.example"@evil.example; dkim=none; dmarc=fail header.from=victim.example',
            "From: CEO <ceo@victim.example>",
            "To: rcpt@example.test",
            "Subject: approve the wire",
            "Message-ID: <inject-1@evil.example>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "please approve",
            "",
        ]);

        const parsed = await parseInboundEmail(injected);

        // ONE spf clause, and it is the MX's own `fail`. The identifier read back
        // out of the quoted value is garbage (`x`) rather than a real domain —
        // deliberately so: it can never equal a `From` domain, so it vouches for
        // nothing.
        expect(parsed.authentication).toStrictEqual({
            dkim: [{ domain: null, result: "none" }],
            dmarc: [{ domain: "victim.example", result: "fail" }],
            spf: [{ domain: "x", result: "fail" }],
        });
    });

    it("does not manufacture a dkim clause from a `;` inside a quoted spf value", async () => {
        expect.assertions(1);

        // Cross-method shape: the injected clause names a DIFFERENT method, so it
        // lands after the genuine `dkim=none` — invisible to a first-match reader,
        // decisive for an "any clause" one.
        const injected = crlf([
            'Authentication-Results: mx.cloudflare.net; dkim=none; spf=fail smtp.mailfrom="x;dkim=pass header.d=victim.example"@evil.example; dmarc=fail header.from=victim.example',
            "From: CEO <ceo@victim.example>",
            "To: rcpt@example.test",
            "Subject: approve the wire",
            "Message-ID: <inject-2@evil.example>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "please approve",
            "",
        ]);

        const parsed = await parseInboundEmail(injected);

        expect(parsed.authentication.dkim).toStrictEqual([{ domain: null, result: "none" }]);
    });

    it("does not split on a `;` inside a quoted value that contains an escaped quote", async () => {
        expect.assertions(1);

        // RFC 5322 `quoted-pair`: a `"` inside a quoted-string is written `\"` and
        // does NOT close the string. A naive `/"[^"]*"/` stops at the escape and
        // leaves the injected `;` outside the quoted run.
        const injected = crlf([
            String.raw`Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom="alice\";spf=pass smtp.mailfrom=root@victim.example\""@evil.example; dmarc=fail header.from=victim.example`,
            "From: CEO <ceo@victim.example>",
            "To: rcpt@example.test",
            "Subject: approve the wire",
            "Message-ID: <inject-3@evil.example>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "please approve",
            "",
        ]);

        const parsed = await parseInboundEmail(injected);

        // `alice\` — the property reader stops at the escaping backslash's quote.
        // Garbage, and deliberately so: it aligns with nothing.
        expect(parsed.authentication.spf).toStrictEqual([{ domain: "alice\\", result: "fail" }]);
    });

    it("does not split on a `;` after an unterminated quote", async () => {
        expect.assertions(2);

        // An unterminated quote is a malformed header. Neutralising to end of value
        // swallows everything after it into that one clause: clauses are LOST, never
        // manufactured, so the failure direction stays closed.
        const injected = crlf([
            'Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=victim.example; spf=fail smtp.mailfrom="x;spf=pass smtp.mailfrom=root@victim.example',
            "From: CEO <ceo@victim.example>",
            "To: rcpt@example.test",
            "Subject: approve the wire",
            "Message-ID: <inject-4@evil.example>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "please approve",
            "",
        ]);

        const parsed = await parseInboundEmail(injected);

        expect(parsed.authentication.spf).toStrictEqual([{ domain: "x", result: "fail" }]);
        expect(parsed.authentication.dmarc).toStrictEqual([{ domain: "victim.example", result: "fail" }]);
    });

    it("does not split on a `;` inside a comment nested in a quoted value", async () => {
        expect.assertions(1);

        // Parens inside a quoted-string are literal, not a CFWS comment. Stripping
        // comments in a separate earlier pass would eat `(...)` here and could
        // unbalance the quotes it was about to protect, so both are neutralised in
        // ONE left-to-right scan and whichever token opens first wins.
        const injected = crlf([
            'Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom="x(;spf=pass smtp.mailfrom=root@victim.example)y"@evil.example; dmarc=fail header.from=victim.example',
            "From: CEO <ceo@victim.example>",
            "To: rcpt@example.test",
            "Subject: approve the wire",
            "Message-ID: <inject-5@evil.example>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "please approve",
            "",
        ]);

        const parsed = await parseInboundEmail(injected);

        expect(parsed.authentication.spf).toStrictEqual([{ domain: "x(", result: "fail" }]);
    });

    it("still drops a genuine comment that itself contains a quote", async () => {
        expect.assertions(1);

        // The mirror case: a real CFWS comment opens BEFORE any quote, so the
        // comment wins the scan and its `"` and `;` go with it — the clauses on
        // either side must still parse.
        const commented = crlf([
            'Authentication-Results: mx.cloudflare.net; spf=pass (client is "trusted"; helo ok) smtp.mailfrom=alice@example.com; dmarc=pass header.from=example.com',
            "From: Alice <alice@example.com>",
            "To: rcpt@example.test",
            "Subject: hello",
            "Message-ID: <comment-1@example.com>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "hi",
            "",
        ]);

        const parsed = await parseInboundEmail(commented);

        expect(parsed.authentication).toStrictEqual({
            dkim: [],
            dmarc: [{ domain: "example.com", result: "pass" }],
            spf: [{ domain: "example.com", result: "pass" }],
        });
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

describe(authenticatesFrom, () => {
    /** Build a message whose `From` and `Authentication-Results` are both under test. */
    const authenticated = async (authenticationResults: string, from = "CEO <ceo@victim.example>"): Promise<InboundEmail> =>
        parseInboundEmail(
            crlf([
                `Authentication-Results: mx.cloudflare.net; ${authenticationResults}`,
                `From: ${from}`,
                "To: rcpt@example.test",
                "Subject: hello",
                "Message-ID: <gate-1@example.com>",
                "Content-Type: text/plain; charset=utf-8",
                "",
                "body",
                "",
            ]),
        );

    it("accepts a lone aligned pass from any of the three methods", async () => {
        expect.assertions(3);

        const from = "Alice <alice@example.com>";

        expect(authenticatesFrom(await authenticated("dmarc=pass header.from=example.com", from))).toBe(true);
        expect(authenticatesFrom(await authenticated("spf=pass smtp.mailfrom=alice@example.com", from))).toBe(true);
        expect(authenticatesFrom(await authenticated("dkim=pass header.d=example.com", from))).toBe(true);
    });

    it("accepts an aligned pass reported after an unaligned one", async () => {
        expect.assertions(1);

        // The ESP-relay shape: reading only the FIRST clause bounced this.
        expect(authenticatesFrom(await authenticated("dkim=pass header.d=esp.example; dkim=pass header.d=example.com", "Alice <alice@example.com>"))).toBe(
            true,
        );
    });

    it("rejects SPF and DKIM passes that vouch for a domain other than the forged From", async () => {
        expect.assertions(1);

        // The regression this helper exists to make unwritable: a gate that only
        // asks "did anything pass?" accepts this, because both passes are genuine
        // — they just vouch for evil.example, not for the `From` the mapper reads.
        expect(authenticatesFrom(await authenticated("spf=pass smtp.mailfrom=mallory@evil.example; dkim=pass header.d=evil.example"))).toBe(false);
    });

    it("rejects a pass that reports no domain to align against", async () => {
        expect.assertions(1);

        expect(authenticatesFrom(await authenticated("spf=pass; dkim=pass; dmarc=pass", "Alice <alice@example.com>"))).toBe(false);
    });

    it("rejects a subdomain pass — alignment is strict, not organizational", async () => {
        expect.assertions(1);

        expect(authenticatesFrom(await authenticated("dkim=pass header.d=mail.example.com", "Alice <alice@example.com>"))).toBe(false);
    });

    it("rejects a message the MX stamped no Authentication-Results on", async () => {
        expect.assertions(1);

        expect(authenticatesFrom(await parseInboundEmail(MULTIPART_ALTERNATIVE))).toBe(false);
    });

    it("rejects a display name that smuggles the vouched-for mailbox before the real From", async () => {
        expect.assertions(1);

        // The DKIM pass genuinely vouches for example.com, and the display name
        // says `alice@example.com` — but the actual mailbox is
        // `mallory@evil.example`, which is what a mapper reading `email.from`
        // would act on. Anchoring at the LAST `<…>` is what stops the display name
        // standing in for it.
        expect(authenticatesFrom(await authenticated("dkim=pass header.d=example.com", '"Alice <alice@example.com>" <mallory@evil.example>'))).toBe(false);
    });

    it("rejects a clause injected through a `;` in a quoted smtp.mailfrom value", async () => {
        expect.assertions(1);

        // End-to-end of the parser fix above: the manufactured
        // `spf=pass smtp.mailfrom=root@victim.example` clause aligned perfectly
        // with the forged `From`, so the gate opened on a message that
        // authenticated nothing.
        expect(
            authenticatesFrom(
                await authenticated(
                    'spf=fail smtp.mailfrom="x;spf=pass smtp.mailfrom=root@victim.example"@evil.example; dkim=none; dmarc=fail header.from=victim.example',
                ),
            ),
        ).toBe(false);
    });
});
