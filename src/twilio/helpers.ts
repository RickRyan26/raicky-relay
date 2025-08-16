import type { Env } from "../config/env";
import { BOT_IDENTITY, CONVO_CONTEXT_LIMIT, PROJECTED_ADDRESS, TWILIO_API_BASE, TWILIO_CONV_BASE } from "../config/config";
import { owrError, owrLog } from "../utils/log";

export function twilioAuthHeader(env: Env): string {
  const token = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  return `Basic ${token}`;
}

export async function twilioGet(env: Env, path: string): Promise<Response> {
  return fetch(`${TWILIO_CONV_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: twilioAuthHeader(env),
      Accept: "application/json",
    },
  });
}

export async function twilioPost(env: Env, path: string, body: URLSearchParams): Promise<Response> {
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

export async function ensureBotParticipant(env: Env, conversationSid: string): Promise<void> {
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

export function sanitizeUsNumber(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

export function parseCallNumbers(text: string): string[] {
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

export function parseGroupNumbers(text: string): string[] {
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

export async function placeOutboundCalls(env: Env, e164Targets: string[], voiceUrl: string): Promise<string[]> {
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

export async function createConversationWithParticipants(
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
    for (const e164 of addressesE164) {
      await twilioPost(env, `/Conversations/${ch}/Participants`, new URLSearchParams({ 'MessagingBinding.Address': e164 })).catch(() => {});
    }
    await ensureBotParticipant(env, ch);
    await twilioPost(env, `/Conversations/${ch}/Messages`, new URLSearchParams({ Author: BOT_IDENTITY, Body: `Hi! I’m the "Gate Frames" AI assistant—happy to help here. Mention @ai when you want me to jump in.` }));
    return ch;
  } catch {
    return null;
  }
}

export type UiMessageRole = "system" | "user" | "assistant";
export type UiMessagePartText = { type: "text"; text: string };
export type UiMessage = { id: string; role: UiMessageRole; parts: UiMessagePartText[] };

export function cleanseGroupMentions(text: string): string {
  return text.replace(/(^|\s)@ai(\b|:)?/gi, " ").replace(/\s+/g, " ").trim();
}

export function mapTwilioToUiMessage(
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

export async function fetchConversationHistoryAsUiMessages(
  env: Env,
  conversationSid: string,
  opts: { isGroup: boolean; limit: number }
): Promise<UiMessage[]> {
  try {
    const res = await twilioGet(env, `/Conversations/${conversationSid}/Messages?PageSize=${opts.limit}`);
    const json = (await res.json()) as { messages?: Array<{ author?: string; body?: string; index?: number; sid?: string }> };
    const raw = (json.messages || []);
    raw.reverse();
    const out: UiMessage[] = [];
    for (const m of raw) {
      const mapped = mapTwilioToUiMessage(m, { isGroup: opts.isGroup });
      if (mapped) out.push(mapped);
    }
    return out;
  } catch (e) {
    owrError("[/convo] failed to load history", e);
    return [];
  }
}


