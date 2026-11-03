# siftbot expedition dashboard

Vite + React + shadcn/ui dashboard for the `border-walker` plugin. It polls
`/progress` every two seconds and renders position, remaining distance, speed,
ETA, vitals and the sampled route.

```bash
bun install
bun run build
SIFT_PROGRESS_FILE=/path/to/border-progress.json PORT=8790 node server.mjs
```

Open http://127.0.0.1:8790. Start a walk from the bot console with
`.border-walk ne`; the page explains the command when there is no progress file
yet. For boot-time hosting use `../deploy/systemd/siftbot-dashboard.service`.
