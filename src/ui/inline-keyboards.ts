import type { AppContext } from "../context.js";
import { getActiveModels } from "../models.js";
import { settingsFor } from "../domain/settings.js";
import { listAvailableWorkspaces } from "../domain/workspace.js";
import type { ChatId, InlineKeyboardMarkup, InlineButton, ConversationSummary } from "../types.js";

export function button(text: string, callback_data: string): { text: string; callback_data: string } { return { text, callback_data }; }

export function backKeyboard(): InlineKeyboardMarkup { return { inline_keyboard: [[button("‹ Back", "menu:main")]] }; }

export function resumeKeyboard(page = 0, totalPages = 1, items: ConversationSummary[] = []): InlineKeyboardMarkup {
  const rows: InlineButton[][] = items.map((item) => [
    button(
      item.display_title.length > 40 ? `${item.display_title.slice(0, 37)}...` : item.display_title,
      `resume:use:${item.conversation_id}`
    ),
  ]);
  const navigation: InlineButton[] = [];
  if (page > 0) navigation.push(button("‹ Previous", `resume:page:${page - 1}`));
  navigation.push(button(`Page ${page + 1}/${totalPages}`, "noop"));
  if (page < totalPages - 1) navigation.push(button("Next ›", `resume:page:${page + 1}`));
  if (navigation.length) rows.push(navigation);
  rows.push([button("‹ Back", "menu:main")]);
  return { inline_keyboard: rows };
}

export function modelKeyboard(context: AppContext, chatId: ChatId, page = 0): InlineKeyboardMarkup {
  const pageSize = 5;
  const models = getActiveModels();
  const totalPages = Math.max(1, Math.ceil(models.length / pageSize));
  const normalizedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const selected = settingsFor(context, chatId).model;
  const rows = models.slice(normalizedPage * pageSize, normalizedPage * pageSize + pageSize).map((model) => [button(`${model.id === selected ? "✅ " : ""}${model.label}`, `set:model:${model.id}`)]);
  const navigation = [];
  if (normalizedPage > 0) navigation.push(button("‹", `menu:models:${normalizedPage - 1}`));
  navigation.push(button(`${normalizedPage + 1}/${totalPages}`, "noop"));
  if (normalizedPage < totalPages - 1) navigation.push(button("›", `menu:models:${normalizedPage + 1}`));
  rows.push(navigation);
  rows.push([button("‹ Back", "menu:main")]);
  return { inline_keyboard: rows };
}

export function effortKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(context, chatId).effort;
  const choices = ["low", "medium", "high"].map((value) => button(`${value === selected ? "✅ " : ""}${value}`, `set:effort:${value}`));
  return { inline_keyboard: [choices, [button("‹ Back", "menu:main")]] };
}

export function modeKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(context, chatId).mode;
  const choices = ["plan", "accept-edits"].map((value) => button(`${value === selected ? "✅ " : ""}${value}`, `set:mode:${value}`));
  return { inline_keyboard: [choices, [button("‹ Back", "menu:main")]] };
}

export function sandboxKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(context, chatId).sandbox;
  const disableAllowed = context.config.agy.allowSandboxDisable || !context.config.agy.sandbox;
  return { inline_keyboard: [[button(`${selected ? "✅ " : ""}On`, "set:sandbox:on"), button(`${!selected ? "✅ " : ""}Off${disableAllowed ? "" : " (locked)"}`, disableAllowed ? "set:sandbox:off" : "noop")], [button("‹ Back", "menu:main")]] };
}

export function verboseKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(context, chatId).verbose || "detailed";
  const choices = ["detailed", "compact", "silent"].map((value) => button(`${value === selected ? "✅ " : ""}${value}`, `set:verbose:${value}`));
  return { inline_keyboard: [choices, [button("‹ Back", "menu:main")]] };
}

