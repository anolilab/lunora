import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import type { ReactElement, ReactNode } from "react";

import { source } from "@/lib/source";

/**
 * Documentation chrome — sidebar, header, search trigger. The `notebook`
 * layout maps to the `DocsPage` component used in `[[...slug]]/page.tsx`;
 * keeping both on the same variant avoids the runtime check fumadocs does
 * to ensure pages aren't rendered outside their layout.
 */
const DocsRouteLayout = ({ children }: { children: ReactNode }): ReactElement => (
    <DocsLayout
        nav={{
            title: "Cirrus",
        }}
        tree={source.pageTree}
    >
        {children}
    </DocsLayout>
);

export default DocsRouteLayout;
