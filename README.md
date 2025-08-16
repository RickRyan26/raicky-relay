# Raicky Relay Server

Cloudflare Worker for GateFrames that:
- Bridges client WebSocket to OpenAI Realtime (voice assistant, voicemail mode, barge‑in)
- Bridges Twilio Media Streams (voice) to OpenAI Realtime
- Handles Twilio Conversations webhooks for SMS (1:1 + Group MMS) and helper commands
- Enforces short‑lived auth tokens, origin checks, and simple rate limits

## Features
- WS relay (client): validates short‑lived AES‑GCM token via `/token/<b64url>`, `/auth/<b64url>`, or `?auth=` before upgrading
- Twilio WS bridge (voice): `?mode=twilio` connects; configures `g711_ulaw`, server VAD, voice; voicemail mode ends after a short message; barge‑in truncates audio
- Conversations webhook (`POST /twilio/convo`):
  - Ensures bot participant `gateframes-bot` with projected `+14082605145`
  - `@ai …`: replies in groups only when mentioned; 1:1 always replies
  - `@call 4155550000 …`: places outbound calls and acknowledges
  - `@group 4155550000 …`: creates a new group with the author + numbers and seeds an intro
  - Uses Twilio conversation history for model context (remembers prior turns)
  - Idempotency: drops duplicates by `MessageSid` or `ConversationSid:MessageIndex`
- Origin allowlist for non‑Twilio WS: GateFrames domains and localhost
- In‑memory rate limits (per IP / per conversation)

## Endpoints
- `POST /twilio/convo` — Twilio Conversations post‑webhook (enable onMessageAdded + onConversationStateUpdated)
- `GET|POST /twilio/voice` — Twilio Voice webhook; returns TwiML with a wss:// Stream to this Worker
- `WS anypath?mode=twilio` — Twilio media stream bridge (no Origin required)
- Client WS relay on any other upgrade path (requires short‑lived token and allowed Origin)

## Configuration
Set secrets:
```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
# optional: chat model (defaults to your choice in code)
npx wrangler secret put OPENAI_CHAT_MODEL
```
Twilio webhook URLs (POST):
- Conversations Service + Address Post‑Event URL: `https://<your-worker>.workers.dev/twilio/convo`
  - Filters: onMessageAdded, onConversationStateUpdated
- Voice webhook: `https://<your-worker>.workers.dev/twilio/voice` (TwiML responds with `wss://<your-worker>/token/<token>?mode=twilio`)

## Models & prompts
- Chat (SMS): uses OpenAI Chat Completions with your configured model (e.g., `gpt-5`)
- Realtime (voice): model & voice set in `src/config/config.ts` (default realtime: `gpt-4o-realtime-preview`)
- Prompts enforce identity and voicemail rules (every response begins with: “This is the GateFrames A.I. assistant.”)

## Notes
- Group MMS requires US/CA +1 long codes; iMessage must be off; Android group MMS on (Twilio canonicalizes identical participant sets)
- A2P 10DLC registration is required for SMS delivery at scale
- Webhooks must return 2xx quickly (we ack immediately and process async)

## Develop & Deploy
- Dev: `npm start` → `ws://localhost:8787`
- Deploy: `npm run deploy` → `wss://<worker>.<account>.workers.dev`
