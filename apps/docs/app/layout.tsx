import "fumadocs-ui/css/style.css";

import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactElement, ReactNode } from "react";

const RootLayout = ({ children }: { children: ReactNode }): ReactElement => (
    <html lang="en" suppressHydrationWarning>
        <body>
            <RootProvider>{children}</RootProvider>
        </body>
    </html>
);

export const metadata = {
    description: "Type-safe real-time backend on your own Cloudflare account. Vite-first.",
    icons: {
        icon: "/favicon.svg",
    },
    title: "Lunora",
};

export default RootLayout;
