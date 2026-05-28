# @cirrus/dashboard

Embeddable React components for inspecting a Cirrus backend during development.

The package is a component library — drop the pieces into your own admin route
behind a `<CirrusProvider>`; there is no standalone server or app.

## Components

- `FunctionRunner` — pick a registered function, edit its JSON args, and invoke
  it (query / mutation / action) against the live client, showing the result or
  error. Pass the set of functions to expose as `FunctionDescriptor[]`.

## Usage

```tsx
import { CirrusProvider } from "@cirrus/react";
import { FunctionRunner } from "@cirrus/dashboard";

const functions = [
    { kind: "query", path: "messages:list" },
    { kind: "mutation", path: "messages:send" },
];

<CirrusProvider client={client}>
    <FunctionRunner functions={functions} />
</CirrusProvider>;
```
