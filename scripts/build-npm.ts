import { readFileSync, rmSync, writeFileSync } from "node:fs";

import pkg from "#package.json" with { type: "json" };

await Bun.build({
  entrypoints: ["src/cli.ts"],
  target: "node",
  external: Object.keys(pkg.dependencies),
  // The npm bundle is invoked through the bin entry in package.json.
  define: { "import.meta.main": "true" },
  outdir: "dist",
  naming: "cli.js",
});

// The types for plugin authors: the declarations of `src/plugin-types.ts` and the files it imports.
rmSync("dist/types", { recursive: true, force: true });
const tsc = Bun.spawnSync(["bun", "x", "tsc", "-p", "tsconfig.types.json"], { stdout: "inherit", stderr: "inherit" });
if (tsc.exitCode !== 0) throw new Error("Emitting type declarations failed");
// The declarations import each other with `.ts` extensions, which only newer TypeScript versions resolve.
for (const path of new Bun.Glob("dist/types/**/*.d.ts").scanSync()) {
  writeFileSync(path, readFileSync(path, "utf8").replaceAll(/(["']\.{1,2}\/[^"']*)\.ts(["'])/g, "$1.js$2"));
}
