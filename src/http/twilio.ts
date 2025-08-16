import type { Env } from "../config/env";
import { generateRelayAuthToken } from "../tokens/relay";
import { buildTwimlConnectStream } from "../utils/xml";

export async function handleTwilioVoiceWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const webhookStartTime = Date.now();
  console.log(`[timing] Twilio webhook called at ${new Date().toISOString()}`);
  
  const url = new URL(request.url);
  const token = await generateRelayAuthToken(env, "twilio");
  const wssOrigin = `wss://${url.host}`;
  let relayUrl = `${wssOrigin}/token/${token}?mode=twilio`;

  let answeredBy: string | null = null;
  let direction: "inbound" | "outbound" | "unknown" = "unknown";
  let machineDetectionDuration: string | null = null;
  let callStatus: string | null = null;
  
  if (request.method === "POST") {
    try {
      const form = await request.formData();
      const ab = form.get("AnsweredBy");
      answeredBy = typeof ab === "string" ? ab.toLowerCase() : null;
      
      // Extract additional timing information
      machineDetectionDuration = form.get("MachineDetectionDuration") as string || null;
      callStatus = form.get("CallStatus") as string || null;
      
      const from =
        typeof form.get("From") === "string"
          ? (form.get("From") as string)
          : "";
      const to =
        typeof form.get("To") === "string" ? (form.get("To") as string) : "";
      const dirRaw = (form.get("Direction") || form.get("CallDirection") || "") as string;
      const dirLower = dirRaw.toLowerCase();
      if (dirLower.includes("outbound")) direction = "outbound";
      else if (dirLower.includes("inbound")) direction = "inbound";
      else if (from === "+14082605145") direction = "outbound";
      else if (to === "+14082605145") direction = "inbound";
    } catch {
      answeredBy = null;
    }
  } else {
    const answeredByParam = url.searchParams.get("AnsweredBy");
    answeredBy = answeredByParam ? answeredByParam.toLowerCase() : null;
    
    // Extract additional timing information from GET params
    machineDetectionDuration = url.searchParams.get("MachineDetectionDuration");
    callStatus = url.searchParams.get("CallStatus");
    
    const dirParam =
      url.searchParams.get("Direction") ||
      url.searchParams.get("CallDirection") ||
      url.searchParams.get("direction");
    const dirLower = (dirParam || "").toLowerCase();
    direction = dirLower.includes("outbound")
      ? "outbound"
      : dirLower.includes("inbound")
      ? "inbound"
      : "unknown";
  }

  const amdValue = answeredBy ?? "unknown";
  relayUrl += `&direction=${direction}`;
  // Also include AMD on the WS URL so the bridge can read it immediately
  relayUrl += `&amd=${encodeURIComponent(amdValue)}`;
  
  // Enhanced debug logging with timing information
  const webhookProcessTime = Date.now() - webhookStartTime;
  console.log(`[timing] Webhook processed in ${webhookProcessTime}ms`);
  console.log(`[twilio-webhook] AnsweredBy: "${answeredBy}", AMD value: "${amdValue}", Direction: "${direction}"`);
  
  if (machineDetectionDuration) {
    console.log(`[timing] MachineDetectionDuration: ${machineDetectionDuration}ms`);
  }
  if (callStatus) {
    console.log(`[twilio-webhook] CallStatus: "${callStatus}"`);
  }
  
  const twiml = buildTwimlConnectStream(relayUrl, { amd: amdValue, direction });

  const totalTime = Date.now() - webhookStartTime;
  console.log(`[timing] Webhook response ready in ${totalTime}ms`);
  
  return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
}
