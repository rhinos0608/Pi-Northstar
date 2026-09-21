import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "../../src/cli/cli.js";
import {
  DOMAIN_SKILLS,
  cliSkillInventory,
  optionalPiToolInventory,
  skillFileInventory,
  domainSkill,
} from "../../src/skills/skill-registry.js";
import { commandSurface } from "../../src/commands/command-registry.js";
import { PUBLIC_TOOL_NAMES } from "../../src/capabilities.js";

const root = join(import.meta.dirname, "..", "..");

test("registry and CLI help expose same migrated grammar", async () => {
  const [skill] = DOMAIN_SKILLS;
  assert.ok(skill);
  const result = await runCommand(["github", "file", "--help"], {});
  assert.equal(result.ok, true);
  assert.equal((result.data as { usage: string }).usage, skill.cliHelp);
  assert.equal(
    (result.data as { commandId: string }).commandId,
    skill.commandId,
  );
});

test("CLI discovery and domain help independently reflect command registry entries", async () => {
  const commands = commandSurface();
  assert.deepEqual((await runCommand(["domains"], {})).data, [
    ...new Set(
      DOMAIN_SKILLS.filter((skill) => commands.includes(skill.commandId)).map(
        (skill) => skill.domain,
      ),
    ),
  ]);
  assert.deepEqual((await runCommand(["capabilities"], {})).data, commands);
  for (const commandId of commands) {
    const skill = domainSkill(commandId);
    assert.ok(skill, `missing skill for ${commandId}`);
    const subcommand = commandId.slice(commandId.indexOf(".") + 1);
    const result = await runCommand([skill.domain, subcommand, "--help"], {});
    assert.equal(result.ok, true);
    assert.equal((result.data as { commandId: string }).commandId, commandId);
    assert.equal((result.data as { usage: string }).usage, skill.cliHelp);
  }
  const help = await runCommand(["--help"], {});
  assert.deepEqual(
    (help.data as { commands: string[] }).commands.slice(
      0,
      cliSkillInventory().length,
    ),
    cliSkillInventory(),
  );
});

test("root router declares every registry skill and no undeclared migrated command", () => {
  const rootSkill = readFileSync(join(root, "SKILL.md"), "utf8");
  for (const skill of DOMAIN_SKILLS) {
    assert.match(rootSkill, new RegExp(skill.commandId.replace(".", "\\.")));
    assert.match(
      rootSkill,
      new RegExp(skill.cliCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(
      rootSkill,
      new RegExp(skill.skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(
    rootSkill,
    /Only `github\.file`, `github\.repo`, `github\.tree`, `github\.trending`, `github\.search`, `github\.search_repos`, `github\.issues`, `github\.pulls`, `github\.releases`, `github\.commits`, `github\.workflows`, `github\.runs`, `research\.search`, `research\.paper`, `research\.citations`, `social\.search`, `social\.read`, `media\.details`, `media\.transcript`, `media\.feed`, `kg\.search`, `kg\.enhance`, `graph\.query`, `graph\.probe`, `fetch\.read`, and `search\.web` are migrated/,
  );
});

test("registry skill inventory and optional Pi inventory are bounded", () => {
  assert.deepEqual(skillFileInventory(), [
    "skills/github/SKILL.md",
    "skills/research/SKILL.md",
    "skills/social/SKILL.md",
    "skills/media/SKILL.md",
    "skills/kg/SKILL.md",
    "skills/graph/SKILL.md",
    "skills/fetch/SKILL.md",
    "skills/search/SKILL.md",
  ]);
  for (const path of skillFileInventory()) {
    assert.match(readFileSync(join(root, path), "utf8"), /untrusted/i);
  }
  for (const tool of optionalPiToolInventory())
    assert.ok((PUBLIC_TOOL_NAMES as readonly string[]).includes(tool));
  assert.deepEqual(
    DOMAIN_SKILLS.map((skill) => skill.commandId),
    [
      "github.file",
      "github.repo",
      "github.tree",
      "github.trending",
      "github.search",
      "github.search_repos",
      "github.issues",
      "github.pulls",
      "github.releases",
      "github.commits",
      "github.workflows",
      "github.runs",
      "research.search",
      "research.paper",
      "research.citations",
      "social.search",
      "social.read",
      "media.search",
      "media.hot",
      "media.details",
      "media.transcript",
      "media.feed",
      "kg.search",
      "kg.enhance",
      "graph.query",
      "graph.probe",
      "fetch.read",
      "search.web",
    ],
  );
});

test("packed artifact contains every registered domain skill", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  const paths = new Set(
    (
      JSON.parse(output) as Array<{ files: Array<{ path: string }> }>
    )[0]!.files.map((file) => file.path),
  );
  for (const path of skillFileInventory())
    assert.ok(paths.has(path), `package missing ${path}`);
});
