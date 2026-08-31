import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.js";

test("merges session updates and persists them with restricted permissions", async () => { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-state-")); const file = path.join(directory, "state.json"); const state = new StateStore(file); await state.load(); await state.setSession("123", { conversationId: "conv-1", settings: { mode: "plan" } }); await state.setSession("123", { lastRun: { status: "SUCCESS" } }); assert.deepEqual(state.session("123"), { conversationId: "conv-1", settings: { mode: "plan" }, lastRun: { status: "SUCCESS" } }); assert.equal((await fs.stat(file)).mode & 0o777, 0o600); });

test("tracks and persists inFlight jobs across StateStore reloads", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-state-inflight-"));
  const file = path.join(directory, "state.json");
  const state = new StateStore(file);
  await state.load();
  await state.setInFlight("999", { prompt: "Test prompt", startedAt: 123456789 });
  assert.deepEqual(state.inFlight["999"], { prompt: "Test prompt", startedAt: 123456789 });

  const state2 = new StateStore(file);
  await state2.load();
  assert.deepEqual(state2.inFlight["999"], { prompt: "Test prompt", startedAt: 123456789 });

  await state2.clearInFlight("999");
  assert.equal(state2.inFlight["999"], undefined);
});

test("resetSession removes conversation history while preserving user settings by default", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-state-reset-"));
  const file = path.join(directory, "state.json");
  const state = new StateStore(file);
  await state.load();
  await state.setSession("456", { conversationId: "conv-xyz", settings: { model: "gemini-3.7-flash-low", continueSession: true } });
  assert.equal(state.session("456")?.settings?.model, "gemini-3.7-flash-low");

  await state.resetSession("456");
  assert.equal(state.session("456")?.conversationId, undefined);
  assert.equal(state.session("456")?.settings?.model, "gemini-3.7-flash-low");
  assert.equal(state.session("456")?.settings?.continueSession, false);

  await state.resetSession("456", false);
  assert.equal(state.session("456"), null);
});

