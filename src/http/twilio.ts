import type { Env } from "../config/env";
import { encodeBase64UrlUtf8 } from "../utils/base64";
import { buildTwimlConnectStream } from "../utils/xml";
import { externalChatPrompt, buildInitialCallGreeting, realtimeConcatPrompt } from "../prompts/chat";
import { generateRelayAuthToken } from "../tokens/relay";

export async function handleTwilioVoiceWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = await generateRelayAuthToken(env, 'twilio');
  const wssOrigin = `wss://${url.host}`;
  let relayUrl = `${wssOrigin}/token/${token}?mode=twilio&voice=echo`;

  let answeredBy: string | null = null;
  let direction: 'inbound' | 'outbound' | 'unknown' = 'unknown';
  if (request.method === 'POST') {
    try {
      const form = await request.formData();
      const ab = form.get('AnsweredBy');
      answeredBy = typeof ab === 'string' ? ab.toLowerCase() : null;
      const from = typeof form.get('From') === 'string' ? (form.get('From') as string) : '';
      const to = typeof form.get('To') === 'string' ? (form.get('To') as string) : '';
      if (from === '+14082605145') direction = 'outbound';
      else if (to === '+14082605145') direction = 'inbound';
    } catch {
      answeredBy = null;
    }
  } else {
    const answeredByParam = url.searchParams.get('AnsweredBy');
    answeredBy = answeredByParam ? answeredByParam.toLowerCase() : null;
    const dirParam = url.searchParams.get('direction');
    direction = dirParam === 'outbound' ? 'outbound' : dirParam === 'inbound' ? 'inbound' : 'unknown';
  }

  const amdValue = answeredBy ?? 'unknown';
  const voicemailMode = amdValue.includes('machine');

  const sysB64 = encodeBase64UrlUtf8(realtimeConcatPrompt(externalChatPrompt(new Date().toISOString())));
  const greetB64 = encodeBase64UrlUtf8(buildInitialCallGreeting({ voicemailMode, callDirection: direction }));

  const twiml = buildTwimlConnectStream(relayUrl, { amd: amdValue, direction, sys: sysB64, greet: greetB64 });

  return new Response(twiml, { headers: { 'Content-Type': 'text/xml' } });
}


