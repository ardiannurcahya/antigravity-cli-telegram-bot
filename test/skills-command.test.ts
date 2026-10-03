import test from "node:test";
import assert from "node:assert/strict";
import {
  categorizeSkill,
  parseSkillsJson,
  formatSkillsHtml,
  type SkillItem,
  type CategorizedSkill,
} from "../src/usecases/skills-command.js";

test("categorizeSkill correctly identifies builtin, project, and global skills", () => {
  const builtinSkill: SkillItem = {
    name: "agy-customizations",
    description: "Builtin guide",
    path: "/usr/local/share/antigravity-cli/builtin/skills/agy-customizations/SKILL.md",
    builtin: true,
  };
  assert.equal(categorizeSkill(builtinSkill), "builtin");

  const projectSkill1: SkillItem = {
    name: "workspace-tester",
    description: "Test runner",
    path: "/workspace/project/.agents/skills/workspace-tester/SKILL.md",
    builtin: false,
  };
  assert.equal(categorizeSkill(projectSkill1), "project");

  const projectSkill2: SkillItem = {
    name: "custom-local",
    description: "Local skill",
    path: "/workspace/my-app/skills/custom/SKILL.md",
    builtin: false,
  };
  assert.equal(categorizeSkill(projectSkill2, "/workspace/my-app"), "project");

  const globalSkill: SkillItem = {
    name: "cloudflare-workers-ops",
    description: "Cloudflare guide",
    path: "/home/user/.gemini/config/skills/cloudflare-workers-ops/SKILL.md",
    builtin: false,
  };
  assert.equal(categorizeSkill(globalSkill), "global");
});

test("parseSkillsJson parses raw json output and applies categorization", () => {
  const rawPayload = JSON.stringify({
    command: {
      name: "skills",
      data: {
        skills: [
          {
            name: "antigravity-guide",
            description: "AGY guide",
            path: "/path/builtin/skills/antigravity_guide/SKILL.md",
            builtin: true,
          },
          {
            name: "workspace-tester",
            description: "Test runner",
            path: "/workspace/project/.agents/skills/workspace-tester/SKILL.md",
            builtin: false,
          },
          {
            name: "git-release-workflow",
            description: "Git discipline",
            path: "/home/user/.gemini/config/skills/git-release-workflow/SKILL.md",
            builtin: false,
          },
        ],
      },
    },
  });

  const parsed = parseSkillsJson(rawPayload, "/workspace/project");
  assert.ok(parsed);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].scope, "builtin");
  assert.equal(parsed[1].scope, "project");
  assert.equal(parsed[2].scope, "global");
});

test("parseSkillsJson handles invalid json gracefully", () => {
  const parsed = parseSkillsJson("Not a valid json output");
  assert.equal(parsed, null);
});

test("formatSkillsHtml renders categorized skills with badges and counts", () => {
  const skills: CategorizedSkill[] = [
    {
      name: "workspace-tester",
      description: "Test runner runbook",
      path: "/path/to/runner",
      scope: "project",
    },
    {
      name: "git-release-workflow",
      description: "Git workflow",
      path: "/path/to/git",
      scope: "global",
    },
    {
      name: "antigravity-guide",
      description: "Native guide",
      path: "/path/to/guide",
      builtin: true,
      scope: "builtin",
    },
  ];

  const html = formatSkillsHtml(skills);
  assert.ok(html.includes("AGY Skills (3 available)"));
  assert.ok(html.includes("📁 <b>Project Skills (1)</b>"));
  assert.ok(html.includes("• <b>workspace-tester</b>"));
  assert.ok(html.includes("🌐 <b>Global Skills (1)</b>"));
  assert.ok(html.includes("• <b>git-release-workflow</b>"));
  assert.ok(html.includes("📦 <b>Built-in Skills (1)</b>"));
  assert.ok(html.includes("• <b>antigravity-guide</b>"));
});

test("formatSkillsHtml filters by skill name when specified", () => {
  const skills: CategorizedSkill[] = [
    {
      name: "git-release-workflow",
      description: "Git release methodology",
      path: "/home/user/.gemini/config/skills/git-release-workflow/SKILL.md",
      scope: "global",
    },
  ];

  const filteredHtml = formatSkillsHtml(skills, "git-release-workflow");
  assert.ok(filteredHtml.includes("Skill: git-release-workflow"));
  assert.ok(filteredHtml.includes("🌐 Global"));
  assert.ok(filteredHtml.includes("Git release methodology"));

  const notFoundHtml = formatSkillsHtml(skills, "unknown-skill");
  assert.ok(notFoundHtml.includes('Skill "<b>unknown-skill</b>" not found'));
});

test("formatSkillsHtml handles empty list gracefully", () => {
  const html = formatSkillsHtml([]);
  assert.ok(html.includes("No skills available."));
});
