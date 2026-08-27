/**
 * Markdown imported as text.
 *
 * Bun resolves `with { type: "text" }` at build time and, for a compiled
 * binary, embeds the contents. TypeScript needs to be told the shape; without
 * this it reports the import as a missing module.
 */
declare module "*.md" {
  const content: string
  export default content
}
