<div align="center">

# 🌙 Anima

### *Where anime icons live, work, scheme, and collide.*

**An LLM-driven autonomous life simulator. Seven famous anime characters share a seaside town — each one a fully autonomous agent making its own decisions, every game tick.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-43853d?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![DeepSeek](https://img.shields.io/badge/LLM-DeepSeek%20%2F%20OpenAI%20compatible-7c3aed?style=for-the-badge)](#-llm-providers)
[![Tests](https://img.shields.io/badge/tests-266%20passing-3fb950?style=for-the-badge)](src)

**English** · [简体中文](README.zh-CN.md)

---

</div>

## ✨ What is Anima?

Anima is **not** a chatbot. It's not a game with scripted NPCs. It's a **24/7 self-running social simulation** where every character is its own LLM agent, deciding what to do next based on:

- **What they need** (hunger, energy, social, hygiene…)
- **Who they remember** (impressions, relationships, gossip)
- **What's happening around them** (other characters' visible actions, weather, time of day)
- **Who they are** (deep personality cards inspired by SillyTavern's character format)

Then they pick one of dozens of available **tools** (talk, eat, work, go_to, give, steal, …) and act. Drama emerges. Friendships form. People ghost each other. Someone slowly realizes something is wrong.

## 🎭 The Cast

The current world is populated by seven of the most iconic characters in anime history — and they don't get along.

| Character | Origin | Role | Hidden Tension |
|---|---|---|---|
| **L** | Death Note | Library researcher | Already 12% sure Light is *that* killer |
| **Light Yagami** | Death Note | Library assistant | The perfect honor student. Don't ask about his notebook. |
| **Shinji Ikari** | Evangelion | Bakery apprentice | Apologizes for breathing |
| **Asuka Langley** | Evangelion | Café waitress | Finds reasons to be near Shinji. Won't admit it. |
| **Rei Ayanami** | Evangelion | Florist | Doesn't understand "favorite flower" as a question |
| **Lelouch Lamperouge** | Code Geass | Café waiter | Mirrors Light. Knows it. |
| **Hitagi Senjougahara** | Bakemonogatari | Convenience store clerk | Carries staplers. As weapons. |

**The conflict matrix:** L ↔ Light (cat-and-mouse). Light ↔ Lelouch (two "I am justice" geniuses circling each other). Shinji ↔ Asuka (toxic codependence). Senjougahara ↔ everyone who underestimates her.

Run the simulation for an hour and you'll see things you didn't write.

## 🧠 What makes it tick

- **Tool-based agents** — every action is a function call. No hardcoded behaviors. The character cards define personality; the tool list defines what's possible.
- **Five layers of "feeling alive"** — environmental atmosphere, impressions, layered inner monologue, conversation modes, and observational reasoning.
- **Persistent inner monologue** — every LLM decision's thought is stored as memory. Ideas can carry across ticks.
- **Living-state memory** — `currentIntent` keeps unfinished business alive (you wanted to reply to her, you haven't yet). `observableState` lets others see "she's holding a cooling latte and staring at nothing."
- **Hot-reload** — edit a character or location in the UI and changes apply between ticks without breaking ongoing decisions.
- **Storage** — SQLite for the world state, YAML for character cards and locations, JSON for LLM settings.

## 🖥️ The Admin Panel

A zero-build Preact + htm web UI ships in `web/`. Open it to:

- **Live** — watch the simulation tick forward, see who's where, what they're saying
- **Characters** — full CRUD for character cards with a 5-tab editor (basics, personality, background, life, JSON preview)
- **Locations** — edit places, atmosphere descriptions per time-of-day, opening hours
- **Settings** — pick from 12 OpenAI-compatible LLM providers (DeepSeek, OpenAI, OpenRouter, Groq, Mistral, Together, Fireworks, Moonshot, SiliconFlow, Ollama, …) with auto-fill endpoints and one-click model selection. Test connection before saving.

Soft-disable everything (characters, locations) without losing the YAML — perfect for trying new casts.

## 🚀 Quick start

```bash
# 1. Clone & install
git clone https://github.com/Oldcircle/anima.git
cd anima
pnpm install

# 2. (Optional) configure LLM via .env, OR do it in the UI later
cp .env.example .env  # add DEEPSEEK_API_KEY or your provider

# 3. Run
pnpm dev
# → http://localhost:3001
```

That's it. Open the URL, hit **Settings** if you skipped step 2, then watch the seven characters wake up and start their day.

## 🔑 LLM Providers

Anima speaks the **OpenAI Chat Completions** dialect. Anything compatible works:

| Provider | Notes |
|---|---|
| DeepSeek | Default. Cheap, strong in Chinese. |
| OpenAI | gpt-4.1, gpt-4o, gpt-4o-mini |
| OpenRouter | Aggregator — mix Claude, Gemini, Llama, … |
| Groq | Fast Llama / Gemma inference |
| Mistral, xAI, Together, Fireworks, Moonshot, SiliconFlow | All built into the Settings dropdown |
| Ollama | **Local models, no key needed** |
| Custom | Any OpenAI-compatible endpoint |

Configure in the **Settings** page — or set `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` in `.env`. The settings file (`data/settings.json`) takes priority over `.env` and is hot-applied next tick.

## 🛠️ Stack

| | |
|---|---|
| **Runtime** | Node.js 24 + TypeScript 5.9 |
| **LLM** | OpenAI-compatible (DeepSeek default) |
| **Storage** | SQLite (better-sqlite3) + YAML + JSON |
| **Web** | Express 5 + WebSocket + Preact (CDN) + htm |
| **Tests** | Vitest 4 — 266 passing |

## 🧪 Commands

```bash
pnpm dev              # Run simulation + admin panel  → :3001
pnpm build            # tsc compile
pnpm test             # 266 unit tests, no API key needed
pnpm test:watch       # Watch mode
pnpm test:live        # Live LLM tests (needs key)
pnpm test:sim         # Multi-day simulation tests (needs key)
```

## 📁 Layout

```
anima/
├── src/
│   ├── core/           # Tick engine, event bus
│   ├── world/          # World state, locations, weather, relationships
│   ├── character/      # Character card types & YAML loader
│   ├── agent/          # Agent loop, prompt builder, conversation modes
│   ├── memory/         # Short-term memory, impressions, time decay
│   ├── actions/        # Action tools (talk/eat/work/go_to/...)
│   ├── providers/      # LLM provider abstraction
│   ├── persistence/    # SQLite save/load
│   ├── api/            # Express + WebSocket + admin CRUD routes
│   └── shared/         # Validation, schemas
├── web/                # Admin panel (zero-build Preact + htm)
│   ├── index.html
│   ├── legacy.html     # Original observer panel
│   └── app/            # main.js, providers.js, styles.css
├── data/
│   ├── characters/     # Character cards (YAML)
│   └── locations/      # Locations (YAML)
└── test/
```

## 🤝 Contributing

Anima is a personal experiment in "what happens when you treat famous fictional characters as autonomous agents." Issues, PRs, and *strange new character cards* are all welcome.

Add a character: drop a YAML file in `data/characters/`, restart, done. Or use the admin UI's "+ New Character" button.

## 📄 License

[MIT](LICENSE) © Anima contributors

---

<div align="center">

*Run the simulation. Don't script the story. Let them surprise you.*

</div>
