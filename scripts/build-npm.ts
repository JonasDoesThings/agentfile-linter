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