export function workspaceKeyboard(context: AppContext, chatId: ChatId, page = 0): InlineKeyboardMarkup {
  const pageSize = 6;
  const currentSettings = settingsFor(context, chatId);
  const activeWs = currentSettings.workspace;
  const workspaces = listAvailableWorkspaces(context.config.agy.projectsRoot, context.config.agy.workspace);
  const totalPages = Math.max(1, Math.ceil(workspaces.length / pageSize));
  const normalizedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = workspaces.slice(normalizedPage * pageSize, normalizedPage * pageSize + pageSize);

  const rows: InlineButton[][] = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row: InlineButton[] = [];
    const item1 = slice[i];
    const isSelected1 = activeWs === item1.path;
    row.push(button(`${isSelected1 ? "✅ " : "📁 "}${item1.name}`, `set:ws:${item1.name}`));
    if (slice[i + 1]) {
      const item2 = slice[i + 1];
      const isSelected2 = activeWs === item2.path;
      row.push(button(`${isSelected2 ? "✅ " : "📁 "}${item2.name}`, `set:ws:${item2.name}`));
    }
    rows.push(row);
  }

  if (totalPages > 1) {
    const navigation: InlineButton[] = [];
    if (normalizedPage > 0) navigation.push(button("‹", `menu:workspace:${normalizedPage - 1}`));
    navigation.push(button(`${normalizedPage + 1}/${totalPages}`, "noop"));
    if (normalizedPage < totalPages - 1) navigation.push(button("›", `menu:workspace:${normalizedPage + 1}`));
    rows.push(navigation);
  }

  const actionsRow: InlineButton[] = [];
  if (activeWs) {
    actionsRow.push(button("🔄 Reset default", "set:ws:clear"));
  }
  actionsRow.push(button("‹ Back", "menu:main"));
  rows.push(actionsRow);

  return { inline_keyboard: rows };
}

export function profileLabel(profile: import("../types.js").MenuProfile): string {
  if (profile === "daily") return "Daily";
  if (profile === "dev") return "Dev";
  return "Mixed";
}

export function menuProfileKeyboard(currentProfile: import("../types.js").MenuProfile): InlineKeyboardMarkup {
  const profiles: Array<{ id: import("../types.js").MenuProfile; label: string; desc: string }> = [
    { id: "mixed", label: "Mixed", desc: "Balanced (default)" },
    { id: "daily", label: "Daily", desc: "Minimalist & Voice" },
    { id: "dev", label: "Dev", desc: "Workspace & Context" },
  ];
  const rows: InlineButton[][] = profiles.map((p) => [
    button(`${p.id === currentProfile ? "✅ " : ""}${p.label} - ${p.desc}`, `set:profile:${p.id}`),
  ]);
  rows.push([button("‹ Back to Menu", "menu:main")]);
  return { inline_keyboard: rows };
}

export function mainInlineKeyboard(context?: AppContext, chatId?: ChatId): InlineKeyboardMarkup {
  const profile = context && chatId ? (settingsFor(context, chatId).menuProfile || "mixed") : "mixed";
  const profileBtn = button(`🔄 Profile: ${profileLabel(profile)} ▾`, "menu:profile");
  const closeBtn = button("❌ Close", "action:cancel");

  if (profile === "daily") {
    return {
      inline_keyboard: [
        [button("🤖 Model", "menu:models"), button("🧠 Effort", "menu:effort")],
        [button("🎙️ Voice Settings", "menu:voice"), button("📂 History / Resume", "menu:resume")],
        [profileBtn, closeBtn],
      ],
    };
  }

  if (profile === "dev") {
    return {
      inline_keyboard: [
        [button("📁 Workspace", "menu:workspace"), button("📂 Resume Session", "menu:resume")],
        [button("⚙️ Mode (Plan/Edit)", "menu:mode"), button("🛡️ Sandbox", "menu:sandbox")],
        [button("🤖 Model", "menu:models"), button("🧠 Effort", "menu:effort")],
        [button("🛠️ CLI Options", "menu:cli"), button("🧠 Active Context", "action:context")],
        [profileBtn, closeBtn],
      ],
    };
  }

  // Mixed / Balanced Profile (Default)
  return {
    inline_keyboard: [
      [button("🤖 Model", "menu:models"), button("🧠 Effort", "menu:effort")],
      [button("🎙️ Voice Settings", "menu:voice"), button("📁 Workspace", "menu:workspace")],
      [button("⚙️ Mode & Sandbox", "menu:modesandbox"), button("🛠️ CLI & Tools", "menu:clitools")],
      [profileBtn, closeBtn],
    ],
  };
}

