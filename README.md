# Last Minute ChatRojak

### 🎥 Pitching Video 
> **[Watch our Project Pitching Video here](https://drive.google.com/drive/folders/11xFTcpw0_6hDmv2WjKBwpsWeKG2rzUAi)** 

---

**Team name:** Last Minute (230)

* **Member 1:** Edrian Tan Kah Heng
* **Member 2:** Tey Yong Zhun
* **Member 3:** Teh Xu Zhe

Paste your messy WhatsApp or team chat messages and ChatRojak automatically extracts tasks, prioritizes them, estimates deadlines, and syncs everything to your calendar.

---

## Features

- **Chat-to-Task Parsing** — Extracts actionable tasks from raw, informal chat text with confidence scoring
- **Smart Prioritization** — Scores tasks by urgency, importance, and effort using an Eisenhower Matrix
- **Multi-step Planning** — Generates checklists, detects conflicts, and resolves task dependencies
- **Adaptive Scoring** — Learns your preferences over time to improve priority recommendations
- **Life Balance Analysis** — Monitors workload distribution and flags overload
- **Clarification Loop** — Asks follow-up questions when task details are ambiguous
- **Google Calendar Sync** — Automatically creates calendar events from your task plan
- **Multiple AI Providers** — Supports Gemini (Google), ILMU GLM, and Anthropic Claude

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express.js |
| Database | SQLite (better-sqlite3) |
| Frontend | Vanilla HTML/JS (SPA) |
| AI | Anthropic Claude, Google Gemini, ILMU GLM |
| Auth | Cookie sessions + bcryptjs |
| Integrations | Google Calendar OAuth2|
| Testing | Vitest + Supertest |

---

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- An API key for at least one AI provider (Gemini or ILMU GLM recommended for free tier)

### Installation

```bash
git clone https://github.com/your-username/Last_Minute_ChatRojak.git
cd Last_Minute_ChatRojak
npm install
```

### Configuration

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Key variables in `.env`:

```env
# AI Provider: 'gemini' or 'openai'
AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash

ILMU_API_KEY=your_ilmu_api_key
ILMU_BASE_URL=https://api.ilmu.ai/v1
ILMU_MODEL=ilmu-glm-5.1

# Server
PORT=8000

# Google Calendar (optional)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:8000/api/google/auth/callback

```

### Run

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

### Database Migrations

Migrations run automatically on startup. To migrate legacy JSON state:

```bash
npm run migrate:json
```

---

## How It Works

ChatRojak processes your messages through a 3-stage AI pipeline:

```
Raw Chat Message
      |
      v
  [Stage 1: Parse]
  task1Parser.js
  - Extract task text
  - Detect deadlines
  - Assign priority & category
  - Score confidence
      |
      v
  [Stage 2: Plan]
  task2Planner.js
  - Score urgency & importance
  - Estimate effort
  - Detect conflicts
  - Schedule time slots
      |
      v
  [Stage 3: Execute]
  task3Executor.js
  - Generate step checklists
  - Track status lifecycle
  - Sync to Google Calendar
  - Send reminders
```

---

## Project Structure

```
Last_Minute_ChatRojak/
├── src/
│   ├── server.js                      # Express server & API routes
│   ├── scheduler.js                   # Background job scheduler
│   ├── client.js                      # AI provider abstraction layer
│   ├── load-env.js                    # Environment variable loader
│   ├── setupAuth.js                   # Auth initialisation
│   ├── testCalendar.js                # Calendar integration test script
│   ├── auth/
│   │   ├── middleware.js              # Session authentication middleware
│   │   ├── passwords.js              # Password hashing utilities
│   │   └── rateLimit.js              # Login rate limiting
│   ├── modules/                       # Core business logic
│   │   ├── task1Parser.js            # Stage 1: parse chat → tasks
│   │   ├── task2Planner.js           # Stage 2: plan & prioritise
│   │   ├── task3Executor.js          # Stage 3: execute & track
│   │   ├── actions.js                # Task action handlers
│   │   ├── adapter.js                # AI provider adapter
│   │   ├── adaptiveScoring.js        # Preference learning & scoring
│   │   ├── calendarSuggester.js      # Smart calendar slot suggestion
│   │   ├── categorizer.js            # Task categorisation
│   │   ├── clarificationLoop.js      # Ambiguity follow-up loop
│   │   ├── deadlineParser.js         # Natural language deadline parsing
│   │   ├── dependencyGraph.js        # Task dependency resolution
│   │   ├── lifeBalance.js            # Workload & balance analysis
│   │   ├── notifier.js               # Push notification dispatch
│   │   ├── processStream.js          # Streaming AI pipeline
│   │   ├── promptChain.js            # Prompt chaining helpers
│   │   ├── slotter.js                # Time-slot allocation
│   │   ├── smartReminders.js         # Intelligent reminder scheduling
│   │   ├── stepGenerator.js          # Checklist step generation
│   │   ├── telegramBot.js            # Telegram bot integration
│   │   └── validator.js              # Input validation
│   ├── db/
│   │   ├── index.js                  # Database connection
│   │   ├── migrate.js                # Migration runner
│   │   ├── migrations/               # SQL schema migrations (001–008)
│   │   └── repos/                    # Data access layer per entity
│   │       ├── adaptation.js
│   │       ├── calendarEvents.js
│   │       ├── checklists.js
│   │       ├── clarificationThreads.js
│   │       ├── dependencies.js
│   │       ├── googleTokens.js
│   │       ├── notifications.js
│   │       ├── plans.js
│   │       ├── reminders.js
│   │       ├── replanEvents.js
│   │       ├── sessions.js
│   │       ├── taskEvents.js
│   │       ├── tasks.js
│   │       ├── telegram.js
│   │       ├── userPreferences.js
│   │       └── users.js
│   ├── routes/
│   │   ├── auth.js                   # Authentication routes
│   │   ├── googleOAuth.js            # Google OAuth2 callback
│   │   └── telegram.js              # Telegram webhook route
│   ├── integrations/
│   │   └── googleCalendar.js         # Google Calendar API wrapper
│   └── services/
│       └── googleCalendar.js         # Google Calendar service layer
├── static/
│   └── index.html                    # SPA frontend
├── test/
│   ├── setup.js                      # Test environment setup
│   ├── unit/                         # Unit tests (13 suites)
│   └── integration/                  # Integration tests (7 suites)
├── scripts/
│   ├── migrate-json-state.js         # Migrate legacy JSON → SQLite
│   └── audit-orphan-calendar-events.js
├── state/                            # Runtime SQLite database
├── PRD&SAD&QATD&PItch Deck/         # Project documents (PRD, SAD, QATD, pitch deck)
├── vitest.config.js
├── .env.example
└── package.json
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/process` | Submit chat text for task extraction |
| `POST` | `/api/process-stream` | Streaming version of task extraction |
| `GET` | `/api/dashboard` | Get all tasks for current user |
| `POST` | `/api/tasks/:id/start` | Mark task as started |
| `POST` | `/api/tasks/:id/complete` | Mark task as completed |
| `POST` | `/api/tasks/:id/pause` | Pause a task |
| `POST` | `/api/tasks/:id/eisenhower` | Set urgency/importance quadrant |
| `POST` | `/api/tasks/:id/dependencies` | Add task dependency |
| `GET` | `/api/tasks/:id/timeline` | Get task timeline view |
| `POST` | `/api/clarifications/:threadId/answer` | Answer a clarification question |
| `GET/POST` | `/api/preferences` | Read or update user preferences |
| `GET` | `/api/google/auth` | Start Google OAuth2 flow |

---

## Testing

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

---

## Environment Variables Reference

See [.env.example](.env.example) for the full list of supported variables.
