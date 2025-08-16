import { BOT_IDENTITY, CONVO_CONTEXT_LIMIT } from "../config/config";
import type { Env } from "../config/env";
import { generateTextDirect } from "../openai/text";
import { cleanseGroupMentions, createConversationWithParticipants, ensureBotParticipant, fetchConversationHistoryAsUiMessages, parseCallNumbers, parseGroupNumbers, placeOutboundCalls, sanitizeUsNumber, twilioGet, twilioPost, UiMessage } from "../twilio/helpers";
import { owrLog } from "../utils/log";

export const BRAND_NAME = 'GateFrames.com';

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