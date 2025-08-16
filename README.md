# Racky Relay Server

Cloudflare Worker that:
- Bridges client WebSocket to OpenAI Realtime API.
- Bridges Twilio Media Streams to OpenAI Realtime (voice assistant, voicemail mode, barge-in).
- Handles Twilio Conversations webhooks for SMS group chats and command helpers.
- Enforces short‑lived auth tokens and origin checks.
- Applies simple in‑memory rate limits.

### Features
- Client WS relay: validates short‑lived AES‑GCM token (origin "client") via `/token/<b64url>`, `/auth/<b64url>`, or `?auth=` before opening relay.
- Twilio WS bridge: detects Twilio via `mode=twilio` or headers; bypasses Origin checks; configures session with `g711_ulaw`, server VAD, voice (default `ash`), text+audio.
  - Uses custom params: `amd` (voicemail detection) and `direction` (`inbound`/`outbound`) to tailor the initial prompt.
  - Voicemail mode: send short voicemail then end the stream.
  - Barge‑in: truncates assistant audio when caller speaks.
- Twilio Conversations webhook (`/twilio/convo`):
  - Ensures bot participant `gateframes-bot` with projected address `+14082605145`.
  - `@call 4155550000, ...`: places outbound calls via Twilio Voice to `https://www.gateframes.com/api/twilio/voice`.
  - `@group 4155550000, ...`: creates a new group with author + numbers and seeds an intro.
  - Group gating: in multi‑party chats, the bot replies only if `@ai` is present.
  - AI reply generated directly via OpenAI API (no HTTP round-trip).
  - Dedupe by `MessageSid` or `ConversationSid:MessageIndex` for ~10 minutes.
- Origin allowlist for non‑Twilio WS: `https://www.gateframes.com`, `https://gateframes.com`, `https://www.ricslist.com`, `https://ricslist.com`, and any `http://localhost:<port>`.

### Rate limits (in‑memory, per‑instance)
- Realtime connections end politely after 10 minutes.
- HTTP (per IP): **60 requests / minute** → `429` with `Retry-After`.
- WebSocket upgrades, non‑Twilio (per IP): **10 / minute** → `429` with `Retry-After`.
- Twilio Conversations (per conversation): **12 events / 30s** → silently ignored (returns `200 ok`).
Notes: simple token bucket stored in `globalThis`; ephemeral across deploys/instances; periodic pruning to avoid growth.

### Endpoints & behavior
- WebSocket (client relay): upgrade to WS on any path; requires valid token and allowed Origin.
- WebSocket (Twilio bridge): `?mode=twilio` (or Twilio headers) connects to the bridge; Origin not required.
- HTTP:
  - `POST /twilio/convo` — Twilio Conversations webhook.
  - `/token/<b64url>` or `/auth/<b64url>` — HTTP `200 OK` (useful for health pings); tokens are enforced only on WS upgrades.
  - Others: `426 Expected Upgrade` if not a WS.

### Configuration
Env vars (set as Wrangler secrets where applicable):
```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
```
Other constants (edit in `src/index.ts` if needed): model (`gpt-4o-realtime-preview`), allowed voices, bot identity, projected address, allowed origins.

### Develop locally
Run the worker and connect your client:
- `npm start` → connect to `ws://localhost:8787` (client WS) or `ws://localhost:8787/?mode=twilio` (Twilio bridge).

### Deploy to production
`npm run deploy`, then connect to `wss://<worker>.<account>.workers.dev` (or your routed domain as configured in `wrangler.toml`).
