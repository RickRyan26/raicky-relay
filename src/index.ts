import { RealtimeClient } from "@openai/realtime-api-beta";

// Prompt and branding constants
const BRAND_NAME = 'GateFrames.com';

function buildInitialCallGreeting(options: { voicemailMode: boolean; callDirection: 'inbound' | 'outbound' | 'unknown' }): string {
  const baseBrand = `Hello, this is the "${BRAND_NAME}" A.I. assistant.`;
  if (options.voicemailMode) {
    return (
      `${baseBrand} Sorry we missed you. I'm leaving a short voicemail now. ` +
      `If you have questions about "${BRAND_NAME}" driveway gates, openers, or accessories, please call back or reply to this text and I'll help right away. Have a great day!`
    );
  }
  if (options.callDirection === 'inbound') {
    return `${baseBrand} Thanks for calling! How can I help you today?`;
  }
  if (options.callDirection === 'outbound') {
    return `${baseBrand} I'm reaching out to help, what can I assist you with today?`;
  }
  return `${baseBrand} How can I help?`;
}

function externalChatPrompt(currentIsoTimestamp: string): string {
  return (
    `Voice: Be very friendly, kind, and expressive.

    Role: You are a knowledgeable specialist in high-end driveway gates, openers, and accessories.

    Objective: Understand the customer's needs, provide accurate information, and guide them to the perfect "${BRAND_NAME}" product or solution, driving sales and satisfaction.

    Strict Scope: Your knowledge is limited to "${BRAND_NAME}" products (driveway gates, fences, accessories, etc.). If asked about unrelated items or services, politely decline and steer the conversation back to "${BRAND_NAME}" offerings.

    Identity Rule (CRITICAL): At the beginning of EVERY response — including voicemails — you MUST clearly say: "This is the "${BRAND_NAME}" A.I. assistant." Do not skip this line.

    Voicemail Rule (CRITICAL): When leaving a voicemail, keep it short, identify yourself as the "${BRAND_NAME}" A.I. assistant, state that we missed them, invite a call back or text reply, and do not ask questions.

    Knowledge: ${BRAND_NAME} began from this simple promise. Design custom-sized automatic steel and wood gates and fences of the highest industry standard, deliver them directly to our fellow Americans for free, and offer enjoyable easy to follow Do-It-Yourself installation guides.

    Guidelines:
    - Ask concise clarifying questions to understand the use-case (swing vs. slide, driveway width/slope, material/style preference, opener power and power source, climate, budget, security/accessory needs).
    - Keep responses warm, upbeat, and professional; prioritize clarity over humor unless the customer invites it.
    
    The current date is ${currentIsoTimestamp}.`
  );
}

function realtimeConcatPrompt(basePrompt: string): string {
  return `Speak fast. ${basePrompt}`.trim();
}

// Direct text generation using OpenAI API (replaces nonstream endpoint)
async function generateTextDirect(
  env: Env,
  messages: UiMessage[],
  systemPrompt: string
): Promise<string> {
  try {
    // Convert UiMessage format to OpenAI API format
    const openaiMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.parts.map(part => part.text).join('')
    }));

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5',
        messages: [
          { role: 'system', content: systemPrompt },
          ...openaiMessages
        ],
        temperature: 0.8,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    return data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
  } catch (error) {
    owrError('Direct text generation failed:', error);
    return 'Sorry, I\'m currently under maintenance.';
  }
}

// TwiML generation utilities
function xmlEscapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/\"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildTwimlConnectStream(relayUrl: string, parameters?: Record<string, string>): string {
  const safeUrl = xmlEscapeAttr(relayUrl);
  const paramXml = parameters
    ? Object.entries(parameters)
        .map(
          ([name, value]) =>
            `\n\t\t\t<Parameter name="${xmlEscapeAttr(name)}" value="${xmlEscapeAttr(value)}" />`
        )
        .join('')
    : '';
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
\t<Connect>
\t\t<Stream url="${safeUrl}">${paramXml}
\t\t</Stream>
\t</Connect>
</Response>`;
}

// TODO Secure the convo endpoint:
// Set the Post-Event URL to include HTTP Basic credentials:
// Example: https://USER:PASS@openai-workers-relay.rickryan26.workers.dev/twilio/convo
// const auth = request.headers.get('Authorization') || '';
// const expected = 'Basic ' + btoa(`${env.BASIC_USER}:${env.BASIC_PASS}`);
// if (auth !== expected) {
//   return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Twilio"' } });
// }

type Env = {
  OPENAI_API_KEY: string;
  ENCRYPTION_KEY: string; // base64-encoded AES key matching app server
  // Added for Twilio Conversations webhook processing
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
};

const DEBUG = true; // set as true to see debug logs
const MODEL = "gpt-4o-realtime-preview";
const OPENAI_URL = "wss://api.openai.com/v1/realtime";

function owrLog(...args: unknown[]) {
  if (DEBUG) {
    console.log("[owr]", ...args);
  }
}

function owrError(...args: unknown[]) {
  console.error("[owr error]", ...args);
}

// Shared configuration/constants for Twilio bridging and default relay
const ALLOWED_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;
type VoiceName = (typeof ALLOWED_VOICES)[number];
const VOICE: VoiceName = "ash";
const LOG_EVENT_TYPES: ReadonlyArray<string> = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];
const SHOW_TIMING_MATH = false;

// ---- Simple in-memory rate limiter (token bucket) ----
type RateBucket = {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillPerMs: number;
};

function getClientIp(request: Request): string {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0]?.trim() || "unknown";
  return "unknown";
}

function getRateLimiter(): Map<string, RateBucket> {
  // @ts-expect-error attach ephemeral map to global
  globalThis.__rateLimiter ||= new Map<string, RateBucket>();
  // @ts-expect-error read back ephemeral map from global
  return globalThis.__rateLimiter as Map<string, RateBucket>;
}

function pruneRateLimiter(): void {
  const buckets = getRateLimiter();
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.tokens >= bucket.capacity && now - bucket.lastRefill > 5 * 60 * 1000) {
      buckets.delete(key);
    }
  }
}

function rateLimitConsume(
  key: string,
  capacity: number,
  intervalMs: number
): { allowed: boolean; retryAfterMs: number } {
  const buckets = getRateLimiter();
  const now = Date.now();
  const refillPerMs = capacity / intervalMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity - 1, lastRefill: now, capacity, refillPerMs };
    buckets.set(key, bucket);
    if (Math.random() < 0.01) pruneRateLimiter();
    return { allowed: true, retryAfterMs: 0 };
  }
  let tokens = bucket.tokens + (now - bucket.lastRefill) * bucket.refillPerMs;
  if (tokens > capacity) tokens = capacity;
  if (tokens < 1) {
    bucket.tokens = tokens;
    bucket.lastRefill = now;
    bucket.capacity = capacity;
    bucket.refillPerMs = refillPerMs;
    const retryAfterMs = Math.ceil((1 - tokens) / bucket.refillPerMs);
    if (Math.random() < 0.01) pruneRateLimiter();
    return { allowed: false, retryAfterMs };
  }
  tokens -= 1;
  bucket.tokens = tokens;
  bucket.lastRefill = now;
  bucket.capacity = capacity;
  bucket.refillPerMs = refillPerMs;
  if (Math.random() < 0.01) pruneRateLimiter();
  return { allowed: true, retryAfterMs: 0 };
}

// Reasonable defaults (tune as needed)
const RL_HTTP_CAPACITY = 60; // 60 requests
const RL_HTTP_INTERVAL_MS = 60_000; // per minute
const RL_WS_CAPACITY = 10; // 10 upgrades
const RL_WS_INTERVAL_MS = 60_000; // per minute
const RL_TWILIO_CONVO_CAPACITY = 12; // 12 convo events
const RL_TWILIO_CONVO_INTERVAL_MS = 30_000; // per 30s
const TIME_LIMIT_MS = 10 * 60 * 1000; // 10 minutes hard cap
const FINAL_TIME_LIMIT_MESSAGE =
'Call time limit reached, please call again to continue chatting. Good bye.';

// ---- Conversations webhook helpers ----
const TWILIO_CONV_BASE = "https://conversations.twilio.com/v1";
const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const BOT_IDENTITY = "gateframes-bot";
const PROJECTED_ADDRESS = "+14082605145"; // must be in your Messaging Service sender pool
const TWILIO_NUMBER = PROJECTED_ADDRESS;
const CONVO_CONTEXT_LIMIT = 20; // number of recent messages to include for nonstream context

function twilioAuthHeader(env: Env): string {
  const token = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  return `Basic ${token}`;
}

async function twilioGet(env: Env, path: string): Promise<Response> {
  return fetch(`${TWILIO_CONV_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: twilioAuthHeader(env),
      Accept: "application/json",
    },
  });
}

