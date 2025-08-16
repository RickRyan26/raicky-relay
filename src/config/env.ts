export type Env = {
  OPENAI_API_KEY: string;
  ENCRYPTION_KEY: string; // base64-encoded AES key matching app server
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  RATE_LIMITER: DurableObjectNamespace;
};


