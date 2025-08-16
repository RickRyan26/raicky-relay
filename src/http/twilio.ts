import type { Env } from "../config/env";
import { generateRelayAuthToken } from "../tokens/relay";
import { buildTwimlConnectStream } from "../utils/xml";

export async function handleTwilioVoiceWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = await generateRelayAuthToken(env, "twilio");
  const wssOrigin = `wss://${url.host}`;
  let relayUrl = `${wssOrigin}/token/${token}?mode=twilio`;

  let answeredBy: string | null = null;
  let direction: "inbound" | "outbound" | "unknown" = "unknown";
  if (request.method === "POST") {
    try {
      const form = await request.formData();
      const ab = form.get("AnsweredBy");
      answeredBy = typeof ab === "string" ? ab.toLowerCase() : null;
      const from =
        typeof form.get("From") === "string"
          ? (form.get("From") as string)
          : "";
      const to =
        typeof form.get("To") === "string" ? (form.get("To") as string) : "";
      if (from === "+14082605145") direction = "outbound";
      else if (to === "+14082605145") direction = "inbound";
    } catch {
      answeredBy = null;
    }
  } else {
    const answeredByParam = url.searchParams.get("AnsweredBy");
    answeredBy = answeredByParam ? answeredByParam.toLowerCase() : null;
    const dirParam = url.searchParams.get("direction");
    direction =
      dirParam === "outbound"
        ? "outbound"
        : dirParam === "inbound"
        ? "inbound"
        : "unknown";
  }

  const amdValue = answeredBy ?? "unknown";
  relayUrl += `&direction=${direction}`;
  const twiml = buildTwimlConnectStream(relayUrl, { amd: amdValue });

  return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
}
