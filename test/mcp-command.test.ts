import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMcpList,
  formatMcpHtml,
  sanitizeSecrets,
  type McpServerItem,
} from "../src/usecases/mcp-command.js";
import { isDangerousCustomCommand } from "../src/usecases/custom-agy.js";

test("parseMcpList parses tabular output correctly", () => {
  const rawOutput = `
NAME    TYPE   STATUS   COMMAND/URL
memory  stdio  enabled  /opt/memory-engine/.venv/bin/python3 /opt/memory-engine/agy_memory_mcp.py
test-server sse disabled https://example.com/sse
`.trim();

  const servers = parseMcpList(rawOutput);
  assert.equal(servers.length, 2);
  assert.equal(servers[0].name, "memory");
  assert.equal(servers[0].type, "stdio");
  assert.equal(servers[0].status, "enabled");
  assert.ok(servers[0].commandOrUrl.includes("agy_memory_mcp.py"));

  assert.equal(servers[1].name, "test-server");
  assert.equal(servers[1].type, "sse");
  assert.equal(servers[1].status, "disabled");
  assert.equal(servers[1].commandOrUrl, "https://example.com/sse");
});

test("parseMcpList handles empty or header-only output", () => {
  assert.deepEqual(parseMcpList(""), []);
  assert.deepEqual(parseMcpList("NAME TYPE STATUS COMMAND/URL"), []);
  assert.deepEqual(parseMcpList("Some random output without header"), []);
});

test("formatMcpHtml renders configured servers with status indicators", () => {
  const rawOutput = `
NAME    TYPE   STATUS   COMMAND/URL
memory  stdio  enabled  /path/to/python memory.py
github  sse    disabled https://mcp.github.com
`.trim();

  const html = formatMcpHtml(rawOutput);
  assert.ok(html.includes("Configured MCP Servers (2)"));
  assert.ok(html.includes("• <b>memory</b> (stdio) — 🟢 <i>enabled</i>"));
  assert.ok(html.includes("<code>/path/to/python memory.py</code>"));
  assert.ok(html.includes("• <b>github</b> (sse) — 🔴 <i>disabled</i>"));
  assert.ok(html.includes("<code>https://mcp.github.com</code>"));
});

test("formatMcpHtml handles no configured servers", () => {
  const html = formatMcpHtml("NAME TYPE STATUS COMMAND/URL\n");
  assert.ok(html.includes("No configured MCP servers."));
});

test("sanitizeSecrets masks sensitive tokens and credentials", () => {
  const sensitive1 = ["bot", "123456789", ":", "ABCdefGHIjklMNOpqrsTUVwxyz123456789"].join("");
  assert.equal(sanitizeSecrets(sensitive1), "[REDACTED_TELEGRAM_TOKEN]");

  const sensitive2 = "https://api.example.com?api_key=abcdef1234567890abcdef";
  assert.ok(sanitizeSecrets(sensitive2).includes("[REDACTED]"));
});

test("isDangerousCustomCommand flags MCP mutating commands", () => {
  assert.equal(isDangerousCustomCommand(["mcp", "list"]), false);
  assert.equal(isDangerousCustomCommand(["mcp", "enable", "memory"]), true);
  assert.equal(isDangerousCustomCommand(["mcp", "disable", "memory"]), true);
  assert.equal(isDangerousCustomCommand(["mcp", "add", "new-srv"]), true);
  assert.equal(isDangerousCustomCommand(["mcp", "remove", "old-srv"]), true);
  assert.equal(isDangerousCustomCommand(["plugins", "list"]), false);
  assert.equal(isDangerousCustomCommand(["plugin", "install", "foo"]), true);
});