export function modeSandboxKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  return {
    inline_keyboard: [
      [button(`⚙️ Mode: ${settings.mode}`, "menu:mode"), button(`🛡️ Sandbox: ${settings.sandbox ? "On" : "Off"}`, "menu:sandbox")],
      [button(`Verbose: ${settings.verbose || "detailed"}`, "menu:verbose"), button("Session Info", "menu:session")],
      [button("‹ Back", "menu:main")],
    ],
  };
}

export function cliToolsKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button("🛠️ CLI Options", "menu:cli"), button("🧠 Active Context", "action:context")],
      [button("📊 Usage / Quota", "action:usage"), button("🧩 Plugins", "menu:plugins")],
      [button("AGY Models", "cli:models"), button("AGY Agents", "cli:agents")],
      [button("Changelog", "cli:changelog"), button("CLI Help", "cli:help")],
      [button("CLI Version", "cli:version"), button("Custom /agy", "menu:custom")],
      [button("Update CLI", "cli:update"), button("🔄 Update Bot", "action:update_bot")],
      [button("💾 Set as Default", "action:setdefault"), button("New session", "action:new")],
      [button("‹ Back", "menu:main")],
    ],
  };
}

export function voiceSettingsKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  const stt = settings.sttProvider || context.config.stt.provider || "none";
  const tts = settings.ttsMode || context.config.tts?.mode || "off";
  return {
    inline_keyboard: [
      [button(`🎙️ STT (${stt})`, "menu:stt"), button(`🔊 TTS (${tts})`, "menu:tts")],
      [button("‹ Back", "menu:main")],
    ],
  };
}

export function cliOptionsKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  return {
    inline_keyboard: [
      [button("Project", "cli:project"), button("Agent", "cli:agent")],
      [button(`Continue: ${settings.continueSession ? "on" : "off"}`, "toggle:continue"), button(`New project: ${settings.newProject ? "on" : "off"}`, "toggle:new-project")],
      [button(`Output: ${settings.outputFormat}`, "menu:output"), button(`Slash cmds: ${settings.disableSlashCommands ? "off" : "on"}`, "toggle:disable-slash")],
      [button("Add directory", "cli:add-dir"), button("JSON schema", "cli:json-schema")],
      [button("Log file", "cli:log-file"), button("Print timeout", "cli:print-timeout")],
      [button("Conversation ID", "cli:conversation"), button("Prompt flags", "cli:prompt")],
      [button("‹ Back", "menu:clitools")],
    ],
  };
}

export function outputFormatKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(context, chatId).outputFormat;
  return {
    inline_keyboard: [
      ["text", "json", "stream-json"].map((value) => button(`${selected === value ? "✅ " : ""}${value}`, `set:output:${value}`)),
      [button("‹ Back", "menu:cli")],
    ],
  };
}

export function sttKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  const provider = settings.sttProvider || context.config.stt.provider;
  const whisperModel = settings.sttWhisperModel || context.config.stt.whisperModel;
  const lang = settings.sttLang || context.config.stt.language;

  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [button(`🎙️ Provider: ${provider}`, "menu:stt:provider")],
  ];

  if (provider === "whisper-local") {
    rows.push([
      button(`🧠 Whisper: ${whisperModel}`, "menu:stt:whisper"),
      button(`🌐 Lang: ${lang}`, "menu:stt:lang"),
    ]);
  } else if (provider !== "none") {
    rows.push([button(`🌐 Lang: ${lang}`, "menu:stt:lang")]);
  }

  rows.push([button("‹ Back", "menu:main")]);
  return { inline_keyboard: rows };
}