async function twilioPost(env: Env, path: string, body: URLSearchParams): Promise<Response> {
  return fetch(`${TWILIO_CONV_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: twilioAuthHeader(env),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
}

async function ensureBotParticipant(env: Env, conversationSid: string): Promise<void> {
  try {
    const res = await twilioGet(env, `/Conversations/${conversationSid}/Participants`);
    const data = (await res.json()) as { participants?: Array<{ identity?: string }> };
    const exists = (data.participants || []).some(
      (p) => (p.identity || "").toLowerCase() === BOT_IDENTITY
    );
    if (!exists) {
      const body = new URLSearchParams({
        Identity: BOT_IDENTITY,
        "MessagingBinding.ProjectedAddress": PROJECTED_ADDRESS,
      });
      const addRes = await twilioPost(env, `/Conversations/${conversationSid}/Participants`, body);
      if (!addRes.ok) {
        const txt = await addRes.text();
        // If group already exists with same number group, treat as success
        if (addRes.status === 409 && txt.includes('50438')) {
          owrLog('[bot] group already exists; continuing');
          return;
        }
        owrError('[bot] failed to add projected participant', txt);
      }
    }
  } catch (e) {
    owrError('[bot] ensure participant error', e);
  }
}

function sanitizeUsNumber(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

function parseCallNumbers(text: string): string[] {
  const idx = text.toLowerCase().indexOf("@call");
  if (idx < 0) return [];
  const after = text.slice(idx + 5);
  const tokens = after
    .split(/[\s,;]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const numbers: string[] = [];
  for (const token of tokens) {
    const clean = sanitizeUsNumber(token);
    if (clean) numbers.push(clean);
  }
  return numbers;
}

function parseGroupNumbers(text: string): string[] {
  const idx = text.toLowerCase().indexOf("@group");
  if (idx < 0) return [];
  const after = text.slice(idx + 6);
  const tokens = after
    .split(/[\s,;]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const numbers: string[] = [];
  for (const token of tokens) {
    const clean = sanitizeUsNumber(token);
    if (clean) numbers.push(clean);
  }
  return numbers;
}

async function placeOutboundCalls(env: Env, e164Targets: string[], voiceUrl: string): Promise<string[]> {
  const callSids: string[] = [];
  for (const e164 of e164Targets) {
    try {
      const body = new URLSearchParams({
        To: e164,
        From: PROJECTED_ADDRESS,
        Url: voiceUrl,
        Method: 'GET',
        MachineDetection: 'DetectMessageEnd'
      });
      const res = await fetch(`${TWILIO_API_BASE}/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
        method: 'POST',
        headers: { Authorization: twilioAuthHeader(env), 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (res.ok) {
        const json = (await res.json()) as { sid?: string };
        if (json.sid) callSids.push(json.sid);
      } else {
        owrError('Failed to create call', await res.text());
      }
    } catch (e) {
      owrError('Failed to start outbound call to', e164, e);
    }
  }
  return callSids;
}

