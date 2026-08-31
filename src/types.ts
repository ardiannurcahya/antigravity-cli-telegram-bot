export type ChatId = number | string;

export interface ModelOption { id: string; label: string; maxContextWindow?: number }
export interface TelegramUser { id: number }
export interface TelegramChat { id: number; type?: string }
export interface TelegramPhotoSize { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }
export interface TelegramDocument { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}
export interface TelegramCallbackQuery { id: string; from: TelegramUser; data?: string; message?: TelegramMessage }
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }
export interface InlineButton { text: string; callback_data: string }
export interface InlineKeyboardMarkup { inline_keyboard: InlineButton[][] }
export interface ReplyKeyboardMarkup {
  keyboard: string[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  input_field_placeholder?: string;
}
export type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup;

export interface SessionSettings {
  model: string | null;
  effort: "low" | "medium" | "high";
  mode: "plan" | "accept-edits";
  sandbox: boolean;
  agent?: string | null;
  project?: string | null;
  addDirs?: string[];
  continueSession?: boolean;
  newProject?: boolean;
  disableSlashCommands?: boolean;
  jsonSchema?: string | null;
  logFile?: string | null;
  outputFormat?: "text" | "json" | "stream-json";
  printTimeout?: string | null;
  verbose?: "silent" | "compact" | "detailed";
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface RunStats {
  model: string | null;
  usage: Usage | null;
  durationMs: number | null;
  numTurns: number | null;
  toolCalls: number;
  status: string;
  completedAt: string;
}

export interface SessionState {
  conversationId?: string;
  conversationTitle?: string;
  conversationStepCount?: number;
  conversationLastModifiedAt?: number | string;
  settings?: Partial<SessionSettings>;
  lastRun?: RunStats;
  usageTotals?: Usage | null;
  updatedAt?: string;
}

export interface ConversationSummary {
  conversation_id: string;
  display_title: string;
  step_count: number;
  last_modified_time: number | string;
  project_id?: string;
}

export interface InFlightJob {
  prompt?: string;
  kind?: "prompt" | "usage" | "credits" | "context";
  imagePath?: string;
  documentPath?: string;
  documentName?: string;
  startedAt: number;
}

export interface PersistedState {
  updateOffset: number;
  sessions: Record<string, SessionState>;
  inFlight?: Record<string, InFlightJob>;
}

export interface AgyConfig {
  bin: string;
  workspace: string;
  project: string;
  mode: "plan" | "accept-edits";
  sandbox: boolean;
  allowSandboxDisable: boolean;
  model: string;
  effort: "low" | "medium" | "high";
  allowedModels: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  agent?: string;
  allowDangerouslySkipPermissions: boolean;
  dbPath: string;
}

export interface AppConfig {
  telegram: {
    token: string;
    allowedUserIds: string[];
    allowedChatIds: string[];
    privateOnly: boolean;
    maxMessageChars: number;
    progressMode: "full" | "compact" | "delete";
    verbose: "silent" | "compact" | "detailed";
    allowBotUpdate: boolean;
    autoInterrupt: boolean;
  };
  agy: AgyConfig;
  queue: { maxSize: number };
  stateFile: string;
  tempDir: string;
  logLevel: string;
  envFile?: string;
}

export interface StreamEvent extends Record<string, unknown> {
  event?: string;
  conversation_id?: string;
  init?: Record<string, unknown>;
  step_update?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface AgyResult {
  text: string;
  parsed: StreamEvent | Record<string, unknown> | null;
  events: StreamEvent[];
  conversationId: string | null;
  model: string | null;
  usage: Usage | null;
  durationMs: number | null;
  numTurns: number | null;
  toolCalls: number;
  status: string | null;
}

export interface RunnerOptions {
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  model?: string | null;
  effort?: "low" | "medium" | "high";
  mode?: "plan" | "accept-edits";
  sandbox?: boolean;
  project?: string | null;
  outputFormat?: string;
  printTimeout?: string | null;
  agent?: string | null;
  addDirs?: string[];
  continueSession?: boolean;
  newProject?: boolean;
  disableSlashCommands?: boolean;
  jsonSchema?: string | null;
  logFile?: string | null;
  dangerouslySkipPermissions?: boolean;
  imagePath?: string;
  documentPath?: string;
  documentName?: string;
}
