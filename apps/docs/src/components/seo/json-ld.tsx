import type { FC } from "react";

interface JsonLdProps {
    data: Record<string, unknown>;
}

/**
 * Renders JSON-LD structured data as a script tag.
 * Content is generated from trusted application data, not user input.
 */
const JsonLd: FC<JsonLdProps> = ({ data }) => {
    const json = JSON.stringify({ "@context": "https://schema.org", ...data });

    // eslint-disable-next-line react/no-danger -- Safe: content is from trusted application constants, not user input
    return <script dangerouslySetInnerHTML={{ __html: json }} type="application/ld+json" />;
};

export default JsonLd;