async function createConversationWithParticipants(
  env: Env,
  addressesE164: string[],
  friendlyName?: string
): Promise<string | null> {
  try {
    const convRes = await fetch(`${TWILIO_CONV_BASE}/Conversations`, {
      method: 'POST',
      headers: { Authorization: twilioAuthHeader(env), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(friendlyName ? { FriendlyName: friendlyName } : {})
    });
    if (!convRes.ok) return null;
    const conv = (await convRes.json()) as { sid?: string };
    const ch = conv.sid || null;
    if (!ch) return null;
    // Add SMS participants
    for (const e164 of addressesE164) {
      await twilioPost(env, `/Conversations/${ch}/Participants`, new URLSearchParams({ 'MessagingBinding.Address': e164 })).catch(() => {});
    }
    // Add bot projected
    await ensureBotParticipant(env, ch);
    // Seed a hello message
    await twilioPost(env, `/Conversations/${ch}/Messages`, new URLSearchParams({ Author: BOT_IDENTITY, Body: `Hi! I’m the "Gate Frames" AI assistant—happy to help here. Mention @ai when you want me to jump in.` }));
    return ch;
  } catch {
    return null;
  }
}

// ---- Helpers to build nonstream chat context from Twilio history ----
type UiMessageRole = "system" | "user" | "assistant";
type UiMessagePartText = { type: "text"; text: string };
type UiMessage = { id: string; role: UiMessageRole; parts: UiMessagePartText[] };

function cleanseGroupMentions(text: string): string {
  // Remove @ai mentions and extra whitespace in group threads
  return text.replace(/(^|\s)@ai(\b|:)?/gi, " ").replace(/\s+/g, " ").trim();
}

function mapTwilioToUiMessage(
  msg: { sid?: string; author?: string; body?: string; index?: number },
  opts: { isGroup: boolean }
): UiMessage | null {
  const textRaw = (msg.body || "").trim();
  if (!textRaw) return null;
  const author = (msg.author || "").toLowerCase();
  let role: UiMessageRole = "user";
  if (author === BOT_IDENTITY) role = "assistant";
  else if (author === "system") role = "system";
  const text = opts.isGroup && role === "user" ? cleanseGroupMentions(textRaw) : textRaw;
  if (!text) return null;
  return {
    id: msg.sid || String(msg.index ?? crypto.randomUUID()),
    role,
    parts: [{ type: "text", text }],
  };
}

async function fetchConversationHistoryAsUiMessages(
  env: Env,
  conversationSid: string,
  opts: { isGroup: boolean; limit: number }
): Promise<UiMessage[]> {
  try {
    const res = await twilioGet(env, `/Conversations/${conversationSid}/Messages?PageSize=${opts.limit}`);
    const json = (await res.json()) as { messages?: Array<{ author?: string; body?: string; index?: number; sid?: string }> };
    const raw = (json.messages || []);
    // Twilio typically returns newest-first; reverse to chronological
    raw.reverse();
    const out: UiMessage[] = [];
    for (const m of raw) {
      const mapped = mapTwilioToUiMessage(m, { isGroup: opts.isGroup });
      if (mapped) out.push(mapped);
    }
    return out;
  } catch (e) {
    owrError("[convo] failed to load history", e);
    return [];
  }
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToString(b64url: string): string | null {
  try {
    const bytes = base64UrlToBytes(b64url);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function encryptAesGcm(data: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    data.buffer as ArrayBuffer
  );
  const result = new Uint8Array(16 + encrypted.byteLength + 16);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), 16);
  // Note: AES-GCM automatically appends the auth tag
  return result;
}

async function generateRelayAuthToken(env: Env, origin: "twilio" | "client"): Promise<string> {
  const now = Date.now();
  const payload = {
    iat: now,
    exp: now + 5 * 60 * 1000, // 5 minutes
    origin,
    nonce: crypto.randomUUID()
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  const keyBytes = base64ToBytes(env.ENCRYPTION_KEY);
  const encrypted = await encryptAesGcm(jsonBytes, keyBytes);
  
  // Convert to base64url
  const b64 = btoa(String.fromCharCode(...encrypted));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function decryptAesGcm(data: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  if (data.length < 33) throw new Error("invalid data");
  const iv = data.slice(0, 16);
  const authTag = data.slice(data.length - 16);
  const ciphertext = data.slice(16, data.length - 16);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    combined.buffer as ArrayBuffer
  );
  return new Uint8Array(plain);
}

async function handleTwilioVoiceWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  
  // Generate relay auth token and build URL with self-reference
  const token = await generateRelayAuthToken(env, 'twilio');
  let relayUrl = `${url.origin}/token/${token}?mode=twilio&voice=echo`;

  // Parse form data for POST requests or query params for GET
  let answeredBy: string | null = null;
  let direction: 'inbound' | 'outbound' | 'unknown' = 'unknown';
  
  if (request.method === 'POST') {
    try {
      const form = await request.formData();
      const ab = form.get('AnsweredBy');
      answeredBy = typeof ab === 'string' ? ab.toLowerCase() : null;
      const from = typeof form.get('From') === 'string' ? (form.get('From') as string) : '';
      const to = typeof form.get('To') === 'string' ? (form.get('To') as string) : '';
      if (from === TWILIO_NUMBER) direction = 'outbound';
      else if (to === TWILIO_NUMBER) direction = 'inbound';
    } catch {
      answeredBy = null;
    }
  } else {
    // GET request - check query params
    const answeredByParam = url.searchParams.get('AnsweredBy');
    answeredBy = answeredByParam ? answeredByParam.toLowerCase() : null;
    const dirParam = url.searchParams.get('direction');
    direction = dirParam === 'outbound' ? 'outbound' : dirParam === 'inbound' ? 'inbound' : 'unknown';
  }

  // Prepare TwiML parameters
  const amdValue = answeredBy ?? 'unknown';
  const voicemailMode = amdValue.includes('machine');
  
  // Encode system prompt and greeting as base64url
  const sysB64 = btoa(realtimeConcatPrompt(externalChatPrompt(new Date().toISOString())))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  const greetB64 = btoa(buildInitialCallGreeting({ voicemailMode, callDirection: direction }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const twiml = buildTwimlConnectStream(relayUrl, {
    amd: amdValue,
    direction,
    sys: sysB64,
    greet: greetB64
  });

  return new Response(twiml, { 
    headers: { 'Content-Type': 'text/xml' } 
  });
}

async function handleTwilioConversationsWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const form = await request.formData();
  const eventType = (form.get("EventType") as string | null) || "";
  const conversationSid = (form.get("ConversationSid") as string | null) || "";
  const messageSid = (form.get("MessageSid") as string | null) || null;
  const messageIndex = (form.get("MessageIndex") as string | null) || null;
  let author = ((form.get("Author") as string | null) || "").toLowerCase();
  let body = (form.get("Body") as string | null) || (form.get("MessageBody") as string | null) || "";

  owrLog("[/twilio/convo]", { eventType, conversationSid, author, hasBody: Boolean(body) });

  const resp = new Response("ok", { status: 200 });

  // Per-conversation rate limit to avoid runaway loops
  const convoKey = conversationSid || (author ? `author:${author}` : "unknown");
  const rl = rateLimitConsume(`twilio-convo:${convoKey}`, RL_TWILIO_CONVO_CAPACITY, RL_TWILIO_CONVO_INTERVAL_MS);
  if (!rl.allowed) {
    owrLog("[/twilio/convo] rate limited", { key: convoKey, retryAfterMs: rl.retryAfterMs });
    return resp;
  }

  const now = Date.now();
  // @ts-expect-error
  globalThis.__processed ||= new Map<string, number>();
  // @ts-expect-error
  const processed: Map<string, number> = globalThis.__processed;
  for (const [k, ts] of processed) {
    if (now - ts > 10 * 60 * 1000) processed.delete(k);
  }
  const dedupeKey = messageSid || (conversationSid && messageIndex ? `${conversationSid}:${messageIndex}` : null);

  ctx.waitUntil(
    (async () => {
      try {
        if (!conversationSid) return;
        if (eventType !== "onMessageAdded" && eventType !== "onConversationStateUpdated") return;

        if (eventType === 'onConversationStateUpdated') {
          try {
            const msgRes = await twilioGet(env, `/Conversations/${conversationSid}/Messages?PageSize=1`);
            const msgJson = (await msgRes.json()) as { messages?: Array<{ author?: string; body?: string; index?: number; sid?: string }> };
            const latest = (msgJson.messages || [])[0];
            if (latest) {
              author = (latest.author || '').toLowerCase();
              body = latest.body || '';
            }
          } catch {}
        }

        if (!body) return;
        if (author === BOT_IDENTITY || author === "system") return;

        if (dedupeKey && processed.has(dedupeKey)) {
          owrLog('[dedupe] already processed', dedupeKey);
          return;
        }
        if (dedupeKey) processed.set(dedupeKey, now);

        // @call handling
        const callTargets = parseCallNumbers(body);
        if (callTargets.length > 0) {
          const e164Targets = callTargets.map((ten) => `+1${ten}`);
          const voiceUrl = `https://www.gateframes.com/api/twilio/voice`;
          const started = await placeOutboundCalls(env, e164Targets, voiceUrl);
          const humanList = e164Targets.join(", ");
          const ack = started.length > 0
            ? `Calling ${humanList} now!`
            : `Sorry, I couldn't call ${humanList}`;
          await ensureBotParticipant(env, conversationSid);
          await twilioPost(env, `/Conversations/${conversationSid}/Messages`, new URLSearchParams({ Author: BOT_IDENTITY, Body: ack }));
          return;
        }

        // @group handling: create a new group with the author and provided numbers
        const groupTargets = parseGroupNumbers(body);
        if (groupTargets.length > 0) {
          const authorE164 = author.startsWith('+1') ? author : (author.startsWith('+') ? author : `+1${sanitizeUsNumber(author) || ''}`);
          const othersE164 = groupTargets.map((ten) => `+1${ten}`);
          const all = [authorE164, ...othersE164].filter(Boolean) as string[];
          const ch = await createConversationWithParticipants(env, all, `GF Group ${new Date().toISOString()}`);
          const ack = ch
            ? `I created a new group and sent an intro message. You should see it as a new thread.`
            : `Sorry, I couldn't create the group.`;
          await twilioPost(env, `/Conversations/${conversationSid}/Messages`, new URLSearchParams({ Author: BOT_IDENTITY, Body: ack }));
          return;
        }

        // Group gating for @ai
        let isGroup = false;
        try {
          const partsRes = await twilioGet(env, `/Conversations/${conversationSid}/Participants`);
          const parts = (await partsRes.json()) as { participants?: Array<{ identity?: string }> };
          const nonBot = (parts.participants || []).filter(
            (p) => ![BOT_IDENTITY, "system"].includes((p.identity || "").toLowerCase())
          );
          isGroup = nonBot.length >= 2;
        } catch {}
        if (isGroup && !/(^|\s)@ai(\b|\s|:)/i.test(body)) return;

        await ensureBotParticipant(env, conversationSid);

        // AI reply
        let reply = `Sorry, I'm currently under maintenance..`;
        try {
          // Build conversation context from recent Twilio messages
          const history: UiMessage[] = await fetchConversationHistoryAsUiMessages(env, conversationSid, { isGroup, limit: CONVO_CONTEXT_LIMIT });
          const incomingUserTextRaw = (body || "").trim();
          const incomingUserText = (isGroup ? cleanseGroupMentions(incomingUserTextRaw) : incomingUserTextRaw).trim();

          let messages: UiMessage[] = [];
          if (history.length > 0) {
            // Convert history into a single system message (excluding the latest incoming user turn)
            const historyLines: string[] = [];
            for (let i = 0; i < history.length; i++) {
              const m = history[i];
              const text = (m.parts?.[0]?.text || "").trim();
              if (!text) continue;
              const isLast = i === history.length - 1;
              if (isLast && m.role === "user" && text === incomingUserText) {
                // Skip the most recent user turn; will be sent as the final user message
                continue;
              }
              const label = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
              historyLines.push(`${label}: ${text}`);
            }
            if (historyLines.length > 0) {
              messages.push({
                id: crypto.randomUUID(),
                role: "system",
                parts: [{ type: "text", text: `Conversation history (most recent last):\n${historyLines.join("\n")}` }],
              });
            }
          }
          // Append the latest incoming user message
          if (incomingUserText) {
            messages.push({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: incomingUserText }] });
          }
          if (messages.length === 0) {
            messages = [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: incomingUserText || "" }] }];
          }

          // Generate response directly using OpenAI API (no more HTTP round-trip)
          const timeStamp = new Date().toISOString();
          reply = await generateTextDirect(env, messages, externalChatPrompt(timeStamp));
        } catch {}

        await twilioPost(env, `/Conversations/${conversationSid}/Messages`, new URLSearchParams({ Author: BOT_IDENTITY, Body: reply }));
      } catch (e) {
        try {
          await twilioPost(env, `/Conversations/${conversationSid}/Messages`, new URLSearchParams({ Author: BOT_IDENTITY, Body: `Sorry, I'm currently under maintenance...` }));
        } catch {}
      }
    })()
  );

  return resp;
}

