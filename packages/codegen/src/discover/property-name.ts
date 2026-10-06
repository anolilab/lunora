import { Node } from "ts-morph";

/**
 * The runtime key a property-name node spells, with the quotes a string-literal
 * key is written with removed.
 *
 * ts-morph's `getName()` on a `PropertyAssignment` / `MethodDeclaration` (and its
 * `getProperty("name")`, which compares against `getName()`) returns the key's
 * SOURCE TEXT: `{ "NODE_VERSION": "22" }` reads back as `"NODE_VERSION"`, quotes
 * included. Every reader that compared or recorded that text treated a quoted
 * key as a different key — a cron dispatched with argument names nobody
 * declared, a container build arg named with literal quote characters, a
 * wrangler setting that silently vanished. The runtime sees `NODE_VERSION`, so
 * this does too: string, template and numeric literals yield their value, a
 * computed `["key"]` its literal, an identifier its text, and any other
 * computed name (`[KEY]`, `[0]`) `undefined` — it cannot be resolved statically.
 */
const staticPropertyName = (nameNode: Node): string | undefined => {
    if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode) || Node.isNumericLiteral(nameNode)) {
        return nameNode.getLiteralText();
    }

    if (Node.isComputedPropertyName(nameNode)) {
        const expression = nameNode.getExpression();

        return Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression) ? expression.getLiteralText() : undefined;
    }

    return nameNode.getText();
};

/** The key {@link staticPropertyName} reads, falling back to the source text of a computed name it cannot resolve. */
const propertyNameText = (nameNode: Node): string => staticPropertyName(nameNode) ?? nameNode.getText();

/** The runtime key of an object-literal member (or any named declaration) — see {@link propertyNameText}. */
const propertyKeyName = (member: { getNameNode: () => Node }): string => propertyNameText(member.getNameNode());

export { propertyKeyName, propertyNameText, staticPropertyName };
