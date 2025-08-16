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


