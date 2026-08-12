# Aegis-AI — Handoff Summary

> Internal handoff document. Everything I (the coding agent) built during the
> Caspian Buildathon, the design decisions, the bugs I tripped on, and the
> things that still need attention. Written so a teammate can take over without
> reading chat history.

---

## 1. What is Aegis-AI?

An **AI-powered emergency / disaster communication agent**. It watches public
disaster sources (USGS earthquakes, NWS weather, etc.), normalizes the signal,
correlates it to subscribed users by location, asks an LLM whether to send an
alert, then dispatches via Caspian (Email / Telegram / Discord).

The product is built for a **Caspian Buildathon** demo. Two ways to run it:

1. **Live pipeline** — real adapters ingest real events, real LLM, real Caspian.
2. **Demo mode** — deterministic scenarios drive the *same* pipeline through a
   `MockCaspianCommProvider` so the demo never depends on network or API keys.

A **hackathon dashboard** wraps demo mode in a live web UI with global threat
level, KPIs, world map, event panel, alert log, and a timeline stream.

---

## 2. Quick start

```bash
npm install

# pick one
npm run dev          # live pipeline (requires API keys)
npm run demo         # single scenario, terminal
npm run demo:all     # all 4 scenarios, terminal
npm run dashboard    # web dashboard at http://127.0.0.1:4310/

# housekeeping
npm test             # 127 tests across 9 files
npm run typecheck    # strict TS, clean
npm run build        # tsc → dist/
```

Environment (`.env`):

```
Caspian_API_KEY=...
Caspian_AGENT_ID=...
OPENAI_API_KEY=...          # optional; falls back to template LLM
USGS_BASE_URL=...            # optional override
NWS_BASE_URL=...
LOG_LEVEL=info              # default silent
```

---

## 3. Project layout

```
src/
├── config.ts                    # Env loading + zod validation
├── dashboard.ts                 # CLI entry: dashboard
├── entrypoint.ts                # Production pipeline entry
├── index.ts                     # Library re-exports
├── logger.ts                    # pino wrapper with console fallback
├── simulate.ts                  # CLI entry: demo scenarios

├── adapters/                    # Pluggable I/O
│   ├── caspianCommProvider.ts   # Real Caspian SDK adapter
│   ├── nwsSource.ts             # NWS weather
│   ├── openAiLlmProvider.ts     # OpenAI-backed LLM
│   └── usgsSource.ts            # USGS earthquakes

├── agent/                       # Decision logic
│   ├── aiAgent.ts               # Orchestrates normalize→verify→match→decide
│   ├── audience.ts              # Location-aware subscriber matching
│   └── decide.ts                # LLM-backed send/skip decision

├── comm/                        # Outbound routing
│   ├── formatter.ts             # Renders AlertPayload per channel
│   ├── intent.ts                # buildRoutingIntent() — channel + recipients
│   ├── router.ts                # CommRouter — dispatches via provider
│   └── types.ts                 # Channel, RoutingIntent, etc.

├── dashboard/                   # Web dashboard backend
│   ├── bus.ts                   # pub/sub for timeline events
│   ├── driver.ts                # Owns lifecycle, seeds users, runs scenarios
│   ├── server.ts                # HTTP + SSE
│   ├── state.ts                 # Snapshot builder from in-memory store
│   └── public/                  # Static frontend
│       ├── index.html
│       ├── styles.css           # emergency-management dark theme
│       └── app.js               # polls /api/state, subscribes to /api/timeline

├── services/                    # Service contracts
│   ├── commProvider.ts          # interface CommProvider
│   ├── disasterSource.ts        # interface DisasterSource
│   ├── discoveredEvent.ts       # normalized event shape
│   ├── llmProvider.ts           # interface LlmProvider
│   └── locationMatcher.ts       # point-in-polygon / haversine

├── simulation/                  # Demo mode
│   ├── mockCaspian.ts           # MockCaspianCommProvider
│   ├── runner.ts                # Drives a scenario through the real pipeline
│   └── scenarios.ts             # 4 scenarios (critical / high / moderate / low)

├── store/                       # sql.js persistence
│   ├── alerts.ts                # recentAlerts(...), markDelivered(...)
│   ├── db.ts                    # Store wrapper — ⚠️ see CRITICAL FIX below
│   ├── events.ts                # recentEvents(...), hasEvent(...)
│   └── users.ts                 # getActiveUsers(...), getUser(...)

└── types/                       # Domain types
    ├── agent.ts
    ├── alerts.ts
    ├── events.ts
    └── user.ts

tests/
├── aiAgent.test.ts              # agent orchestration
├── audience.test.ts             # subscriber matching
├── commRouter.test.ts           # routing + formatter
├── config.test.ts               # env validation
├── decide.test.ts               # LLM decision
├── schemas.test.ts              # zod schemas
├── simulation.test.ts           # scenario runner
├── storeBind.test.ts            # ⚠️ regression for the bind bug
└── usgsSource.test.ts           # USGS adapter
```