// Twilio Media Stream event types
type NullableString = string | null;
type TwilioBaseEvent = { event: string };
type TwilioCustomParameter = { name?: string; key?: string; value?: string };
type TwilioStartEvent = {
  event: "start";
  start?: {
    streamSid?: string | null;
    customParameters?: TwilioCustomParameter[];
    custom_parameters?: TwilioCustomParameter[];
  };
};
type TwilioMediaEvent = {
  event: "media";
  media?: { payload?: string; timestamp?: number | string };
};
type TwilioMarkEvent = { event: "mark" };
type TwilioEvent =
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioMarkEvent
  | TwilioBaseEvent;

function isMediaEvent(e: TwilioEvent): e is TwilioMediaEvent {
  return e.event === "media";
}
function isStartEvent(e: TwilioEvent): e is TwilioStartEvent {
  return e.event === "start";
}
function isMarkEvent(e: TwilioEvent): e is TwilioMarkEvent {
  return e.event === "mark";
}

async function createRealtimeClient(
  request: Request,
  env: Env,
  ctx: ExecutionContext
) {
  // Copy protocol headers (prepare response headers but delay accept until after auth)
  const responseHeaders = new Headers();
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  if (protocolHeader) {
    const requestedProtocols = protocolHeader.split(",").map((p) => p.trim());
    if (requestedProtocols.length > 0) {
      responseHeaders.set("Sec-WebSocket-Protocol", requestedProtocols[0]);
    }
  }

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    owrError(
      "Missing OpenAI API key. Did you forget to set OPENAI_API_KEY in .dev.vars (for local dev) or with wrangler secret put OPENAI_API_KEY (for production)?"
    );
    return new Response("Missing API key", { status: 401 });
  }

  // Enforce short-lived auth token for default relay clients BEFORE opening WS
  const url = new URL(request.url);
  const auth = getAuthToken(url);
  const tokenOk = await validateAuth(auth, env, "client");
  if (!tokenOk) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Create and accept the websocket only after validation succeeds
  const webSocketPair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(webSocketPair);
  serverSocket.accept();

  let realtimeClient: RealtimeClient | null = null;

  // Create RealtimeClient
  try {
    owrLog("Creating OpenAIRealtimeClient");
    realtimeClient = new RealtimeClient({
      apiKey,
      debug: DEBUG,
      url: OPENAI_URL,
    });
  } catch (e) {
    owrError("Error creating OpenAI RealtimeClient", e);
    serverSocket.close();
    return new Response("Error creating OpenAI RealtimeClient", {
      status: 500,
    });
  }

  // Enforce a hard time limit for client-side realtime sessions
  const endClientDueToTimeLimit = () => {
    try {
      serverSocket.send(
        JSON.stringify({
          type: "system.time_limit",
          message: FINAL_TIME_LIMIT_MESSAGE,
        })
      );
    } catch {}
    try {
      serverSocket.close(4000, "time_limit");
    } catch {}
    try {
      realtimeClient?.disconnect();
    } catch {}
  };
  const clientTimeLimitTimer = setTimeout(endClientDueToTimeLimit, TIME_LIMIT_MS);

  // Relay: OpenAI Realtime API Event -> Client
  realtimeClient.realtime.on("server.*", (event: { type: string }) => {
    serverSocket.send(JSON.stringify(event));
  });

  realtimeClient.realtime.on("close", (metadata: { error: boolean }) => {
    owrLog(
      `Closing server-side because I received a close event: (error: ${metadata.error})`
    );
    serverSocket.close();
  });

  // Relay: Client -> OpenAI Realtime API Event
  const messageQueue: string[] = [];
  const messageHandler = (data: string) => {
    try {
      const parsedEvent = JSON.parse(data);
      realtimeClient.realtime.send(parsedEvent.type, parsedEvent);
    } catch (e) {
      owrError("Error parsing event from client", data);
    }
  };

  serverSocket.addEventListener("message", (event: MessageEvent) => {
    const data =
      typeof event.data === "string" ? event.data : event.data.toString();
    if (!realtimeClient.isConnected()) {
      messageQueue.push(data);
    } else {
      messageHandler(data);
    }
  });

  serverSocket.addEventListener("close", ({ code, reason }) => {
    owrLog(
      `Closing server-side because the client closed the connection: ${code} ${reason}`
    );
    realtimeClient.disconnect();
    messageQueue.length = 0;
    try { clearTimeout(clientTimeLimitTimer); } catch {}
  });

  let model: string | undefined = MODEL;

  // uncomment this to use a model from specified by the client

  // const modelParam = new URL(request.url).searchParams.get("model");
  // if (modelParam) {
  //   model = modelParam;
  // }

  // Connect to OpenAI Realtime API asynchronously; respond 101 immediately
  ctx.waitUntil(
    (async () => {
      try {
        owrLog(`Connecting to OpenAI...`);
        // @ts-expect-error Waiting on https://github.com/openai/openai-realtime-api-beta/pull/52
        await realtimeClient.connect({ model });
        owrLog(`Connected to OpenAI successfully!`);
        while (messageQueue.length) {
          const message = messageQueue.shift();
          if (message) {
            messageHandler(message);
          }
        }
      } catch (e) {
        owrError("Error connecting to OpenAI", e);
        try {
          serverSocket.close(1011, "Upstream connect failure");
        } catch {}
      }
    })()
  );

  return new Response(null, {
    status: 101,
    headers: responseHeaders,
    webSocket: clientSocket,
  });
}

