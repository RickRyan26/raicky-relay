import { BOT_IDENTITY, CONVO_CONTEXT_LIMIT } from "../config/config";
import type { Env } from "../config/env";
import { generateTextDirect } from "../openai/text";
import { chatPrompt, textConcatPrompt } from "../prompts/chat";
import {
  cleanseGroupMentions,
  createConversationWithParticipants,
  ensureBotParticipant,
  fetchConversationHistoryAsUiMessages,
  parseCallNumbers,
  parseGroupNumbers,
  placeOutboundCalls,
  sanitizeUsNumber,
  twilioGet,
  twilioPost,
  UiMessage,
} from "../twilio/helpers";
import { rackyLog } from "../utils/log";
import { rateLimitConsume } from "../utils/rateLimiter";
import { RL_TWILIO_CONVO_CAPACITY, RL_TWILIO_CONVO_INTERVAL_MS } from "../config/config";

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
  let body =
    (form.get("Body") as string | null) ||
    (form.get("MessageBody") as string | null) ||
    "";

  rackyLog("[/twilio/convo]", {
    eventType,
    conversationSid,
    author,
    hasBody: Boolean(body),
  });

  const resp = new Response("ok", { status: 200 });

  const now = Date.now();
  // @ts-expect-error
  globalThis.__processed ||= new Map<string, number>();
  // @ts-expect-error
  const processed: Map<string, number> = globalThis.__processed;
  for (const [k, ts] of processed) {
    if (now - ts > 10 * 60 * 1000) processed.delete(k);
  }
  const dedupeKey =
    messageSid ||
    (conversationSid && messageIndex
      ? `${conversationSid}:${messageIndex}`
      : null);

  ctx.waitUntil(
    (async () => {
      try {
        if (!conversationSid) return;
        if (
          eventType !== "onMessageAdded" &&
          eventType !== "onConversationStateUpdated"
        )
          return;

        // Per-conversation rate limiting to protect against bursts/loops
        const bucketKey = `twilio-convo:${conversationSid}`;
        const rl = await rateLimitConsume(env, bucketKey, RL_TWILIO_CONVO_CAPACITY, RL_TWILIO_CONVO_INTERVAL_MS);
        if (!rl.allowed) {
          rackyLog("[/twilio/convo][429] rate limited", { conversationSid, retryMs: rl.retryAfterMs });
          return;
        }

        if (eventType === "onConversationStateUpdated") {
          try {
            const msgRes = await twilioGet(
              env,
              `/Conversations/${conversationSid}/Messages?Order=desc&PageSize=1`
            );
            const msgJson = (await msgRes.json()) as {
              messages?: Array<{
                author?: string;
                body?: string;
                index?: number;
                sid?: string;
              }>;
            };
            const latest = (msgJson.messages || [])[0];
            if (latest) {
              author = (latest.author || "").toLowerCase();
              body = latest.body || "";
            }
          } catch {}
        }

        if (!body) return;
        if (author === BOT_IDENTITY || author === "system") return;

        if (dedupeKey && processed.has(dedupeKey)) {
          rackyLog("[dedupe] already processed", dedupeKey);
          return;
        }
        if (dedupeKey) processed.set(dedupeKey, now);

        const callTargets = parseCallNumbers(body);
        if (callTargets.length > 0) {
          const e164Targets = callTargets.map((ten) => `+1${ten}`);
          const origin = new URL(request.url).origin;
          const voiceUrl = `${origin}/twilio/voice`;
          
          // Use fast mode for immediate AI response with sensitive voicemail detection
          // To completely disable AMD: set fastMode = false and modify helpers.ts
          const fastMode = true;
          const started = await placeOutboundCalls(env, e164Targets, voiceUrl, fastMode);
          
          const humanList = e164Targets.join(", ");
          const ack =
            started.length > 0
              ? `Calling ${humanList} now with ultra-fast mode!`
              : `Sorry, I couldn't call ${humanList}`;
          await ensureBotParticipant(env, conversationSid);
          await twilioPost(
            env,
            `/Conversations/${conversationSid}/Messages`,
            new URLSearchParams({ Author: BOT_IDENTITY, Body: ack })
          );
          return;
        }

        const groupTargets = parseGroupNumbers(body);
        if (groupTargets.length > 0) {
          const authorE164 = author.startsWith("+1")
            ? author
            : author.startsWith("+")
            ? author
            : `+1${sanitizeUsNumber(author) || ""}`;
          const othersE164 = groupTargets.map((ten) => `+1${ten}`);
          const all = [authorE164, ...othersE164].filter(Boolean) as string[];
          const ch = await createConversationWithParticipants(
            env,
            all,
            `GF Group ${new Date().toISOString()}`
          );
          const ack = ch
            ? `I created a new group and sent an intro message. You should see it as a new thread.`
            : `Sorry, I couldn't create the group.`;
          await ensureBotParticipant(env, conversationSid);
          await twilioPost(
            env,
            `/Conversations/${conversationSid}/Messages`,
            new URLSearchParams({ Author: BOT_IDENTITY, Body: ack })
          );
          return;
        }

        let isGroup = false;
        try {
          const partsRes = await twilioGet(
            env,
            `/Conversations/${conversationSid}/Participants`
          );
          const parts = (await partsRes.json()) as {
            participants?: Array<{ identity?: string }>;
          };
          const nonBot = (parts.participants || []).filter(
            (p) =>
              ![BOT_IDENTITY, "system"].includes(
                (p.identity || "").toLowerCase()
              )
          );
          isGroup = nonBot.length >= 2;
        } catch {}
        if (isGroup && !/(^|\s)@ai(\b|\s|:)/i.test(body)) return;

        await ensureBotParticipant(env, conversationSid);

        let reply = `Sorry, I'm currently under maintenance..`;
        try {
          const history: UiMessage[] =
            await fetchConversationHistoryAsUiMessages(env, conversationSid, {
              isGroup,
              limit: CONVO_CONTEXT_LIMIT,
            });
          const incomingUserTextRaw = (body || "").trim();
          const incomingUserText = (
            isGroup
              ? cleanseGroupMentions(incomingUserTextRaw)
              : incomingUserTextRaw
          ).trim();

          // Build messages from actual history roles; drop duplicate latest user turn
          const messages: UiMessage[] = [];
          for (let i = 0; i < history.length; i++) {
            const m = history[i];
            const text = (m.parts?.[0]?.text || "").trim();
            if (!text) continue;
            const isLast = i === history.length - 1;
            if (isLast && m.role === "user" && text === incomingUserText)
              continue;
            messages.push(m);
          }
          // Append latest user message last
          messages.push({
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: incomingUserText }],
          });

          const timeStamp = new Date().toISOString();
          reply = await generateTextDirect(
            env,
            messages,
            textConcatPrompt(chatPrompt(timeStamp))
          );
        } catch {}

        await twilioPost(
          env,
          `/Conversations/${conversationSid}/Messages`,
          new URLSearchParams({ Author: BOT_IDENTITY, Body: reply })
        );
      } catch (e) {
        try {
          await twilioPost(
            env,
            `/Conversations/${conversationSid}/Messages`,
            new URLSearchParams({
              Author: BOT_IDENTITY,
              Body: `Sorry, I'm currently under maintenance...`,
            })
          );
        } catch {}
      }
    })()
  );

  return resp;
}
