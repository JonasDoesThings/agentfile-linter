import { describe, expect, test } from "bun:test";

import {
  codeBlockCommandLines,
  sliceToken,
  splitSegments,
  stripCommandPrefix,
  tokenize,
  tokenEndOffset,
} from "./shell.ts";

function strip(cmd: string): string {
  return stripCommandPrefix(tokenize(cmd) ?? [])
    .map((t) => t.value)
    .join(" ");
}

describe("shell parsing", () => {
  test("splitSegments splits on operators but not inside quotes or redirections", () => {
    expect(splitSegments("cd web && pnpm dev; echo 'a && b' | cat 2>&1 # comment").map((s) => s.text.trim())).toEqual([
      "cd web",
      "pnpm dev",
      "echo 'a && b'",
      "cat 2>&1",
    ]);
  });

  test("subshell delimiters exclude quoted parentheses, substitutions and case labels", () => {
    const segments = splitSegments('(echo "literal)"; echo $(printf "\u0028x\u0029")) && npm test');
    expect(segments.map((s) => [s.text.trim(), s.subshell])).toEqual([
      ["(", "open"],
      ['echo "literal)"', undefined],
      ['echo $(printf "(x)")', undefined],
      [")", "close"],
      ["npm test", undefined],
    ]);
    expect(splitSegments("default) cd web;;")[0]?.text).toBe("default) cd web");
    expect(tokenize('npm run "build)"')?.at(-1)?.value).toBe("build)");
  });

  test("distinguishes pipelines from logical OR and handles pipes after groups", () => {
    const segments = splitSegments("cd a || (echo x) |& cd b | cat");
    expect(segments.filter((s) => s.pipeToNext).map((s) => s.text.trim())).toEqual([")", "cd b"]);
  });

  test("codeBlockCommandLines strips prompts, joins continuations, skips session output", () => {
    expect(codeBlockCommandLines("$ pnpm dev\n> ready\n$ pnpm \\\n  build", "console").map((l) => l.text)).toEqual([
      "pnpm dev",
      "pnpm  build",
    ]);
    expect(codeBlockCommandLines("pnpm install\n\npnpm dev", "bash").map((l) => l.parts[0]?.lineIndex)).toEqual([0, 2]);
  });

  test("tokenize handles quotes, escapes and redirections; rejects substitutions", () => {
    expect(tokenize(`pnpm --filter '@acme/*' run "my script" > out.log 2>&1`)?.map((t) => t.value)).toEqual([
      "pnpm",
      "--filter",
      "@acme/*",
      "run",
      "my script",
    ]);
    expect(tokenize("make $(echo build)")).toBeNull();
  });

  test("preserves the source positions of quoted and escaped token slices", () => {
    const command = 'tool --flag="two words" other\\ name';
    const tokens = tokenize(command);
    const flag = sliceToken(tokens![1]!, "--flag=".length);
    expect(command.slice(flag.offset, tokenEndOffset(flag))).toBe("two words");
    const name = tokens![2]!;
    expect(command.slice(name.offset, tokenEndOffset(name))).toBe("other\\ name");
    expect(command.slice(sliceToken(name, 6).offset, tokenEndOffset(name))).toBe("name");
  });

  test("stripCommandPrefix removes env assignments and wrappers", () => {
    expect(strip("NODE_ENV=production pnpm build")).toBe("pnpm build");
    expect(strip("sudo -E make install")).toBe("make install");
    expect(strip("time env CI=1 corepack pnpm test")).toBe("pnpm test");
  });
});
