import { basename } from "node:path";

import { offsetToPosition } from "#src/markdown.ts";
import { countSchema } from "#src/schema.ts";
import { characterOffsets } from "#src/text.ts";
import type { Rule } from "#src/types.ts";

export interface LimitFileSizeOptions {
  /** Files with more characters than this are reported. */
  maxChars: number | string;
}

/** Fixed locale, so that messages don't depend on the environment. */
const numbers = new Intl.NumberFormat("en-US");

export const limitFileSize: Rule<LimitFileSizeOptions> = {
  meta: {
    name: "agentfile/limit-file-size",
    description: "Context files must not be longer than a maximum number of characters",
    categories: [],
    defaultSeverity: "warn",
    schema: {
      type: "object",
      properties: {
        maxChars: countSchema(
          "Report files with more characters than this. Characters are counted as displayed: an emoji or an accented letter counts once.",
          "integer",
        ),
      },
    },
  },
  // About 5,000 tokens of English text. Leaves room for the AGENTS.md files of parent directories
  // within Codex's default 32 KiB budget, and stays well below Claude Code's 40,000-character warning.
  defaultOptions: { maxChars: 20_000 },
  check({ file, options, report }) {
    const max = Number(options.maxChars);
    // A character takes at least one UTF-16 code unit, so shorter files need no counting.
    if (file.text.length <= max) return;
    let count = 0;
    let overflow = 0;
    for (const offset of characterOffsets(file.text)) {
      if (count === max) overflow = offset;
      count++;
    }
    if (count <= max) return;

    const name = basename(file.path);
    report({
      message: `\`${name}\` has ${numbers.format(count)} characters, ${numbers.format(count - max)} more than the limit of ${numbers.format(max)}`,
      help:
        "Agents load the whole file into the context of every session, where it uses up tokens and competes with " +
        "the task for attention. Keep what applies to most tasks and move the rest into files agents read when " +
        "needed: linked docs, skills, or context files in subdirectories. The limit is set by `maxChars`.",
      // From the first character past the limit to the end of the content.
      start: offsetToPosition(file.lineStarts, overflow),
      end: offsetToPosition(file.lineStarts, Math.max(overflow, file.text.trimEnd().length)),
    });
  },
};
