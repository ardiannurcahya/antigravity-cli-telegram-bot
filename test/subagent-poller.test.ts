import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkForSubagentMessages,
  isStillWaitingTurn,
  SubagentPoller,
} from "../src/usecases/subagent-poller.js";
import type { AgyResult } from "../src/types.js";

test("checkForSubagentMessages returns false when directory does not exist", () => {
  const fakeDbPath = path.join(os.tmpdir(), "nonexistent-" + Date.now(), "db.sqlite");
  assert.equal(checkForSubagentMessages(fakeDbPath, "conv-1"), false);
});

test("checkForSubagentMessages detects unread message files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-poll-test-"));
  try {
    const fakeDbPath = path.join(tmpDir, "db.sqlite");
    const convId = "conv-test-123";
    const messagesDir = path.join(tmpDir, "brain", convId, ".system_generated", "messages");
    fs.mkdirSync(messagesDir, { recursive: true });

    // Empty messages dir
    assert.equal(checkForSubagentMessages(fakeDbPath, convId), false);

    // Unread message file added
    const msgFile = path.join(messagesDir, "msg-001.json");
    fs.writeFileSync(msgFile, JSON.stringify({ content: "Hello from subagent" }));
    assert.equal(checkForSubagentMessages(fakeDbPath, convId), true);

    // Marked as read in read.json
    const readPath = path.join(messagesDir, "read.json");
    fs.writeFileSync(readPath, JSON.stringify({ "msg-001": true }));
    assert.equal(checkForSubagentMessages(fakeDbPath, convId), false);

    // Another unread message arrives
    const msgFile2 = path.join(messagesDir, "msg-002.json");
    fs.writeFileSync(msgFile2, JSON.stringify({ content: "Another message" }));
    assert.equal(checkForSubagentMessages(fakeDbPath, convId), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("isStillWaitingTurn returns true for pending subagent state", () => {
  const waitingResult: AgyResult = {
    text: "Subagent launched, waiting for response...",
    intermediateText: null,
    parsed: null,
    events: [],
    conversationId: "conv-1",
    model: "gemini-3.8-flash",
    usage: null,
    durationMs: 1000,
    numTurns: 1,
    toolCalls: 1,
    status: "SUCCESS",
    subagentState: {
      hasInvokedSubagent: true,
      isWaitingTurn: true,
      subagentRole: "Investigator",
    },
  };
  assert.equal(isStillWaitingTurn(waitingResult), true);
});

test("isStillWaitingTurn returns true when text contains [SUBAGENT_IN_PROGRESS]", () => {
  const inProgressResult: AgyResult = {
    text: "Status: [SUBAGENT_IN_PROGRESS]",
    intermediateText: null,
    parsed: null,
    events: [],
    conversationId: "conv-1",
    model: "gemini-3.8-flash",
    usage: null,
    durationMs: 1000,
    numTurns: 1,
    toolCalls: 0,
    status: "SUCCESS",
  };
  assert.equal(isStillWaitingTurn(inProgressResult), true);
});

test("isStillWaitingTurn returns false for finalized synthesized response", () => {
  const doneResult: AgyResult = {
    text: "Here is the completed synthesis: All 25 dependencies are updated and all tests pass.",
    intermediateText: null,
    parsed: null,
    events: [],
    conversationId: "conv-1",
    model: "gemini-3.8-flash",
    usage: { input_tokens: 1500, output_tokens: 250 },
    durationMs: 3500,
    numTurns: 2,
    toolCalls: 0,
    status: "SUCCESS",
    subagentState: {
      hasInvokedSubagent: false,
      isWaitingTurn: false,
    },
  };
  assert.equal(isStillWaitingTurn(doneResult), false);
});

test("SubagentPoller tracks, checks, and cancels active polling per chat", () => {
  const poller = new SubagentPoller();
  assert.equal(poller.isPolling(12345), false);
  assert.equal(poller.cancelPolling(12345), false);
});