export function sttProviderKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  const selected = settings.sttProvider || context.config.stt.provider;
  const choices: Array<"whisper-local" | "gemini" | "agy" | "none"> = [
    "whisper-local",
    "gemini",
    "agy",
    "none",
  ];
  const rows = choices.map((choice) => [
    button(`${choice === selected ? "✅ " : ""}${choice}`, `set:stt:provider:${choice}`),
  ]);
  rows.push([button("‹ Back", "menu:stt")]);
  return { inline_keyboard: rows };
}

export function sttWhisperModelKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  const selected = settings.sttWhisperModel || context.config.stt.whisperModel;
  const choices = ["tiny", "base", "small", "medium"];
  const rows = choices.map((choice) => [
    button(`${choice === selected ? "✅ " : ""}${choice}`, `set:stt:whisper:${choice}`),
  ]);
  rows.push([button("‹ Back", "menu:stt")]);
  return { inline_keyboard: rows };
}

export function sttLangKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  const selected = settings.sttLang || context.config.stt.language || "auto";
  const choices = [
    { label: "Auto-detect", id: "auto" },
    { label: "English", id: "en" },
    { label: "German", id: "de" },
    { label: "French", id: "fr" },
    { label: "Italian", id: "it" },
    { label: "Spanish", id: "es" },
  ];
  const rows = choices.map((choice) => [
    button(`${choice.id === selected ? "✅ " : ""}${choice.label} (${choice.id})`, `set:stt:lang:${choice.id}`),
  ]);
  rows.push([button("‹ Back", "menu:stt")]);
  return { inline_keyboard: rows };
}

export function ttsKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  const mode = settings.ttsMode || context.config.tts?.mode || "off";
  const voice = settings.ttsVoice || context.config.tts?.voice || "en-US-AndrewMultilingualNeural";
  const displayVoice = voice.replace(/^(en-US-|en-GB-|de-DE-)/, "").replace("Neural", "");

  return {
    inline_keyboard: [
      [button(`🔊 Mode: ${mode}`, "menu:tts:mode")],
      [button(`🗣️ Voice: ${displayVoice}`, "menu:tts:voice")],
      [button("‹ Back", "menu:main")],
    ],
  };
}

export function ttsModeKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  const selected = settings.ttsMode || context.config.tts?.mode || "off";
  const choices: Array<"off" | "voice-only" | "voice-and-text" | "auto"> = ["off", "voice-only", "voice-and-text", "auto"];
  const rows = choices.map((choice) => [
    button(`${choice === selected ? "✅ " : ""}${choice}`, `set:tts:mode:${choice}`),
  ]);
  rows.push([button("‹ Back", "menu:tts")]);
  return { inline_keyboard: rows };
}

export function ttsVoiceKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  const selected = settings.ttsVoice || context.config.tts?.voice || "en-US-AndrewMultilingualNeural";
  const choices = [
    { label: "Andrew (English - US, Multilingual Male)", id: "en-US-AndrewMultilingualNeural" },
    { label: "Ava (English - US, Multilingual Female)", id: "en-US-AvaMultilingualNeural" },
    { label: "Brian (English - US, Multilingual Male)", id: "en-US-BrianMultilingualNeural" },
    { label: "Emma (English - US, Multilingual Female)", id: "en-US-EmmaMultilingualNeural" },
    { label: "Sonia (English - UK Female)", id: "en-GB-SoniaNeural" },
    { label: "Ryan (English - UK Male)", id: "en-GB-RyanNeural" },
    { label: "Florian (German Multilingual Male)", id: "de-DE-FlorianMultilingualNeural" },
    { label: "Seraphina (German Multilingual Female)", id: "de-DE-SeraphinaMultilingualNeural" },
    { label: "Conrad (German Male)", id: "de-DE-ConradNeural" },
    { label: "Katja (German Female)", id: "de-DE-KatjaNeural" },
  ];
  const rows = choices.map((choice) => [
    button(`${choice.id === selected ? "✅ " : ""}${choice.label}`, `set:tts:voice:${choice.id}`),
  ]);
  rows.push([button("‹ Back", "menu:tts")]);
  return { inline_keyboard: rows };
}