---

## 4. Architecture

### Production pipeline

```
DisasterSource (polls) ──▶ DiscoveredEvent ──▶ normalize()
                                                 │
                                                 ▼
                                          verify() — multi-source
                                                 │
                                                 ▼
                                       matchAudience() — geo + prefs
                                                 │
                                                 ▼
                                          AiAgent.decide()
                                                 │
                                                 ▼
                                      buildRoutingIntent()
                                                 │
                                                 ▼
                                       CommRouter.route()
                                                 │
                                                 ▼
                              CaspianCommProvider (Email/Telegram/Discord)
                                                 │
                                                 ▼
                                       Store (sql.js) ← persisted
```

### Demo mode

Identical pipeline, but:

* **Source** is replaced by a hard-coded `Scenario.discovered` event.
* **Caspian** is replaced by `MockCaspianCommProvider` (records sends, never hits the network).
* **LLM** defaults to `TemplateLlm` (deterministic text) — switch to `OpenAiLlmProvider` via env.

### Dashboard

```
:memory: Store ──▶ DashboardDriver ──▶ timeline bus ──▶ SSE ──▶ browser
        ▲                                          │
        │                                          ▼
   seeds users                          snapshot() ──▶ /api/state
   runs scenarios                       tail()      ──▶ replay buffer
```

`Bus.emit` is the only thing the rest of the app calls; the driver wires
`detected`, `verified`, `severity`, `audience`, `decision`, `queued`,
`delivered`, `failed`, `system`, `log` TimelineKinds.

---

## 5. What got built

### Phase 1–5 (pre-summary conversation)

Production pipeline end-to-end: sources, normalization, verification, audience
matching, LLM decision, routing, formatter, Caspian adapter, Store, config,
logger, full test suite.

### Phase 6 — Demo / Simulation mode

* `src/simulation/mockCaspian.ts` — `MockCaspianCommProvider` with `connect()`,
  `sendAlert()`, and a `sends` array the scenario can inspect.
* `src/simulation/scenarios.ts` — 4 scenarios:

  | id         | severity | channels                       | users |
  |------------|----------|--------------------------------|-------|
  | `critical` | CRITICAL | telegram + email + discord     | 4     |
  | `high`     | HIGH     | telegram + email               | 4     |
  | `moderate` | MODERATE | email                          | 3     |
  | `low`      | LOW      | (skipped — agent decides)      | 2     |

* `src/simulation/runner.ts` — drives one scenario through the **real**
  pipeline. `runScenario(scenario)` returns a `RunnerOutcome` with the
  `MockCaspianCommProvider` instance so the caller can inspect `sends`.
  `runner.onOutcome` filters out the noisy `sending` intermediate status.
* `src/simulate.ts` — CLI: `npm run demo -- critical|high|moderate|low|all`.
* `tests/simulation.test.ts` — 8 tests covering all four scenarios.

### Phase 7 — Hackathon dashboard

* `src/dashboard/bus.ts` — process-wide pub/sub; `dashboardBus`, `TimelineEvent`,
  `TimelineKind`, `fmtClock()`.
* `src/dashboard/server.ts` — Node `http` server (no Express). Routes:
  * `GET /` → `public/index.html`
  * `GET /styles.css` / `GET /app.js` → static
  * `GET /api/state` → JSON snapshot
  * `GET /api/timeline` → SSE (replay buffer + live + 15 s heartbeat)
* `src/dashboard/state.ts` — `buildDashboardState(store)` returns counts,
  global threat (GREEN/AMBER/RED), events[], recentAlerts[].
* `src/dashboard/driver.ts` — `DashboardDriver`;
  * `seedUsers()` — minimal subscriber set per scenario.
  * `execute(scenario)` — runs the scenario, pipes every step through the bus.
  * `startLoop(intervalMs)` — cycles scenarios (default 12 s).
  * `snapshot()` / `tail(limit)` — read helpers.
* `src/dashboard.ts` — entrypoint: opens `:memory:` store, seeds users, starts
  HTTP server, runs scenarios in a loop. Env: `AEGIS_DASHBOARD_PORT` (4310),
  `AEGIS_DASHBOARD_INTERVAL_SEC` (12).
* `src/dashboard/public/{index.html,styles.css,app.js}` — emergency-management
  dark theme, polls `/api/state` every 2 s, opens `EventSource('/api/timeline')`.

### Phase 7 — the critical bug fix

`src/store/db.ts` had `Store.all()` and `Store.first()` that accepted `params`
but **never called `stmt.bind(params)`**. Every parameterized SELECT returned
`datatype mismatch` from sql.js. The default `params=[]` path worked because
`bind([])` is a no-op in sql.js, which is why existing tests didn't catch it.

