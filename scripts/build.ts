/**
 * Builds standalone executables with `bun build --compile`.
 *
 *   bun run scripts/build.ts          # current platform -> dist/contextlint
 *   bun run scripts/build.ts --all    # every supported target -> dist/contextlint-<target>
 */
import { join } from "node:path";

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
  "bun-windows-x64",
] as const;

const root = join(import.meta.dir, "..");
const entry = join(root, "src", "cli.ts");
const all = process.argv.includes("--all");

async function build(target?: (typeof TARGETS)[number]) {
  const name = target ? `contextlint-${target.replace(/^bun-/, "")}` : "contextlint";
  const outfile = join(root, "dist", target?.includes("windows") ? `${name}.exe` : name);
  const cmd = [
    "bun",
    "build",
    entry,
    "--compile",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-dotenv",
    "--minify",
    "--bytecode",
    "--outfile",
    outfile,
  ];
  if (target) cmd.push("--target", target);
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", cwd: root });
  if ((await proc.exited) !== 0) throw new Error(`Build failed for ${target ?? "host"}`);
  console.log(`Built ${outfile}`);
}

if (all) {
  // Builds run one after another: each compile is CPU- and memory-heavy.
  // oxlint-disable-next-line no-await-in-loop
  for (const target of TARGETS) await build(target);
} else {
  await build();
}
