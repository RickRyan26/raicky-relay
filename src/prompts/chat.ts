import { BOT_IDENTITY, CONVO_CONTEXT_LIMIT } from "../config/config";
import type { Env } from "../config/env";
import { generateTextDirect } from "../openai/text";
import { cleanseGroupMentions, createConversationWithParticipants, ensureBotParticipant, fetchConversationHistoryAsUiMessages, parseCallNumbers, parseGroupNumbers, placeOutboundCalls, sanitizeUsNumber, twilioGet, twilioPost, UiMessage } from "../twilio/helpers";
import { owrLog } from "../utils/log";

const BRAND_NAME = 'GateFrames.com';

export function buildInitialCallGreeting(options: { voicemailMode: boolean; callDirection: 'inbound' | 'outbound' | 'unknown' }): string {
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

export function externalChatPrompt(currentIsoTimestamp: string): string {
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

export function realtimeConcatPrompt(basePrompt: string): string {
  return `Speak fast. ${basePrompt}`.trim();
}

export async function handleTwilioConversationsWebhook(
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

        const callTargets = parseCallNumbers(body);
        if (callTargets.length > 0) {
          const e164Targets = callTargets.map((ten) => `+1${ten}`);
          const origin = new URL(request.url).origin;
          const voiceUrl = `${origin}/twilio/voice`;
          const started = await placeOutboundCalls(env, e164Targets, voiceUrl);
          const humanList = e164Targets.join(", ");
          const ack = started.length > 0 ? `Calling ${humanList} now!` : `Sorry, I couldn't call ${humanList}`;
          await ensureBotParticipant(env, conversationSid);
          await twilioPost(env, `/Conversations/${conversationSid}/Messages`, new URLSearchParams({ Author: BOT_IDENTITY, Body: ack }));
          return;
        }

        const groupTargets = parseGroupNumbers(body);
        if (groupTargets.length > 0) {
          const authorE164 = author.startsWith('+1') ? author : (author.startsWith('+') ? author : `+1${sanitizeUsNumber(author) || ''}`);
          const othersE164 = groupTargets.map((ten) => `+1${ten}`);
          const all = [authorE164, ...othersE164].filter(Boolean) as string[];
          const ch = await createConversationWithParticipants(env, all, `GF Group ${new Date().toISOString()}`);
          const ack = ch ? `I created a new group and sent an intro message. You should see it as a new thread.` : `Sorry, I couldn't create the group.`;
          await ensureBotParticipant(env, conversationSid);
          await twilioPost(env, `/Conversations/${conversationSid}/Messages`, new URLSearchParams({ Author: BOT_IDENTITY, Body: ack }));
          return;
        }

        let isGroup = false;
        try {
          const partsRes = await twilioGet(env, `/Conversations/${conversationSid}/Participants`);
          const parts = (await partsRes.json()) as { participants?: Array<{ identity?: string }> };
          const nonBot = (parts.participants || []).filter((p) => ![BOT_IDENTITY, "system"].includes((p.identity || "").toLowerCase()));
          isGroup = nonBot.length >= 2;
        } catch {}
        if (isGroup && !/(^|\s)@ai(\b|\s|:)/i.test(body)) return;

        await ensureBotParticipant(env, conversationSid);

        let reply = `Sorry, I'm currently under maintenance..`;
        try {
          const history: UiMessage[] = await fetchConversationHistoryAsUiMessages(env, conversationSid, { isGroup, limit: CONVO_CONTEXT_LIMIT });
          const incomingUserTextRaw = (body || "").trim();
          const incomingUserText = (isGroup ? cleanseGroupMentions(incomingUserTextRaw) : incomingUserTextRaw).trim();

          // Build messages from actual history roles; drop duplicate latest user turn
          const messages: UiMessage[] = [];
          for (let i = 0; i < history.length; i++) {
            const m = history[i];
            const text = (m.parts?.[0]?.text || '').trim();
            if (!text) continue;
            const isLast = i === history.length - 1;
            if (isLast && m.role === 'user' && text === incomingUserText) continue;
            messages.push(m);
          }
          // Append the latest incoming user message last
          messages.push({ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: incomingUserText }] });

          const timeStamp = new Date().toISOString();
          reply = await generateTextDirect(env, messages, `You are the GateFrames AI assistant. The current date is ${timeStamp}. Reply briefly.`);
        } catch {}

        await twilioPost(env, `/Conversations/${conversationSid}/Messages`, new URLSearchParams({ Author: BOT_IDENTITY, Body: reply }));
      } catch (e) {
        try { await twilioPost(env, `/Conversations/${conversationSid}/Messages`, new URLSearchParams({ Author: BOT_IDENTITY, Body: `Sorry, I'm currently under maintenance...` })); } catch {}
      }
    })()
  );

  return resp;
}


