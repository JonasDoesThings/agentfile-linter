/**
 * The types for plugin authors, published as the package's type declarations (the package has no
 * JavaScript exports): `import type { Plugin, Rule } from "agentfile-linter"`.
 */
export type * from "./types.ts";
export type { Project } from "./project.ts";
export type { JsonSchema, OptionsSchema } from "./schema.ts";
export type { SourceCode } from "./source-code.ts";