async function createTwilioRealtimeBridge(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const webSocketPair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(webSocketPair);

  serverSocket.accept();

  const responseHeaders = new Headers();
  // Force subprotocol to 'audio' for Twilio Media Streams
  responseHeaders.set("Sec-WebSocket-Protocol", "audio");

  const apiKey = env.OPENAI_API_KEY;
  const reqUrl = new URL(request.url);
  // Validate short-lived auth from app server
  const auth = getAuthToken(reqUrl);
  const authOk = await validateAuth(auth, env, "twilio");
  if (!authOk) {
    // Accept and close gracefully so Twilio gets a websocket closure instead of HTTP error
    try {
      serverSocket.close(1008, "Unauthorized");
    } catch {}
    return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
  }
  const voiceParam = (reqUrl.searchParams.get("voice") || "").toLowerCase();
  // sys/greet/amd now arrive via Twilio start.customParameters; set defaults here
  let systemInstructionsOverride: string | null = null;
  let initialGreetingOverride: string | null = null;
  let voicemailMode = false;
  let callDirection: 'inbound' | 'outbound' | 'unknown' = 'unknown';
  owrLog("[twilio] voicemailMode (pre-start):", voicemailMode, "direction:", callDirection);
  const selectedVoice: VoiceName = (ALLOWED_VOICES.includes(
    voiceParam as VoiceName
  )
    ? (voiceParam as VoiceName)
    : VOICE);
  if (!apiKey) {
    owrError(
      "Missing OpenAI API key. Did you forget to set OPENAI_API_KEY in .dev.vars (for local dev) or with wrangler secret put OPENAI_API_KEY (for production)?"
    );
    // Accept and then close gracefully so Twilio sees a proper websocket close
    try {
      serverSocket.close(1011, "Server misconfigured: missing API key");
    } catch {}
    return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
  }

  // Per-call connection state
  let streamSid: NullableString = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem: NullableString = null;
  let markQueue: string[] = [];
  let responseStartTimestampTwilio: number | null = null;

  // Time-limit enforcement for Twilio bridge
  let timeLimitTimer: ReturnType<typeof setTimeout> | null = null;
  let timeLimitClosing = false;
  let timeLimitCloseFallback: ReturnType<typeof setTimeout> | null = null;

  function sendFinalAndClose() {
    if (timeLimitClosing) return;
    timeLimitClosing = true;
    try {
      const item = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Please say exactly: ${FINAL_TIME_LIMIT_MESSAGE}` }]
        }
      } as const;
      realtimeClient!.realtime.send('conversation.item.create', item);
      realtimeClient!.realtime.send('response.create', { type: 'response.create' });
    } catch {}
    // Fallback: force-close after 20s if no response.done arrives
    try {
      if (timeLimitCloseFallback) clearTimeout(timeLimitCloseFallback);
      timeLimitCloseFallback = setTimeout(() => {
        try { serverSocket.close(1000, 'time_limit'); } catch {}
        try { realtimeClient?.disconnect(); } catch {}
      }, 20_000);
    } catch {}
  }

  function scheduleTimeLimit() {
    try {
      if (timeLimitTimer) clearTimeout(timeLimitTimer);
      timeLimitTimer = setTimeout(() => {
        sendFinalAndClose();
      }, TIME_LIMIT_MS);
    } catch {}
  }

  // Build OpenAI Realtime client
  let realtimeClient: RealtimeClient | null = null;
  try {
    owrLog("Creating OpenAIRealtimeClient (Twilio mode)");
    realtimeClient = new RealtimeClient({
      apiKey,
      debug: DEBUG,
      url: OPENAI_URL,
    });
  } catch (e) {
    owrError("Error creating OpenAI RealtimeClient (Twilio mode)", e);
    try {
      serverSocket.close(1011, "Upstream client init failure");
    } catch {}
    return new Response(null, { status: 101, headers: responseHeaders, webSocket: clientSocket });
  }

  function initializeSession() {
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: selectedVoice,
        instructions: systemInstructionsOverride ?? '',
        modalities: ["text", "audio"],
        temperature: 0.8,
      },
    } as const;
    realtimeClient!.realtime.send("session.update", sessionUpdate);
  }

  let initialUserMessageSent = false;
  function sendInitialConversationItem() {
    if (initialUserMessageSent) return;
    initialUserMessageSent = true;
    owrLog("[twilio] sending initial message. voicemailMode:", voicemailMode, 'direction:', callDirection);
    const initialMessage = initialGreetingOverride ?? '';
    if (!initialMessage) return;
    const initialConversationItem = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: initialMessage,
          },
        ],
      },
    } as const;
    realtimeClient!.realtime.send(
      "conversation.item.create",
      initialConversationItem
    );
    realtimeClient!.realtime.send("response.create", { type: "response.create" });
  }

  function sendMark() {
    if (!streamSid) return;
    const markEvent = {
      event: "mark",
      streamSid,
      mark: { name: "responsePart" },
    } as const;
    serverSocket.send(JSON.stringify(markEvent));
    markQueue.push("responsePart");
  }

  function handleSpeechStartedEvent() {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
      if (SHOW_TIMING_MATH) {
        console.log(
          `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
        );
      }
      if (lastAssistantItem) {
        const truncateEvent = {
          type: "conversation.item.truncate",
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime,
        } as const;
        realtimeClient!.realtime.send(
          "conversation.item.truncate",
          truncateEvent
        );
      }
      serverSocket.send(
        JSON.stringify({
          event: "clear",
          streamSid,
        })
      );
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  }

  // OpenAI -> Twilio
  realtimeClient.realtime.on("server.*", (evt: { type: string }) => {
    try {
      if (evt.type && LOG_EVENT_TYPES.includes(evt.type)) {
        owrLog(`Received event from OpenAI: ${evt.type}`);
      }
      if (
        (evt as unknown as { type?: string; delta?: string }).type ===
          "response.audio.delta" &&
        (evt as unknown as { delta?: string }).delta
      ) {
        const { delta } = evt as unknown as { delta: string };
        const audioDelta = {
          event: "media",
          streamSid,
          media: { payload: delta },
        } as const;
        serverSocket.send(JSON.stringify(audioDelta));
        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }
        const itemId = (evt as unknown as { item_id?: string }).item_id;
        if (itemId) lastAssistantItem = itemId;
        sendMark();
      }

      if (evt.type === "input_audio_buffer.speech_started") {
        if (!voicemailMode) {
          handleSpeechStartedEvent();
        }
      }

      // After the assistant finishes the first response in voicemail mode, close the stream
      if (voicemailMode && evt.type === "response.done") {
        try {
          serverSocket.close(1000, "voicemail complete");
        } catch {}
        try {
          realtimeClient?.disconnect();
        } catch {}
      }

      // If we triggered a time-limit closing, end call after the assistant finishes speaking
      if (timeLimitClosing && evt.type === 'response.done') {
        try { serverSocket.close(1000, 'time_limit'); } catch {}
        try { realtimeClient?.disconnect(); } catch {}
      }
    } catch (error) {
      owrError("Error processing OpenAI message (Twilio mode)", error);
    }
  });

  // Also support raw websocket messages from OpenAI (some SDK versions emit strings)
  // This ensures we never drop audio deltas if they arrive over ws directly
  (realtimeClient as unknown as { socket?: WebSocket }).socket?.addEventListener(
    "message",
    (event: MessageEvent) => {
      try {
        const raw = typeof event.data === "string" ? event.data : "";
        if (!raw) return;
        const response = JSON.parse(raw) as {
          type?: string;
          delta?: string;
          item_id?: string;
        };
        if (response.type && LOG_EVENT_TYPES.includes(response.type)) {
          owrLog(`OpenAI ws message: ${response.type}`);
        }
        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid,
            media: { payload: response.delta },
          } as const;
          serverSocket.send(JSON.stringify(audioDelta));
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }
          if (response.item_id) lastAssistantItem = response.item_id;
          sendMark();
        }
        if (response.type === "input_audio_buffer.speech_started") {
          if (!voicemailMode) {
            handleSpeechStartedEvent();
          }
        }
        if (voicemailMode && response.type === "response.done") {
          try { serverSocket.close(1000, "voicemail complete"); } catch {}
          try { realtimeClient?.disconnect(); } catch {}
        }
      } catch {}
    }
  );

  realtimeClient.realtime.on("close", (metadata: { error: boolean }) => {
    owrLog(
      `Closing server-side (Twilio mode) because I received a close event: (error: ${metadata.error})`
    );
    try {
      serverSocket.close();
    } catch {}
  });

  // Buffer for Twilio events until OpenAI connects
  const twilioQueue: string[] = [];

  // Twilio -> OpenAI
  serverSocket.addEventListener("message", (event: MessageEvent) => {
    try {
      const raw =
        typeof event.data === "string" ? event.data : event.data.toString();
      const twilioEvent = JSON.parse(raw) as TwilioEvent;
      if (!realtimeClient?.isConnected()) {
        twilioQueue.push(raw);
      }
      switch (twilioEvent.event) {
        case "media": {
          if (isMediaEvent(twilioEvent)) {
            latestMediaTimestamp = Number(
              twilioEvent.media?.timestamp || 0
            );
            if (realtimeClient?.isConnected()) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: twilioEvent.media?.payload,
              } as const;
              realtimeClient.realtime.send(
                "input_audio_buffer.append",
                audioAppend
              );
            }
          }
          break;
        }
        case "start": {
          if (isStartEvent(twilioEvent)) {
            streamSid = twilioEvent.start?.streamSid ?? null;
            const customParams =
              twilioEvent.start?.customParameters || twilioEvent.start?.custom_parameters || [];
            owrLog("[twilio] start.customParameters:", customParams);
            for (const p of customParams) {
              const key = (p.name || p.key || "").toLowerCase();
              const rawValue = p.value || "";
              const lowerValue = rawValue.toLowerCase();
              if (key === "amd") {
                voicemailMode = lowerValue.includes("machine");
              } else if (key === 'direction') {
                if (lowerValue === 'inbound' || lowerValue === 'outbound') callDirection = lowerValue as 'inbound' | 'outbound';
              } else if (key === 'sys') {
                const decoded = base64UrlToString(rawValue);
                if (decoded != null) {
                  systemInstructionsOverride = decoded;
                  try {
                    // Update session instructions if already connected
                    if (realtimeClient?.isConnected()) {
                      realtimeClient.realtime.send('session.update', { type: 'session.update', session: { instructions: systemInstructionsOverride } });
                    }
                  } catch {}
                }
              } else if (key === 'greet') {
                const decoded = base64UrlToString(rawValue);
                if (decoded != null) {
                  initialGreetingOverride = decoded;
                }
              }
            }
            owrLog("[twilio] computed voicemailMode after start:", voicemailMode, "direction:", callDirection);
            if (realtimeClient?.isConnected()) {
              sendInitialConversationItem();
            } else {
              // will be sent once connected
              shouldSendInitialOnConnect = true;
            }
          }
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          owrLog("Incoming Twilio stream has started", streamSid);
          scheduleTimeLimit();
          break;
        }
        case "mark": {
          if (isMarkEvent(twilioEvent)) {
            if (markQueue.length > 0) markQueue.shift();
          }
          break;
        }
        default: {
          owrLog("Received non-media Twilio event:", twilioEvent.event);
          break;
        }
      }
    } catch (error) {
      owrError("Error parsing message from Twilio (Twilio mode)", error);
    }
  });

  serverSocket.addEventListener("close", () => {
    try {
      if (realtimeClient?.isConnected()) realtimeClient.disconnect();
    } catch {}
    owrLog("Twilio client disconnected.");
    try { if (timeLimitTimer) clearTimeout(timeLimitTimer); } catch {}
    try { if (timeLimitCloseFallback) clearTimeout(timeLimitCloseFallback); } catch {}
  });

  let shouldSendInitialOnConnect = false;
  // Connect to OpenAI and initialize session
  ctx.waitUntil(
    (async () => {
      try {
        owrLog(`Connecting to OpenAI (Twilio mode)...`);
        // @ts-expect-error Waiting on https://github.com/openai/openai-realtime-api-beta/pull/52
        await realtimeClient!.connect({ model: MODEL });
        owrLog(`Connected to OpenAI successfully (Twilio mode)!`);
        initializeSession();
        if (shouldSendInitialOnConnect) {
          sendInitialConversationItem();
          shouldSendInitialOnConnect = false;
        }
        // Flush any queued Twilio media after connecting
        while (twilioQueue.length) {
          const msg = twilioQueue.shift();
          if (!msg) continue;
          try {
            const eventParsed = JSON.parse(msg) as TwilioEvent;
            if (isMediaEvent(eventParsed)) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: eventParsed.media?.payload,
              } as const;
              realtimeClient!.realtime.send(
                "input_audio_buffer.append",
                audioAppend
              );
            }
          } catch {}
        }
      } catch (e) {
        owrError("Error connecting to OpenAI (Twilio mode)", e);
        try {
          serverSocket.close(1011, "Upstream connect failure");
        } catch {}
      }
    })()
  );

  return new Response(null, {
    status: 101,
    headers: responseHeaders,
    webSocket: clientSocket,
  });
}