```ts
// before
while (stmt.step()) rows.push(/* ... */);

// after
if (params.length > 0) stmt.bind(params);
while (stmt.step()) rows.push(/* ... */);
```

`tests/storeBind.test.ts` locks this in: 4 tests that exercise parameterized
queries (`recentEvents`, `hasEvent`, `getUser`, `getActiveUsers`, `recentAlerts`).

### Phase 7 — smaller fixes

* `recentEvents` import path typo (`../store/alerts.js` → `../store/events.js`) in `driver.ts`.
* TS strict `?? 0` guards on `scenario.discovered.confidence` / `severityScore` (they're optional under `noUncheckedIndexedAccess`).
* Removed all `process.stderr.write` debug traces from `dashboard.ts` and `server.ts`.
* Removed stray `{{THREAT}}` placeholder from `index.html`.

---

## 6. Current state

* **127 / 127 tests pass** across 9 files.
* **`npm run typecheck` is clean** under strict + `noUncheckedIndexedAccess`.
* **Dashboard verified live** at `http://127.0.0.1:4310/`:
  * `/api/state` returns CRITICAL cyclone, 7 alerts delivered, RED threat.
  * `/api/timeline` streams the full sequence (BOOT → DETECTED → VERIFIED →
    SEVERITY → AUDIENCE → DECISION → QUEUED → DELIVERED).
  * Static files all return 200.

---

## 7. Design decisions

1. **sql.js not better-sqlite3** — pure JS, no native build, works in any
   Node 18+ environment. Trade-off: in-memory by default (dashboard), file-based
   for production. See `src/store/db.ts` for `:memory:` vs file path handling.
2. **No Express** — Node `http` + SSE. The dashboard is small enough that
   pulling in Express would have been more weight than code.
3. **Bus first, then store** — the dashboard's primary UX is the timeline
   stream, so the bus is the source of truth for live events; the store is the
   durable backing for `/api/state`.
4. **MockCaspian is a real `CommProvider`** — the scenario runner uses the
   exact same `CommRouter` as production, so demo parity is structural, not
   aspirational.
5. **TemplateLlm by default** — demo mode is deterministic. The OpenAI provider
   is wired but opt-in.

---

## 8. Things to be aware of

### `Store.all` / `Store.first` — binding

If anyone adds a new method that takes parameters, **always call
`stmt.bind(params)`**. See `tests/storeBind.test.ts` for the pattern.

### Async terminal quirk

PowerShell `run_in_terminal` mode=async kills the spawned process tree when
the terminal is "idle". For long-running things (like the dashboard), use:

```powershell
Start-Job -ScriptBlock { npm run dashboard } | Out-Null
```

…then `Receive-Job` / `Stop-Job` to manage it.

### Screenshot / API examples

`curl http://127.0.0.1:4310/api/state` returns the full snapshot. The
`globalThreat` field is `GREEN` if no active events, `AMBER` if any active but
none CRITICAL, `RED` if at least one CRITICAL.

### Scenarios are deterministic

Edit `src/simulation/scenarios.ts` to change coords / users / channels. The
seed users are intentionally tiny so the dashboard renders cleanly — for a
real demo, swap in `seedUsers()` reading from a CSV.

---

## 9. Known issues / next steps

1. **README is stale** — it doesn't mention `npm run demo`, `demo:all`, or
   `dashboard`. Easy fix; the user may want this done before the demo.
2. **No real Caspian in dashboard** — the demo uses `MockCaspian`. If the
   buildathon judges want to see real Telegram / Discord delivery, swap
   `MockCaspianCommProvider` for `CaspianCommProvider` in
   `src/dashboard/driver.ts`.
3. **Replaying scenarios is timing-only** — `startLoop` waits `intervalMs`
   between scenarios; there's no notion of "trigger X at minute Y".
4. **Aegis-dash.log** — generated by `Start-Job` calls during my debugging.
   Safe to delete; harmless if it persists.
5. **`.puku/` directory** — embeddings cache for the agent that wrote this
   doc. Should be gitignored as-is.

---

## 10. Commands cheat sheet

```bash
# Run the dashboard (buildathon demo)
npm run dashboard

# Run a single scenario in the terminal
npm run demo -- critical
npm run demo -- high
npm run demo -- moderate
npm run demo -- low

# Run all four, one after another, with summaries
npm run demo:all

# Verify everything
npm run typecheck
npm test
```

---

## 11. TL;DR for the teammate

* The pipeline works end-to-end. **127 tests pass, typecheck is clean.**
* For the buildathon, use `npm run dashboard` — it's the polished surface.
* The biggest risk is the `Store.bind` bug. If you see `datatype mismatch`,
  check `src/store/db.ts` first.
* Everything else is straightforward TypeScript — read `src/index.ts` for the
  public surface, follow one scenario through `src/simulation/runner.ts` to
  see the full pipeline in action.

— end of handoff
