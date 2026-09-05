/**
 * Typed representation of every inline-keyboard callback payload the bot
 * emits. `parseCallbackAction` is the single source of truth for decoding
 * callback data; handlers never slice raw strings themselves.
 */
export type CallbackAction =
  | { kind: "noop" }
  | { kind: "menu"; menu: string; page: number }
  | { kind: "resume-page"; page: number }
  | { kind: "resume-use"; conversationId: string }
  | { kind: "usage" }
  | { kind: "credits" }
  | { kind: "context" }
  | { kind: "setdefault" }
  | { kind: "update-bot" }
  | { kind: "new-session" }
  | { kind: "cancel" }
  | { kind: "cli"; command: string }
  | { kind: "toggle"; option: string }
  | { kind: "set"; key: string; value: string };

const RESUME_PAGE_PREFIX = "resume:page:";
const RESUME_USE_PREFIX = "resume:use:";

export function parseCallbackAction(data: string): CallbackAction | null {
  if (data === "noop") return { kind: "noop" };
  if (data.startsWith("menu:")) {
    const parts = data.split(":");
    return { kind: "menu", menu: parts[1], page: parts[2] ? Number(parts[2]) : 0 };
  }
  if (data.startsWith(RESUME_PAGE_PREFIX)) {
    return { kind: "resume-page", page: Number(data.slice(RESUME_PAGE_PREFIX.length)) || 0 };
  }
  if (data.startsWith(RESUME_USE_PREFIX)) {
    return { kind: "resume-use", conversationId: data.slice(RESUME_USE_PREFIX.length).trim() };
  }
  if (data === "action:usage") return { kind: "usage" };
  if (data === "action:credits") return { kind: "credits" };
  if (data === "action:context") return { kind: "context" };
  if (data === "action:setdefault") return { kind: "setdefault" };
  if (data === "action:update_bot") return { kind: "update-bot" };
  if (data === "action:new") return { kind: "new-session" };
  if (data === "action:cancel") return { kind: "cancel" };
  if (data.startsWith("cli:")) return { kind: "cli", command: data.slice("cli:".length) };
  if (data.startsWith("toggle:")) return { kind: "toggle", option: data.slice("toggle:".length) };
  if (data.startsWith("set:")) {
    const parts = data.slice("set:".length).split(":");
    const value = parts.pop() ?? "";
    const key = parts.join(":");
    return { kind: "set", key, value };
  }
  return null;
}

/** Serializes an action back to its wire format (used by keyboards and tests). */
export function serializeCallbackData(action: CallbackAction): string {
  switch (action.kind) {
    case "noop": return "noop";
    case "menu": return action.page ? `menu:${action.menu}:${action.page}` : `menu:${action.menu}`;
    case "resume-page": return `${RESUME_PAGE_PREFIX}${action.page}`;
    case "resume-use": return `${RESUME_USE_PREFIX}${action.conversationId}`;
    case "usage": return "action:usage";
    case "credits": return "action:credits";
    case "context": return "action:context";
    case "setdefault": return "action:setdefault";
    case "update-bot": return "action:update_bot";
    case "new-session": return "action:new";
    case "cancel": return "action:cancel";
    case "cli": return `cli:${action.command}`;
    case "toggle": return `toggle:${action.option}`;
    case "set": return `set:${action.key}:${action.value}`;
  }
}
