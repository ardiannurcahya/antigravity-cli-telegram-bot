import test from "node:test";
import assert from "node:assert/strict";
import { generateShortTopicName } from "../src/domain/topic-namer.js";

test("generates ultra-short names for direct categories", () => {
  assert.equal(generateShortTopicName("Kannst du das Bild dieser Gruppe hier ändern in was cooles"), "🖼️ Avatar");
  assert.equal(generateShortTopicName("Test"), "🧪 Test");
  assert.equal(generateShortTopicName("Wie ist das Wetter in Zürich?"), "☀️ Wetter");
  assert.equal(generateShortTopicName("Zeig mir den Tesla Ladestand"), "🚗 Tesla");
  assert.equal(generateShortTopicName("Fix den Bug in docker-compose"), "🐳 Docker");
  assert.equal(generateShortTopicName("Erstelle einen Commit auf GitHub"), "🐙 GitHub");
  assert.equal(generateShortTopicName("Wie viel Geld habe ich in Krypto?"), "📈 Finanzen");
  assert.equal(generateShortTopicName("Wie war mein Schlaf mit Garmin?"), "🏃 Fitness");
  assert.equal(generateShortTopicName("Schalte das Licht im Wohnzimmer ein"), "🏠 Smart Home");
  assert.equal(generateShortTopicName("Habe ich ungelesene E-Mails?"), "✉️ E-Mail");
  assert.equal(generateShortTopicName("Buche mir einen Flug nach London"), "✈️ Reise");
});

test("filters stop words and truncates cleanly under 17 chars for custom prompts", () => {
  const name1 = generateShortTopicName("Erstelle mir ein tolles Rezept");
  assert.ok(name1.length <= 16);
  assert.ok(name1.startsWith("💬 "));

  const name2 = generateShortTopicName("Supercalifragilisticexpialidocious question");
  assert.ok(name2.length <= 16);
});

test("returns fallback on empty prompt", () => {
  assert.equal(generateShortTopicName(""), "💬 Chat");
  assert.equal(generateShortTopicName("   "), "💬 Chat");
});
