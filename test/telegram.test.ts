import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { escapeHtml, findReferencedMediaFiles, formatTelegramHtml, formatTelegramHtmlChunks, splitMessage, splitPreformattedHtml } from "../src/telegram.js";
import { createMainKeyboard } from "../src/keyboards.js";

test("splitPreformattedHtml preserves HTML tags without double escaping", () => {
  const html = "📊 <b>Models & Quota</b>\n\n<b>Account:</b> <code>user@example.com</code>\n\n• Weekly Limit: <b>94%</b>";
  const chunks = splitPreformattedHtml(html, 1000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], html);
  // Ensure tags are NOT escaped as &lt;b&gt;
  assert.ok(chunks[0].includes("<b>Models & Quota</b>"));
  assert.ok(!chunks[0].includes("&lt;b&gt;"));
});

test("splits Telegram messages near line boundaries", () => { const chunks = splitMessage("one\ntwo\nthree\nfour", 8); assert.deepEqual(chunks, ["one\ntwo", "three", "four"]); assert.ok(chunks.every((chunk) => chunk.length <= 8)); });

test("builds a persistent new session, model, and quota reply keyboard beside the input", () => {
  const keyboard = createMainKeyboard({ model: "gemini-3.6-flash-high", effort: "high", mode: "plan", sandbox: true, verbose: "detailed" });
  assert.deepEqual(keyboard.keyboard, [["✨ New session", "🤖 Model", "📊 Quota"]]);
  assert.equal(keyboard.resize_keyboard, true);
  assert.equal(keyboard.is_persistent, true);
  assert.equal("inline_keyboard" in keyboard, false);
});

test("formats AGY Markdown-like responses as safe Telegram HTML", () => {
  const html = formatTelegramHtml('# Summary\n\n- **Ready**\n- Run `npm test`\n\n```ts\nconst ok = true;\n```\n\n[Docs](https://example.com?a=1&b=2)\n\n[package.json](file:///var/lib/agybot/project/package.json#L1)');
  assert.match(html, /<b>Summary<\/b>/);
  assert.match(html, /• <b>Ready<\/b>/);
  assert.match(html, /<code>npm test<\/code>/);
  assert.match(html, /<pre><code class="language-ts">const ok = true;<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/example.com\?a=1&amp;b=2">Docs<\/a>/);
  assert.match(html, /<code>package\.json<\/code>/);
  assert.doesNotMatch(html, /<script|<img/);
});

test("converts markdown tables to aligned monospace codeblocks in Telegram HTML", () => {
  const markdown = `Here is a table:

| Component / Service | Category | Status / Purpose |
| :--- | :--- | :--- |
| **API Gateway** | Networking | Entry point & routing |
| **Database** | Storage | State management & logs |
| **Worker Node** | Compute | Background job processor |

End of table.`;

  const html = formatTelegramHtml(markdown);
  assert.match(html, /Here is a table:/);
  assert.match(html, /<pre><code class="language-text">Component \/ Service\s+Category\s+Status \/ Purpose\n─+\nAPI Gateway\s+Networking\s+Entry point &amp; routing\nDatabase\s+Storage\s+State management &amp; logs\nWorker Node\s+Compute\s+Background job processor<\/code><\/pre>/);
  assert.match(html, /End of table\./);
  assert.doesNotMatch(html, /\| \*\*API Gateway\*\*/);
});

test("keeps long responses formatted while chunking under Telegram limits", () => {
  const chunks = formatTelegramHtmlChunks(`# Report\n\n${Array.from({ length: 120 }, (_, index) => `- **Item ${index}**: details`).join("\n")}`, 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
  assert.ok(chunks.every((chunk) => !chunk.includes("###") && !chunk.includes("**")));
  assert.ok(chunks.some((chunk) => chunk.includes("<b>Item 0</b>")));
});

test("does not break a large code block when chunking", () => {
  const chunks = formatTelegramHtmlChunks("```text\n" + "line\n".repeat(2000) + "```", 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
  assert.ok(chunks.every((chunk) => chunk.startsWith("<pre><code") && chunk.endsWith("</code></pre>")));
});

test("escapeHtml properly escapes reserved HTML characters", () => {
  assert.equal(escapeHtml("<script>alert('xss') & test</script>"), "&lt;script&gt;alert('xss') &amp; test&lt;/script&gt;");
  assert.equal(escapeHtml('Audit <Repo> & "Deploy"'), "Audit &lt;Repo&gt; &amp; &quot;Deploy&quot;");
});

test("findReferencedMediaFiles detects markdown images and file paths", async () => {
  const tmpImg = path.join(os.tmpdir(), `test-img-${Date.now()}.png`);
  await fs.writeFile(tmpImg, "fake png content");
  try {
    const text = `Here is the architecture chart:\n\n![Arch](${tmpImg})\n\nAnd check file://${tmpImg}`;
    const media = await findReferencedMediaFiles(text);
    assert.equal(media.length, 1);
    assert.equal(media[0], tmpImg);
  } finally {
    await fs.unlink(tmpImg).catch(() => undefined);
  }
});

test("findReferencedMediaFiles blocks private IP and localhost web images (SSRF protection)", async () => {
  const text = "Check ![Local](http://127.0.0.1:8080/secret.png) and ![Internal](http://192.168.1.50/admin.jpg) and ![Cloud](http://169.254.169.254/latest/meta-data.png)";
  const media = await findReferencedMediaFiles(text);
  assert.equal(media.length, 0);
});

test("formatTelegramHtmlChunks preserves paragraph empty lines between blocks", () => {
  const markdown = "**Header 1**\n• Item 1\n• Item 2\n\n**Header 2**\n• Item 3";
  const chunks = formatTelegramHtmlChunks(markdown, 1000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "<b>Header 1</b>\n• Item 1\n• Item 2\n\n<b>Header 2</b>\n• Item 3");
});

test("formatTelegramHtmlChunks cleans local image markdown paths and formats captions", () => {
  const markdown = "Hier ist das Bild:\n\n![Henrik mit Führerausweis](/tmp/immich_sample.jpg)\n\nUnd hier ohne Caption:\n![](/tmp/another.jpg)\n\nUnd Web-Image:\n![Chart](https://example.com/chart.png)";
  const chunks = formatTelegramHtmlChunks(markdown, 1000);
  assert.equal(chunks.length, 1);
  assert.ok(!chunks[0].includes("/tmp/immich_sample.jpg"));
  assert.ok(!chunks[0].includes("/tmp/another.jpg"));
  assert.ok(chunks[0].includes("🖼 <i>Henrik mit Führerausweis</i>"));
  assert.ok(chunks[0].includes('🖼 <a href="https://example.com/chart.png">Chart</a>'));
});

