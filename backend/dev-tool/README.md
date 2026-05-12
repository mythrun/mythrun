# @mythrun/dev-tool

Local-only engineering UI for the Mythrun backend. Throwaway — not the production frontend.

## Bring-up

```
pnpm install
pnpm dev:dev-tool
```

Open `http://127.0.0.1:5273`. Requires the local backend running (`pnpm dev`) on whichever port `backend/.env.development` `PORT` is set to — default 3000. The Vite dev server reads the same env file and points its `/api` and `/health` proxy at the matching port, so changing `PORT` in one place updates both.

See `docs/wiki/content/runtime/dev-tool.html` for the full overview, ship gate, and conventions.
