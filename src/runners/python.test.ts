import { describe, expect, test } from "bun:test";

import { makeProject, messages, runRule } from "#test/helpers.ts";

import { expandGenerative } from "./python.ts";

const RULE = "agentfile/no-missing-script";

const PYPROJECT = `
[project]
name = "app"
dependencies = ["fastapi[standard]>=0.110", "Django>=5"]

[project.optional-dependencies]
docs = ["mkdocs-material"]

[project.scripts]
app-cli = "app.cli:main"

[dependency-groups]
dev = ["pytest>=8", "ruff", { include-group = "lint" }]

[tool.poetry.scripts]
legacy = "app.legacy:main"

[tool.poetry.group.test.dependencies]
coverage = "^7"

[tool.pdm.scripts]
start = "uvicorn app:app"
_ = { env_file = ".env" }

[tool.rye.scripts]
serve = "python -m app"

[tool.hatch.envs.default.scripts]
cov = "pytest --cov"

[tool.hatch.envs.docs.scripts]
build = "mkdocs build"

[tool.poe.tasks]
check = "ruff check ."
`;

describe("uv / poetry / pdm / rye / hatch", () => {
  test("accept project scripts, tool scripts, dependency commands and nested runners", async () => {
    const root = makeProject({
      "pyproject.toml": PYPROJECT,
      Makefile: "build:\n\techo\n",
      "AGENTS.md": [
        "- `uv run app-cli`, `uv run pytest -x`, `uv run ruff check`, `uv run django-admin migrate`",
        "- `uv run python -m app`, `uv run scripts/seed.py`, `uv run --with httpx python x.py`, `uv run make build`",
        "- `poetry run legacy`, `poetry run coverage report`, `poetry poe check`",
        "- `pdm run start`, `rye run serve`, `hatch run cov`, `hatch run docs:build`",
        "",
      ].join("\n"),
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("uv uses the command directory independently of its project directory", async () => {
    const root = makeProject({
      "pyproject.toml": PYPROJECT,
      Makefile: "root:\n\t@echo root\n",
      "docs/Makefile": "local:\n\t@echo local\n",
      "docs/AGENTS.md": [
        "`uv run make local`",
        "`uv --project .. run make local`",
        "`uv run --directory .. make root`",
        "`uv --directory .. --project . run make root`",
        "`uv --project .. run make root`",
      ].join("\n"),
    });
    expect((await runRule(root, RULE)).map(({ line, message }) => [line, message])).toEqual([
      [5, "Make target `root` is not defined in `docs/Makefile`"],
    ]);
  });

  test("report unknown scripts that no dependency provides", async () => {
    const root = makeProject({
      "pyproject.toml": PYPROJECT,
      "AGENTS.md": [
        "- `uv run mypy .`",
        "- `poetry run app-clj`",
        "- `pdm run stat`",
        "- `hatch run docs:serve`",
        "- `poe chek`",
        "- `uv run make build`",
        "",
      ].join("\n"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.message, d.help])).toEqual([
      [
        "uv script `mypy` is not defined in `pyproject.toml`, and no dependency provides a `mypy` command",
        "Available: app-cli, legacy",
      ],
      [
        "Poetry script `app-clj` is not defined in `pyproject.toml`, and no dependency provides a `app-clj` command",
        "Did you mean `app-cli`?",
      ],
      [
        "PDM script `stat` is not defined in `pyproject.toml`, and no dependency provides a `stat` command",
        "Did you mean `start`?",
      ],
      [
        "Hatch script `serve` is not defined in `pyproject.toml`, and no dependency provides a `serve` command",
        "Available: build, cov",
      ],
      ["Poe task `chek` is not defined in `pyproject.toml`", "Did you mean `check`?"],
      ["No Makefile found for `make build`", undefined],
    ]);
  });

  test("commands installed in a local virtualenv are accepted", async () => {
    const root = makeProject({
      "pyproject.toml": '[project]\nname = "x"\n',
      ".venv/bin/special-tool": "",
      ".gitignore": ".venv/\n",
      "AGENTS.md": "`uv run special-tool`\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("without a pyproject.toml nothing is checked", async () => {
    const root = makeProject({ "AGENTS.md": "`uv run whatever` and `poetry run thing`\n" });
    expect(await runRule(root, RULE)).toEqual([]);
  });
});

describe("pipenv", () => {
  test("checks Pipfile scripts and packages", async () => {
    const root = makeProject({
      Pipfile: '[scripts]\nserve = "python app.py"\n\n[packages]\nflask = "*"\n\n[dev-packages]\npytest = "*"\n',
      "AGENTS.md": "`pipenv run serve`, `pipenv run flask run`, `pipenv run pytest`, `pipenv run deploy`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Pipenv script `deploy` is not defined in `Pipfile`, and no dependency provides a `deploy` command",
    ]);
  });
});

describe("tox", () => {
  test("expandGenerative", () => {
    expect(expandGenerative("py{39,310}-django{4,5}")).toEqual([
      "py39-django4",
      "py39-django5",
      "py310-django4",
      "py310-django5",
    ]);
    expect(expandGenerative("py3{11-13}")).toEqual(["py311", "py312", "py313"]);
  });

  test("checks -e environments against tox.ini", async () => {
    const root = makeProject({
      "tox.ini": "[tox]\nenvlist =\n    py{311,312}-django{4,5}\n    lint\n\n[testenv:docs]\ncommands = sphinx-build\n",
      "AGENTS.md": "`tox -e lint`, `tox -e py311-django5,docs`, `tox -e py313`, `tox run -e type`, `tox -e ALL`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["tox environment `type` is not defined in `tox.ini`"]);
  });

  test("reads native TOML configuration from pyproject.toml", async () => {
    const root = makeProject({
      "pyproject.toml": '[tool.tox]\nenv_list = ["3.12", "lint"]\n\n[tool.tox.env.lint]\ncommands = [["ruff"]]\n',
      "AGENTS.md": "`tox -e lint` and `tox -e typing`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "tox environment `typing` is not defined in `pyproject.toml`",
    ]);
  });
});

describe("nox", () => {
  const NOXFILE = [
    "import nox",
    "",
    "@nox.session(python=['3.11', '3.12'])",
    "def tests(session):",
    "    session.run('pytest')",
    "",
    "@nox.session(",
    "    name='lint-all',",
    ")",
    "def lint(session):",
    "    pass",
    "",
  ].join("\n");

  test("checks -s sessions", async () => {
    const root = makeProject({
      "noxfile.py": NOXFILE,
      "AGENTS.md": "`nox -s tests`, `nox -s tests-3.12 lint-all`, `nox --session lint`, `nox`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Nox session `lint` is not defined in `noxfile.py`"]);
  });
});
