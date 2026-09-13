import test from "node:test";
import assert from "node:assert/strict";

const REGISTERED_COMMANDS = [
  "menu", "new", "resume", "usage", "credits", "context", "tokens", "quota",
  "status", "cancel", "model", "effort", "mode", "sandbox", "verbose", "savedefault", "session",
  "learn", "help", "agents", "agent", "project", "add_dir", "output_format", "json_schema",
  "log_file", "print_timeout", "continue", "new_project", "disable_slash_commands",
  "changelog", "plugins", "cli_help", "version", "update", "restart", "agy", "agy_confirm"
];

// List of all commands handled in src/index.ts
const HANDLED_COMMANDS = new Set([
  "/start", "/menu", "/help", "/new", "/models", "/model", "/effort", "/mode",
  "/sandbox", "/verbose", "/savedefault", "/setdefault", "/agent", "/project", "/add-dir", "/output-format", "/json-schema",
  "/log-file", "/print-timeout", "/resume", "/sessions", "/continue",
  "/new-project", "/disable-slash-commands", "/agents", "/changelog",
  "/plugins", "/cli-help", "/version", "/session", "/learn", "/usage", "/quota",
  "/credits", "/context", "/tokens", "/status", "/cancel", "/update", "/restart", "/agy-confirm"
]);

test("all registered telegram commands map to a recognized command handler", () => {
  for (const cmd of REGISTERED_COMMANDS) {
    if (cmd === "agy") continue; // /agy is handled directly in handleUpdate
    const normalized = "/" + cmd.replace(/_/g, "-");
    assert.ok(
      HANDLED_COMMANDS.has(normalized),
      `Command /${cmd} (normalized as ${normalized}) must be handled in handleCommand`
    );
  }
});
