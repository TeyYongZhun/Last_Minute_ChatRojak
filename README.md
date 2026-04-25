# Last Minute ChatRojak

**Team name** - Last Minute (230)
**Member 1** - Edrian Tan Kah Heng
**Member 2** - Tey Yong Zhun
**Member 3** - Teh Xu Zhe
> AI-powered task extraction and planning from chat messages

Paste your messy WhatsApp, Telegram, or team chat messages and ChatRojak automatically extracts tasks, prioritizes them, estimates deadlines, and syncs everything to your calendar.

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
# AI Provider: 'gemini' or 'ilmuglm'
AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key

# Server
PORT=8000
SESSION_SECRET=your_64_char_hex_secret

# Database
DB_PATH=state/app.db

# Google Calendar (optional)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:8000/api/google/auth/callback

# Telegram Bot (optional)
TELEGRAM_BOT_TOKEN=your_bot_token
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
│   ├── server.js               # Express server & API routes
│   ├── client.js               # AI provider abstraction layer
│   ├── modules/                # Core business logic
│   │   ├── task1Parser.js
│   │   ├── task2Planner.js
│   │   ├── task3Executor.js
│   │   ├── eisenhowerMatrix.js
│   │   ├── adaptiveScoring.js
│   │   ├── lifeBalance.js
│   │   ├── clarificationLoop.js
│   │   ├── dependencyGraph.js
│   │   ├── telegramBot.js
│   │   └── ...
│   ├── db/
│   │   ├── migrations/         # SQL schema migrations (001–008)
│   │   └── repos/              # Data access layer per entity
│   ├── routes/                 # Auth, Google OAuth, Telegram webhook
│   └── integrations/
│       └── googleCalendar.js
├── static/
│   └── index.html              # SPA frontend
├── test/                       # Vitest test suite
├── scripts/
│   └── migrate-json-state.js
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
