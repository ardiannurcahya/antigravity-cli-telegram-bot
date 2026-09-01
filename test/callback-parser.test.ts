import test from "node:test";
import assert from "node:assert/strict";
import { parseCallbackAction, serializeCallbackData } from "../src/router/callback-parser.js";
import { registeredCommands } from "../src/router/commands.js";
import { EXPECTED_REGISTRY } from "./helpers/original-commands.js";

test("callback parser decodes every wire format the keyboards emit", () => {
  assert.deepEqual(parseCallbackAction("noop"), { kind: "noop" });
  assert.deepEqual(parseCallbackAction("menu:main"), { kind: "menu", menu: "main", page: 0 });
  assert.deepEqual(parseCallbackAction("menu:models:2"), { kind: "menu", menu: "models", page: 2 });
  assert.deepEqual(parseCallbackAction("resume:page:3"), { kind: "resume-page", page: 3 });
  assert.deepEqual(parseCallbackAction("resume:use:f47ac10b-58cc-4372-a567-0e02b2c3d479"), {
    kind: "resume-use",
    conversationId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  });
  assert.deepEqual(parseCallbackAction("action:usage"), { kind: "usage" });
  assert.deepEqual(parseCallbackAction("action:credits"), { kind: "credits" });
  assert.deepEqual(parseCallbackAction("action:context"), { kind: "context" });
  assert.deepEqual(parseCallbackAction("action:setdefault"), { kind: "setdefault" });
  assert.deepEqual(parseCallbackAction("action:update_bot"), { kind: "update-bot" });
  assert.deepEqual(parseCallbackAction("action:new"), { kind: "new-session" });
  assert.deepEqual(parseCallbackAction("action:cancel"), { kind: "cancel" });
  assert.deepEqual(parseCallbackAction("cli:version"), { kind: "cli", command: "version" });
  assert.deepEqual(parseCallbackAction("toggle:disable-slash"), { kind: "toggle", option: "disable-slash" });
  assert.deepEqual(parseCallbackAction("set:model:gemini-3.7-flash-high"), { kind: "set", key: "model", value: "gemini-3.7-flash-high" });
  assert.deepEqual(parseCallbackAction("set:sandbox:off"), { kind: "set", key: "sandbox", value: "off" });
});

test("callback parser rejects unknown payloads like the legacy fall-through", () => {
  for (const unknown of ["", "action", "menu", "random:string", "actions:new"]) {
    assert.equal(parseCallbackAction(unknown), null, `"${unknown}" must not parse`);
  }
  // "set:" with an empty key reaches the set-handler but mutates nothing,
  // matching the legacy behaviour where every key comparison failed.
  const emptyKey = parseCallbackAction("set:");
  assert.ok(emptyKey && emptyKey.kind === "set" && emptyKey.key === "");
});

test("callback parser/serializer round-trips without loss", () => {
  const samples = [
    "noop",
    "menu:main",
    "menu:models:4",
    "resume:page:1",
    "resume:use:f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "action:usage",
    "action:credits",
    "action:context",
    "action:setdefault",
    "action:update_bot",
    "action:new",
    "action:cancel",
    "cli:update",
    "toggle:continue",
    "set:model:x-low",
  ];
  for (const wire of samples) {
    const action = parseCallbackAction(wire);
    assert.ok(action);
    assert.equal(serializeCallbackData(action), wire, `round-trip failed for ${wire}`);
  }
});

test("command registry covers the complete original command surface", () => {
  assert.deepEqual(registeredCommands(), EXPECTED_REGISTRY);
});