// export default {
//   async fetch(
//     request: Request,
//     env: Env,
//     ctx: ExecutionContext
//   ): Promise<Response> {
//     // This would be a good place to add logic for
//     // authentication, rate limiting, etc.
//     // You could also do matching on the path or other things here.
//     const upgradeHeader = request.headers.get("Upgrade");
//     if (upgradeHeader === "websocket") {
//       return createRealtimeClient(request, env, ctx);
//     }

//     return new Response("Expected Upgrade: websocket", { status: 426 });
//   },
// };
const ALLOWED_ORIGINS = [
  "https://www.gateframes.com",
  "https://gateframes.com",
  "https://www.ricslist.com",
  "https://ricslist.com",
  "http://localhost:5173",
] as const;

export function isAllowedOrigin(origin: string | null): boolean {

  console.log(origin)
  if (!origin) return false;

  // Check exact matches first
  if (ALLOWED_ORIGINS.includes(origin as (typeof ALLOWED_ORIGINS)[number])) {
    return true;
  }

  // Check for development environments
  if (origin.startsWith("http://localhost:")) {
    const port = origin.split(":")[2];
    return (
      !isNaN(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535
    );
  }

  return false;
}

function sanitizeToken(raw: string | null): string | null {
  if (!raw) return null;
  // Strip accidental query fragments like '?model=...'
  const stopChars = ['?', '&', '#'];
  let token = raw;
  for (const ch of stopChars) {
    const idx = token.indexOf(ch);
    if (idx >= 0) token = token.slice(0, idx);
  }
  // Keep only base64url characters
  token = token.replace(/[^A-Za-z0-9_-]/g, '');
  return token.length ? token : null;
}

function getAuthToken(url: URL): string | null {
  // Prefer path /token/<b64url> or /auth/<b64url>
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && (parts[0] === 'token' || parts[0] === 'auth')) {
    return sanitizeToken(parts[1]);
  }
  return sanitizeToken(url.searchParams.get('auth'));
}

