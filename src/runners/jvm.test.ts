import { describe, expect, test } from "bun:test";

import { makeProject, messages, runRule } from "#test/helpers.ts";

const RULE = "context/no-missing-script";

const ROOT_POM = `<project>
  <artifactId>parent</artifactId>
  <modules>
    <module>core</module>
    <module>web</module>
    <!-- <module>old</module> -->
  </modules>
  <profiles>
    <profile><id>ci</id></profile>
    <profile>
      <id>release</id>
    </profile>
  </profiles>
</project>`;

const modulePom = (artifactId: string, profiles = "") => `<project>
  <parent><artifactId>parent</artifactId></parent>
  <artifactId>${artifactId}</artifactId>
  ${profiles}
</project>`;

describe("maven", () => {
  const files = {
    "pom.xml": ROOT_POM,
    "core/pom.xml": modulePom("app-core"),
    "web/pom.xml": modulePom("app-web", "<profiles><profile><id>dev</id></profile></profiles>"),
  };

  test("accepts valid phases, plugin goals, modules and profiles", async () => {
    const root = makeProject({
      ...files,
      "AGENTS.md": [
        "- `mvn clean install -DskipTests -fae`",
        "- `./mvnw -pl core,:app-web -am test`",
        "- `mvn -P ci,!release,?maybe verify`",
        "- `mvn -Pdev spring-boot:run`",
        "- `mvn -q -f web/pom.xml package`",
        "",
      ].join("\n"),
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("reports unknown phases, modules and profiles", async () => {
    const root = makeProject({
      ...files,
      "AGENTS.md": "`mvn instal`, `mvn -pl api test`, `mvn -pl :app-api test`, `mvn -P prod package`\n",
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.message, d.help])).toEqual([
      ["`instal` is not a Maven lifecycle phase", "Did you mean `install`?"],
      ["Maven module `api` is not defined in the reactor of `pom.xml`", "Available: core, web"],
      ["Maven module `app-api` is not defined in the reactor of `pom.xml`", "Available: app-core, app-web, parent"],
      ["Maven profile `prod` is not defined in `pom.xml` or its modules", "Available: ci, dev, release"],
    ]);
  });

  test("reports a missing pom.xml", async () => {
    const root = makeProject({ "AGENTS.md": "`mvn test`\n" });
    expect(messages(await runRule(root, RULE))).toEqual(["No pom.xml found"]);
  });
});

describe("gradle", () => {
  const SETTINGS = `rootProject.name = "demo"
include("app", ":lib:core")
// include(":old")
`;

  test("checks project paths of task selectors", async () => {
    const root = makeProject({
      "settings.gradle.kts": SETTINGS,
      "AGENTS.md": [
        "- `./gradlew build`, `./gradlew :app:test`, `./gradlew lib:core:check -x :lib:test`",
        "- `gradle :old:build`, `./gradlew :lib:api:jar`",
        "",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Gradle project `:old` is not defined in `settings.gradle.kts`",
      "Gradle project `:lib:api` is not defined in `settings.gradle.kts`",
    ]);
  });

  test("composite builds and computed includes are not checked", async () => {
    const root = makeProject({
      "settings.gradle": "includeBuild('build-logic')\ninclude 'app'\n",
      "AGENTS.md": "`./gradlew :build-logic:check`\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });
});
