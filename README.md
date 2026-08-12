# Aegis-AI

> **AI-powered emergency communication agent.**
> *Built for the Caspian Buildathon — "Build agents that can reach anyone."*

Aegis-AI monitors trusted public disaster sources, decides **who needs to know, how urgently, and what to say**, then dispatches verified alerts to subscribed users through Discord, Telegram, and email using the [Caspian SDK](https://trycaspianai.com).

---

## Why

People downstream of an earthquake, wildfire, or flash flood often learn about it from social media minutes too late. Aegis sits between authoritative feeds and the channels people already use, with the explicit goal of reaching the right person with the right urgency — not blasting everyone.

The agent answers three questions for every event:

1. **WHO** is in the affected region?
2. **HOW URGENTLY** do they need to know?
3. **WHAT** should they be told?

---

## Architecture

```
            +------------------+      +----------------+
   USGS --> |                  | ---> |                |
   NWS  --> |  Source adapters | ---> |  Normalized    | --+
            +------------------+      |  event store   |   |
                                      +----------------+   v
                                                     +----+----+
                                                     | decide  |
                                                     | (agent) |
                                                     +----+----+
                                                          |
                                                          v
   +-------------+        +----------------+      +------+------+
   |  User store | <----- | Alert composer | <--- | Urgency +   |
   +-------------+        +----------------+      | audience    |
                                                  +------+------+
                                                         |
                                              +----------+----------+
                                              | Caspian Comm Client |
                                              +----+----+-----------+
                                                   |    |
                                       email  -----     ---- discord / telegram
```

* **Sources**: USGS earthquake feed, NWS active alerts (extensible).
* **Decide** (`src/agent/decide.ts`): verify → severity → audience → urgency → compose.
* **Store**: `sql.js` (pure-JS SQLite) — no native build required.
* **Comm**: `CaspianCommProvider` wraps the verified `caspian-sdk` surface only.

---

## Prerequisites

- Node.js 18+
- A Caspian API key (`CASPIAN_API_KEY`)
- Optional: Discord bot token, Telegram bot token, OpenAI API key

---

## Setup

```bash
npm install
cp .env.example .env
# fill in CASPIAN_API_KEY (and any optional tokens)
```

`.env.example` documents every supported variable, including defaults for the data sources (`USGS_FEED_URL`, `NWS_API_BASE`), polling cadence (`POLL_INTERVAL_SEC`, `DEDUP_WINDOW_MIN`), and database path (`AEGIS_DB_PATH`).

---

## Scripts

| Script              | What it does                                  |
|---------------------|-----------------------------------------------|
| `npm run dev`       | Run with `tsx` in watch mode                  |
| `npm start`         | Run the compiled `dist/index.js`              |
| `npm run build`     | Compile TypeScript to `dist/`                 |
| `npm run typecheck` | Type-check only (`tsc --noEmit`)              |
| `npm test`          | Run the Vitest suite                          |
| `npm run test:watch`| Vitest in watch mode                          |

---

## Project layout

```
src/
├── agent/decide.ts          # Verify → audience → urgency → compose
├── adapters/
│   ├── caspianCommProvider.ts  # Verified Caspian SDK wrapper
│   ├── usgsSource.ts           # USGS earthquake feed
│   └── nwsSource.ts            # NWS active alerts
├── services/                # Interfaces (DisasterSource, CommProvider, LlmProvider)
├── store/                   # sql.js + CRUD modules (users, events, alerts)
├── types/                   # Zod schemas for NormalizedEvent, User, Alert
├── config.ts                # Env loading + feature flags
├── logger.ts                # pino root + child loggers
├── entrypoint.ts            # buildApp / runOnce / runScheduler (testable)
└── index.ts                 # Process entry: signal handling + main loop
```

---

## MVP features

- Pull USGS earthquakes (all-day feed) and NWS active alerts.
- Normalize + dedupe by stable `(source, externalId)` hash.
- Match subscribed users within the event's radius.
- Compose a short alert (template or LLM if `OPENAI_API_KEY` is set).
- Dispatch via Caspian SDK to email / Discord / Telegram.
- Persist alerts + status transitions in SQLite.

---

## Stretch features (post-hackathon)

- More sources: GDACS, ReliefWeb, NOAA tsunamis, EU Copernicus.
- Geo-fence bounding-box matching (currently radius-only).
- Quiet-hours gating per user.
- Multi-language composition (LLM locale-aware).
- Operator dashboard (CLI + web) to ack / re-dispatch.
- Two-way acknowledgement buttons (currently logged, not persisted).

---

## Demo notes

1. Seed at least one user via `src/store/users.ts` or directly insert into `./data/aegis.db`.
2. Run `npm run dev`.
3. Trigger an event by hitting USGS manually (their `all_day` feed is public) or waiting for an NWS alert.
4. Watch logs for `new event` → `inbound message` flows.

---

## Caspian SDK integration

`src/adapters/caspianCommProvider.ts` uses **only** APIs verified in the published `caspian-sdk@0.6.4` typings: `CommClient`, `connectEmail`, `connectDiscord`, `connectTelegram`, `sendMessage`, `initiate`, `onMessage`, `onInteraction`, `listen`, `handleWebhook`, `behaviorPrompt`.

Capabilities that exist in the SDK signature but whose semantics weren't fully verified during the buildathon window are routed through `UnverifiedCapabilityError` and logged — never silently dropped.