import "./index.css";

import type { FunctionDescriptor, StudioAppProps } from "@cirrus/studio";
import { StudioApp } from "@cirrus/studio";
import { createRoot } from "react-dom/client";

import { createDevMockClient } from "./mock/dev-client.js";

// Mirrors the mock client's `listFunctions` so the API docs panel has registered
// functions to document — the shell takes the list as a prop, not via the client.
const MOCK_FUNCTIONS: FunctionDescriptor[] = [
    { kind: "query", path: "messages:list" },
    { kind: "mutation", path: "messages:send" },
    { kind: "mutation", path: "posts:publish" },
    { kind: "action", path: "posts:syncToStripe" },
];

// Hoisted to module scope so the JSX prop is a single stable object, not a fresh
// one per render. The rule still flags the literal because it can't prove the
// const never re-evaluates; at module top level it evaluates exactly once.
// `dataEditable` is on so the harness exercises the inline cell editor + staged
// commit flow during design iteration; the mock records writes without a backend.
// eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- module-level constant, evaluated once
const STUDIO_OPTIONS: StudioAppProps["studio"] = { dataEditable: true, functions: MOCK_FUNCTIONS };

// Dev-only harness: render the full studio chrome against a backend-free mock
// client (see `mock/dev-client.ts`), so every panel paints with representative
// data for design/screenshot iteration. Reached at `/mock.html` in dev.
const element = document.querySelector("#root");

if (element === null) {
    throw new Error("main.mock: #root not found");
}

createRoot(element).render(<StudioApp client={createDevMockClient()} studio={STUDIO_OPTIONS} />);
