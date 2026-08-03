# Cloudbank "Gemini Live" demo

Three components — see the root `README.md` for the design.

- `cxas_app/Cloudbank/` — the deployed GECX agent (2-agent topology).
- `proxy/` — FastAPI BidiRunSession proxy. See `proxy/README.md`.
- `web/` — Vite + React mobile-shaped web app.

## What the demo covers

The Spend Analysis journey, end to end, for any of the four personas.

- Voice in → agent reply out, via the header concierge pill
- **Push-to-talk** — hold the pill or the spacebar; `?ptt=0` for always-listening
- **All four personas** — `?persona=chloe|david|tom|sarah`
- Client functions — `navigate_to` plus five `get_*` spending tools and `search_help`
- Agent-driven UI — the `show` flag navigates and switches view in one tool call
- 2-agent topology — `root_agent` + `spending_agent`, silent transfer
- CI on every PR (`.github/workflows/ci.yml`)

The persona is selected by URL. The Mortgage tab is a static screen the agent
does not drive; Savings and Servicing have no screens. Golden evals cover the
Chloe persona.

## Run locally

```bash
# Terminal 1: proxy (needs the shared .venv activated, and cloudbank/gecx-config.json)
cd cloudbank/proxy && uvicorn proxy.main:app --reload --host 127.0.0.1 --port 8080

# Terminal 2: web
cd cloudbank/web && npm run dev
```

Open `http://localhost:5173/`, allow mic access, then **hold** the concierge pill
(or the spacebar) and speak. Release to send.

Useful URLs:

| URL | What it does |
|---|---|
| `/?persona=david` | Switch persona (`chloe`, `david`, `tom`, `sarah`) |
| `/?ptt=0` | Always-listening mode instead of push-to-talk |
| `/?persona=tom&ptt=0` | Flags combine |

Tom rents, so his Mortgage tab shows an empty state rather than a mortgage.

**Hosted dev environments** (Cloud Shell, Cloud Workstations, Codespaces) work
without extra configuration; the proxy accepts those origins. If you serve the
app from somewhere else, set `PROXY_ALLOWED_ORIGINS` or the WebSocket is
rejected and the pill sits on "Retry".

## Test

The same gates CI runs — see `AGENTS.md` for the full list:

```bash
cd cloudbank/web   && npm test && npm run typecheck && npm run lint
cd cloudbank/proxy && python -m pytest && uvx ruff check .
cd cloudbank       && cxas lint        # must be 0 errors, 0 warnings
```

## Deploy the agent

```bash
./cloudbank/push.sh
```

Reads project, location and app id from `gecx-config.json` — never hardcode
them. `AGENTS.md` covers the post-push verification and the additive-push
gotcha when removing a tool.
