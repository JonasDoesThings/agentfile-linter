import { dirname } from "node:path";

import type { Code, InlineCode } from "mdast";

import { Glob } from "#src/glob.ts";
import { computeLineStarts, offsetToPosition } from "#src/markdown.ts";
import { checkCommand, RUNNER_IDS } from "#src/runners/index.ts";
import {
  codeBlockCommandLines,
  isShellLang,
  splitSegments,
  stripCommandPrefix,
  tokenize,
  tokenEndOffset,
} from "#src/shell.ts";
import type { SourceCode } from "#src/source-code.ts";
import type { Rule } from "#src/types.ts";

export interface NoMissingScriptOptions {
  /** Glob patterns of script / target / task names that are never reported. */
  ignore: string[];
  /** Task runners (by id) whose commands are not checked. */
  ignoreRunners: string[];
}

interface CommandLine {
  text: string;
  offsetAt(offset: number): number;
}

/** Map Markdown code lines past any prefixes removed by the parser. */
function codeSourceOffsets(
  value: string,
  file: SourceCode,
  startLine: number,
  startOffset: number,
  endOffset: number,
): number[] {
  return value.split(/\r?\n/).map((line, index) => {
    const lineStart = index === 0 ? startOffset : (file.lineStartIndices[startLine - 1 + index] ?? startOffset);
    const nextLine = file.lineStartIndices[startLine + index] ?? endOffset;
    const raw = file.text.slice(lineStart, Math.min(nextLine, endOffset)).replace(/\r?\n$/, "");
    const prefix = raw.endsWith(line) ? raw.length - line.length : Math.max(0, raw.indexOf(line));
    return lineStart + prefix;
  });
}

function commandLines(node: InlineCode | Code, file: SourceCode): CommandLine[] {
  const startLine = node.position?.start.line ?? 1;
  const startOffset = node.position?.start.offset ?? 0;
  const endOffset = node.position?.end.offset ?? file.text.length;
  if (node.type === "inlineCode") {
    const fenceLength = /^`+/.exec(file.text.slice(startOffset, endOffset))?.[0].length ?? 0;
    const source = codeSourceOffsets(node.value, file, startLine, startOffset + fenceLength, endOffset - fenceLength);
    const lineStarts = computeLineStarts(node.value);
    return [
      {
        text: node.value,
        offsetAt(offset) {
          const { line, column } = offsetToPosition(lineStarts, offset);
          return (source[line - 1] ?? startOffset) + column - 1;
        },
      },
    ];
  }
  const fenced = /^\s*(?:```|~~~)/.test(file.text.slice(startOffset, startOffset + 64));
  const source = codeSourceOffsets(
    node.value,
    file,
    startLine + (fenced ? 1 : 0),
    fenced ? (file.lineStartIndices[startLine] ?? startOffset) : startOffset,
    endOffset,
  );
  return codeBlockCommandLines(node.value, node.lang).map(({ text, parts }) => ({
    text,
    offsetAt(offset) {
      const part = parts.findLast((p) => p.offset <= offset);
      return part ? (source[part.lineIndex] ?? startOffset) + part.column + offset - part.offset : startOffset;
    },
  }));
}

export const noMissingScript: Rule<[NoMissingScriptOptions]> = {
  meta: {
    docs: {
      description:
        "Documented scripts and tasks (npm/pnpm/yarn/bun/deno, make, just, task, poetry/uv/pdm/hatch/tox/nox, maven, gradle, composer, cargo) must exist",
      recommended: true,
      category: "correctness",
    },
    schema: [
      {
        type: "object",
        properties: {
          ignore: {
            type: "array",
            items: { type: "string" },
            description: "Glob patterns of script, target or task names to skip.",
          },
          ignoreRunners: {
            type: "array",
            items: { type: "string", enum: RUNNER_IDS },
            description: "Task runners whose commands are not checked.",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ ignore: [], ignoreRunners: [] }],
  },
  create(context) {
    const { sourceCode, project, report } = context;
    const [options] = context.options;
    const fileDir = dirname(context.filename);
    const ignoreGlobs = options.ignore.map((p) => new Glob(p));
    const ignoredRunners = new Set(options.ignoreRunners);

    const checkCode = (node: InlineCode | Code) => {
      if (node.type === "code" && !isShellLang(node.lang)) return;
      // `cd` persists across the lines of one code block, like in a shell session.
      let cwd: string | null = fileDir;
      const subshellCwds: (string | null)[] = [];
      const isolatesCwd = node.type === "inlineCode" || !/^(?:cmd|bat|batch)$/i.test(node.lang ?? "");
      const pipelineTailSharesCwd =
        node.type === "code" && /^(?:zsh|ps1|powershell|pwsh|nu|nushell)$/i.test(node.lang ?? "");
      let followsPipe = false;
      for (const line of commandLines(node, sourceCode)) {
        for (const segment of splitSegments(line.text, subshellCwds.length)) {
          const isolatedByPipe = segment.pipeToNext || (followsPipe && !pipelineTailSharesCwd);
          followsPipe = segment.pipeToNext ?? false;
          if (segment.subshell === "open") {
            subshellCwds.push(cwd);
            continue;
          }
          if (segment.subshell === "close") {
            const outerCwd = subshellCwds.pop();
            if (isolatesCwd && outerCwd !== undefined) cwd = outerCwd;
            continue;
          }
          const tokens = tokenize(segment.text);
          if (!tokens) continue;
          const args = stripCommandPrefix(tokens);
          const command = args[0]?.value;
          if (command === "cd" || command === "pushd") {
            if (isolatedByPipe) continue;
            const target = args[1]?.value;
            if (!cwd || !target || /^[~$-]/.test(target)) {
              cwd = null;
            } else {
              const next = project.resolveExisting(cwd, target, "dir");
              cwd = project.isDirectory(next) ? next : null;
            }
            continue;
          }
          if (command === "popd") {
            if (!isolatedByPipe) cwd = null;
            continue;
          }
          if (!cwd) continue;
          // In prose, a lone tool name ("we use `make`") is a mention, not an invocation.
          if (node.type === "inlineCode" && args.length < 2) continue;
          const problems = checkCommand(tokens, cwd, project, (runner) => !ignoredRunners.has(runner.id)) ?? [];
          for (const problem of problems) {
            if (problem.name && ignoreGlobs.some((g) => g.match(problem.name as string))) continue;
            const start = line.offsetAt(segment.offset + problem.token.offset);
            const end = line.offsetAt(segment.offset + tokenEndOffset(problem.token));
            report({
              message: problem.message,
              help: problem.help,
              loc: { start: sourceCode.getLocFromIndex(start), end: sourceCode.getLocFromIndex(end) },
            });
          }
        }
      }
    };
    return { inlineCode: checkCode, code: checkCode };
  },
};
