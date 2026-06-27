import type { Metadata } from "next";

import { Providers } from "./providers";

/**
 * Root layout (App Router). vinext renders this server component around every
 * route; `<Providers>` is the client boundary that mounts the LunoraProvider so
 * descendant client components can use Lunora's live hooks.
 */
export const metadata: Metadata = {
    title: "Lunora",
    description: "A type-safe, real-time backend on Cloudflare Workers + Durable Objects.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
