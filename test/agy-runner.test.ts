import test from "node:test";
import assert from "node:assert/strict";
import { buildArgs, extractConversationId, formatStepUpdate, normalizeUsage, parseCommandArgs, parseStreamOutput, runAgyCommand, validateCustomArgs } from "../src/agy-runner.js";
import type { AgyConfig } from "../src/types.js";

const config: AgyConfig = { timeoutMs: 60000, project: "project", mode: "plan", model: "model", effort: "high", sandbox: true, allowSandboxDisable: false, allowDangerouslySkipPermissions: false, allowedModels: [], bin: "agy", workspace: "/tmp" , maxOutputBytes: 2000000 };

test("builds non-interactive safe AGY arguments", () => {
  assert.deepEqual(buildArgs(config, "hello", "conv-1"), ["--print", "hello", "--output-format", "stream-json", "--print-timeout", "60s", "--project", "project", "--mode", "plan", "--model", "model", "--effort", "high", "--sandbox", "--conversation", "conv-1"]);
});

test("passes the selected agent to AGY", () => {
  const args = buildArgs(config, "hello", null, { agent: "reviewer" });
  const index = args.indexOf("--agent");
  assert.equal(index >= 0, true);
  assert.deepEqual(args.slice(index, index + 2), ["--agent", "reviewer"]);
});

test("builds the complete non-interactive option set", () => {
  assert.deepEqual(buildArgs(config, "hello", null, {
    agent: "reviewer", addDirs: ["/one", "/two"], continueSession: true, newProject: true,
    disableSlashCommands: true, jsonSchema: '{"type":"object"}', logFile: "/tmp/agy.log",
    printTimeout: "10m", dangerouslySkipPermissions: true,
  }), ["--print", "hello", "--output-format", "stream-json", "--print-timeout", "10m", "--project", "project", "--mode", "plan", "--model", "model", "--effort", "high", "--agent", "reviewer", "--add-dir", "/one", "--add-dir", "/two", "--new-project", "--disable-slash-commands", "--json-schema", '{"type":"object"}', "--log-file", "/tmp/agy.log", "--dangerously-skip-permissions", "--sandbox", "--continue"]);
});

test("prioritizes --conversation over --continue when conversationId is provided", () => {
  const args = buildArgs(config, "hello", "uuid-1234", { continueSession: true });
  assert.ok(args.includes("--conversation"));
  assert.equal(args[args.indexOf("--conversation") + 1], "uuid-1234");
  assert.ok(!args.includes("--continue"));
});

test("parses quoted custom command arguments without a shell", () => {
  assert.deepEqual(parseCommandArgs('--print "say \\"hello\\"" --output-format text'), ["--print", 'say "hello"', "--output-format", "text"]);
  assert.deepEqual(parseCommandArgs('--project "" --print hello'), ["--project", "", "--print", "hello"]);
  assert.equal(validateCustomArgs(["--print", "hello"]), null);
  assert.equal(validateCustomArgs(["plugin", "list"]), null);
  assert.match(validateCustomArgs(["--prompt-interactive", "hello"]) || "", /TTY/);
  assert.equal(validateCustomArgs(["models"]), null);
  assert.equal(validateCustomArgs(["--help"]), null);
});

test("builds per-session overrides without unsafe flags", () => {
  assert.deepEqual(buildArgs(config, "hello", null, { model: "claude-sonnet-4-6", effort: "low", mode: "accept-edits", sandbox: false }), ["--print", "hello", "--output-format", "stream-json", "--print-timeout", "60s", "--project", "project", "--mode", "accept-edits", "--model", "claude-sonnet-4-6"]);
});

test("extracts nested conversation IDs", () => {
  assert.equal(extractConversationId({ result: { conversation_id: "conv-2" } }), "conv-2");
  assert.equal(extractConversationId({ output: "text" }), null);
});

test("parses stream events, response drafts, and usage", () => {
  const output = [
    JSON.stringify({ event: "init", conversation_id: "conv-4", init: { model: "gemini-3.6-flash-low" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "partial " } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "run_command", tool_info: { name: "run_command" } } }),
    JSON.stringify({ event: "result", result: { conversation_id: "conv-4", status: "SUCCESS", response: "done\n", duration_seconds: 2.5, num_turns: 1, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } }),
  ].join("\n");
  const parsed = parseStreamOutput(output);
  assert.equal(parsed.text, "done"); assert.equal(parsed.conversationId, "conv-4"); assert.equal(parsed.model, "gemini-3.6-flash-low");
  assert.deepEqual(parsed.usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 }); assert.equal(parsed.durationMs, 2500); assert.equal(parsed.numTurns, 1); assert.equal(parsed.toolCalls, 1); assert.equal(parsed.status, "SUCCESS");
});

