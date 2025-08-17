export const DEBUG = true;

// Realtime API
export const MODEL = "gpt-4o-realtime-preview";
export const OPENAI_URL = "wss://api.openai.com/v1/realtime";

export const ALLOWED_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage", 
  "shimmer",
  "verse",
] as const;

export type VoiceName = (typeof ALLOWED_VOICES)[number];

export const DEFAULT_VOICE: VoiceName = "ash";

// Logging filters for realtime events
export const LOG_EVENT_TYPES: ReadonlyArray<string> = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];
export const SHOW_TIMING_MATH = false;

// Rate limiting
export const RL_HTTP_CAPACITY = 60; // 60 requests
export const RL_HTTP_INTERVAL_MS = 60_000; // per minute
export const RL_WS_CAPACITY = 10; // 10 upgrades
export const RL_WS_INTERVAL_MS = 60_000; // per minute
export const RL_TWILIO_CONVO_CAPACITY = 12; // 12 convo events
export const RL_TWILIO_CONVO_INTERVAL_MS = 30_000; // per 30s

// Time limits
export const TIME_LIMIT_MS = 15 * 1000; // 10 * 60 * 1000; // 10 minutes hard cap
export const FINAL_TIME_LIMIT_MESSAGE =
  "Call time limit reached, please call again to continue chatting. Good bye.";

// Twilio endpoints and configuration
export const TWILIO_CONV_BASE = "https://conversations.twilio.com/v1";
export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
export const BOT_IDENTITY = "gateframes-bot";
export const PROJECTED_ADDRESS = "+14082605145"; // must be in your Messaging Service sender pool
export const TWILIO_NUMBER = PROJECTED_ADDRESS;
export const CONVO_CONTEXT_LIMIT = 20; // number of recent messages to include for nonstream context

// CORS allowlist for client websocket upgrades
export const ALLOWED_ORIGINS = [
  "https://www.gateframes.com",
  "https://gateframes.com",
  "https://www.ricslist.com",
  "https://ricslist.com",
  "http://localhost:5173",
] as const;

export function isAllowedOrigin(origin: string | null): boolean {
  // Keep logging to match existing behavior
  console.log(origin);
  if (!origin) return false;

  if (ALLOWED_ORIGINS.includes(origin as (typeof ALLOWED_ORIGINS)[number])) {
    return true;
  }

  if (origin.startsWith("http://localhost:")) {
    const port = origin.split(":")[2];
    return !isNaN(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535;
  }

  return false;
}