async function validateAuth(
  authParam: string | null,
  env: Env,
  expectedOrigin: "twilio" | "client"
): Promise<boolean> {
  try {
    if (!authParam) {
      owrLog("[auth] missing token");
      return false;
    }
    if (!env.ENCRYPTION_KEY) {
      owrLog("[auth] missing ENCRYPTION_KEY");
      return false;
    }
    const key = base64ToBytes(env.ENCRYPTION_KEY);
    const encrypted = base64UrlToBytes(authParam);
    const plaintext = await decryptAesGcm(encrypted, key);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as {
      iat: number;
      exp: number;
      origin: string;
      nonce: string;
    };
    const now = Date.now();
    if (decoded.exp < now) {
      owrLog("[auth] token expired", { exp: decoded.exp, now });
      return false;
    }
    if (decoded.iat > now + 30_000) {
      owrLog("[auth] token iat too far in future", { iat: decoded.iat, now });
      return false;
    }
    if (decoded.origin !== expectedOrigin) {
      owrLog("[auth] origin mismatch", { expected: expectedOrigin, got: decoded.origin });
      return false;
    }
    return true;
  } catch {
    owrLog("[auth] token decrypt/parse failed");
    return false;
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode");
    const clientIp = getClientIp(request);

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader === "websocket") {
      // Twilio Media Stream mode bypasses Origin checks (Twilio typically omits Origin)
      const userAgent = request.headers.get("User-Agent") || "";
      const hasTwilioSig = request.headers.has("x-twilio-signature");
      const looksLikeTwilio =
        mode === "twilio" ||
        hasTwilioSig ||
        userAgent.includes("Twilio.TmeWs");
      if (looksLikeTwilio) {
        return createTwilioRealtimeBridge(request, env, ctx);
      }

      // Default relay uses Origin allowlist
      const origin = request.headers.get("Origin");
      if (!isAllowedOrigin(origin)) {
        return new Response("Unauthorized origin", { status: 403 });
      }

      // Per-IP websocket upgrade rate limit (non-Twilio only)
      const rl = rateLimitConsume(`ws:${clientIp}`, RL_WS_CAPACITY, RL_WS_INTERVAL_MS);
      if (!rl.allowed) {
        const retrySec = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
        return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(retrySec) } });
      }

      return createRealtimeClient(request, env, ctx);
    }

    // HTTP endpoints
    const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    if (pathname === "/twilio/convo" && request.method === "POST") {
      return handleTwilioConversationsWebhook(request, env, ctx);
    }
    if (pathname === "/twilio/voice" && (request.method === "POST" || request.method === "GET")) {
      return handleTwilioVoiceWebhook(request, env);
    }

    // Per-IP HTTP rate limit for all other endpoints
    const httpRl = rateLimitConsume(`http:${clientIp}`, RL_HTTP_CAPACITY, RL_HTTP_INTERVAL_MS);
    if (!httpRl.allowed) {
      const retrySec = Math.max(1, Math.ceil(httpRl.retryAfterMs / 1000));
      return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(retrySec) } });
    }

    // If Twilio posts to an unexpected path, log for diagnostics
    if (request.method === 'POST' && request.headers.has('x-twilio-signature')) {
      console.log('[http] unexpected Twilio POST', { path: url.pathname });
      return new Response('ok', { status: 200 });
    }

    // Allow a simple OK on token/auth paths to avoid confusing logs/tools that ping these URLs without WS upgrade
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && (parts[0] === 'token' || parts[0] === 'auth')) {
      return new Response('OK', { status: 200 });
    }
    return new Response("Expected Upgrade: websocket", { status: 426 });
  },
};