test("normalizes usage and formats progress", () => {
  assert.deepEqual(normalizeUsage({ input_tokens: "5", output_tokens: -1, total_tokens: "bad" }), { input_tokens: 5 });
  assert.equal(normalizeUsage(null), null);
  assert.equal(formatStepUpdate({ tool_info: { name: "run_command" } }), "⚙️ Running command...");
  assert.equal(formatStepUpdate({ tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } } }), "⚙️ Command: npm test");
  assert.equal(formatStepUpdate({ tool_info: { name: "search_web", parameters: { query: "werecycle" } } }), "🔍 Web search: \"werecycle\"");
  assert.equal(formatStepUpdate({ step_type: "agent_response" }), "💬 Generating response...");
});

test("runs a read-only AGY subcommand without Telegram secrets", async () => {
  const output = await runAgyCommand({ ...config, bin: process.execPath }, ["-e", "process.stdout.write(process.env.TELEGRAM_BOT_TOKEN || 'clean')"]);
  assert.equal(output, "clean");
});

test("returns successful stderr output for CLIs that print help there", async () => {
  const output = await runAgyCommand({ ...config, bin: process.execPath }, ["-e", "process.stderr.write('Usage: agy --help')"]);
  assert.equal(output, "Usage: agy --help");
});

test("cancels a running custom AGY command and its process group", async () => {
  const controller = new AbortController();
  const running = runAgyCommand({ ...config, bin: process.execPath }, ["-e", "setTimeout(() => {}, 60000)"], 60000, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await assert.rejects(running, /AGY command cancelled/);
});

test("extracts nested final response text from stream results", () => {
  const parsed = parseStreamOutput(JSON.stringify({ event: "result", result: { result: { final_output: "nested answer" }, status: "SUCCESS" } }));
  assert.equal(parsed.text, "nested answer");
});

test("surfaces tool errors when AGY finishes without response text", () => {
  const parsed = parseStreamOutput(JSON.stringify({
    event: "step_update",
    step_update: { state: "ERROR", tool_info: { error: { message: "User denied permission to run command" } } },
  }) + "\n" + JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }));
  assert.match(parsed.text, /could not complete/i);
  assert.match(parsed.text, /denied permission/);
});

test("enables full-control permissions from explicit config", () => {
  const fullControl = { ...config, allowDangerouslySkipPermissions: true };
  assert.ok(buildArgs(fullControl, "hello", null).includes("--dangerously-skip-permissions"));
});

test("attaches image file reference and directory in buildArgs", () => {
  const args = buildArgs(config, "Describe this photo", null, { imagePath: "/tmp/uploads/photo_123.jpg" });
  assert.ok(args[1].includes("Describe this photo"));
  assert.ok(args[1].includes("[Image attached: /tmp/uploads/photo_123.jpg]"));
  assert.ok(args.includes("--add-dir"));
  assert.ok(args.includes("/tmp/uploads"));
});

test("attaches document file reference and directory in buildArgs", () => {
  const args = buildArgs(config, "Summarize this PDF", null, { documentPath: "/tmp/workspace/uploads/report.pdf", documentName: "report.pdf" });
  assert.ok(args[1].includes("Summarize this PDF"));
  assert.ok(args[1].includes("[Document attached: /tmp/workspace/uploads/report.pdf]"));
  assert.ok(args.includes("--add-dir"));
  assert.ok(args.includes("/tmp/workspace/uploads"));
});

test("attaches media file reference and directory in buildArgs", () => {
  const args = buildArgs(config, "Transcribe this", null, { mediaPath: "/tmp/uploads/audio.mp3", mediaType: "Audio" });
  assert.ok(args[1].includes("Transcribe this"));
  assert.ok(args[1].includes("[Audio attached: /tmp/uploads/audio.mp3]"));
  assert.ok(args.includes("--add-dir"));
  assert.ok(args.includes("/tmp/uploads"));
});

