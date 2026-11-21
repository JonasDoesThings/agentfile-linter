import { describe, expect, test } from "bun:test";

import { makeProject, messages, runRule } from "#test/helpers.ts";

const RULE = "context/no-missing-script";

describe("composer", () => {
  test("checks run-script / run against composer.json scripts", async () => {
    const root = makeProject({
      "composer.json": { scripts: { test: "phpunit", "cs-fix": "php-cs-fixer fix" } },
      "AGENTS.md":
        "`composer test`, `composer run-script test`, `composer run cs-fix`, `composer run lint`, `composer install`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Composer script `lint` is not defined in `composer.json`"]);
  });

  test("honors --working-dir", async () => {
    const root = makeProject({
      "api/composer.json": { scripts: { serve: "php -S" } },
      "AGENTS.md": "`composer -d api run serve` and `composer --working-dir=api run test`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Composer script `test` is not defined in `api/composer.json`",
    ]);
  });
});
