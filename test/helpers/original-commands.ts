/**
 * Every slash-command literal that the original `src/index.ts` handled,
 * preserved here as the parity baseline for the command registry.
 */
export const ORIGINAL_COMMANDS: string[] = [
  "/start", "/menu", "/help", "/new", "/setdefault", "/savedefault", "/save_default", "/save",
  "/update", "/update_bot", "/update-bot", "/upgrade", "/restart", "/restart_bot", "/restart-bot", "/reboot",
  "/models", "/model", "/effort", "/mode", "/sandbox", "/verbose", "/agent", "/project", "/add-dir",
  "/output-format", "/json-schema", "/log-file", "/print-timeout", "/resume", "/sessions", "/continue",
  "/new-project", "/disable-slash-commands", "/agents", "/changelog", "/plugins", "/cli-help", "/version",
  "/session", "/usage", "/quota", "/credits", "/context", "/tokens", "/status", "/cancel", "/kill", "/stop",
  "/learn", "/compact", "/agy-confirm",
];

export const EXPECTED_REGISTRY: string[] = [...new Set(ORIGINAL_COMMANDS)].sort();