test("isolates intermediate delegation preamble from final answer in parseStreamOutput", () => {
  const stdout = [
    JSON.stringify({ event: "init", conversation_id: "conv-sub", init: { model: "gemini-3.8-flash" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "I will delegate this task to research subagent." } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "subagent", subagent_info: { name: "research", role: "Codebase Researcher" } } }),
    JSON.stringify({ event: "step_update", step_update: { text_delta: "Here is the definitive answer." } }),
    JSON.stringify({ event: "result", result: { conversation_id: "conv-sub", status: "SUCCESS", response: "I will delegate this task to research subagent.\n\nHere is the definitive answer." } }),
  ].join("\n");
  const parsed = parseStreamOutput(stdout);
  assert.equal(parsed.intermediateText, "I will delegate this task to research subagent.");
  assert.equal(parsed.text, "Here is the definitive answer.");
  assert.equal(parsed.toolCalls, 1);
});

test("preserves pure single-turn output without intermediateText", () => {
  const stdout = [
    JSON.stringify({ event: "init", conversation_id: "conv-single", init: { model: "gemini-3.8-flash" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Direct answer" } }),
    JSON.stringify({ event: "result", result: { conversation_id: "conv-single", status: "SUCCESS", response: "Direct answer" } }),
  ].join("\n");
  const parsed = parseStreamOutput(stdout);
  assert.equal(parsed.intermediateText, null);
  assert.equal(parsed.text, "Direct answer");
  assert.equal(parsed.toolCalls, 0);
});

test("formats subagent updates with role or name", () => {
  assert.equal(formatStepUpdate({ subagent_info: { role: "Codebase Researcher" } }), "🤖 Subagent: Codebase Researcher");
  assert.equal(formatStepUpdate({ subagent_info: { name: "research" } }), "🤖 Subagent: research");
  assert.equal(formatStepUpdate({ subagent_info: {} }), "🤖 Delegating to subagent...");
  assert.equal(formatStepUpdate({ step_type: "subagent" }), "🤖 Delegating to subagent...");
});

test("isolates multi-turn intermediate preambles even when response concatenates with single newlines", () => {
  const stdout = [
    JSON.stringify({ event: "init", conversation_id: "conv-multi", init: { model: "gemini-3.8-flash" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Le sous-agent a été lancé." } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "subagent", subagent_info: { name: "research" } } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "La vérification est en cours." } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "tool", tool_info: { name: "manage_subagents" } } }),
    JSON.stringify({ event: "step_update", step_update: { text_delta: "Synthèse finale : Node v24.20.0 LTS." } }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-multi",
        status: "SUCCESS",
        response: "Le sous-agent a été lancé.\nLa vérification est en cours.\nSynthèse finale : Node v24.20.0 LTS.",
      },
    }),
  ].join("\n");
  const parsed = parseStreamOutput(stdout);
  assert.equal(parsed.intermediateText, "Le sous-agent a été lancé.\n\nLa vérification est en cours.");
  assert.equal(parsed.text, "Synthèse finale : Node v24.20.0 LTS.");
  assert.equal(parsed.toolCalls, 2);
});

test("isolates intermediate waiting turns followed by system messages without intervening tools", () => {
  const stdout = [
    JSON.stringify({ event: "init", conversation_id: "conv-wait", init: { model: "gemini-3.8-flash" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", text_delta: "Le sous-agent a été mandaté." } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 2, step_type: "subagent", subagent_info: { name: "research" } } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 3, step_type: "agent_response", text_delta: "Le sous-agent est en train de finaliser la synthèse." } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 4, step_type: "system_message", text_delta: "Rapport reçu du sous-agent." } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 5, step_type: "agent_response", text_delta: "Voici les informations officielles : Node v24.20.0." } }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-wait",
        status: "SUCCESS",
        response: "Le sous-agent a été mandaté.\nLe sous-agent est en train de finaliser la synthèse.\nVoici les informations officielles : Node v24.20.0.",
      },
    }),
  ].join("\n");
  const parsed = parseStreamOutput(stdout);
  assert.equal(parsed.intermediateText, "Le sous-agent a été mandaté.\n\nLe sous-agent est en train de finaliser la synthèse.");
  assert.equal(parsed.text, "Voici les informations officielles : Node v24.20.0.");
  assert.equal(parsed.toolCalls, 1);
});



