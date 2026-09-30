# Pump Sprints

A small webapp for timed Pump it Up score-chasing sprints, powered by the
[PIU Scores API](https://piuscores.arroweclip.se/swagger/index.html).

- Define a sprint: pick a mix, choose songs (dropdown built from the PIU Scores
  song catalog), set a sprint length of 1–4 weeks.
- While the sprint runs, a countdown shows your selected songs and live play counts.
- When the sprint ends, the app fetches every play you made during the sprint
  window on those songs (via the `players/me/journal` endpoint) and shows the
  results — then prompts you to create another sprint.

## Running

Your PIU Scores API token is read from the `PIU_SCORES_TOKEN` environment
variable, so it never lives in the image.

With Docker Compose:

```bash
cp .env.example .env      # then put your real token in .env
docker compose up --build
```

Then open http://localhost:8000

With plain Docker:

```bash
docker build -t pump-sprints .
docker run --rm -p 8000:8000 -e PIU_SCORES_TOKEN=your_token pump-sprints
```

Without Docker:

```bash
pip install -r requirements.txt
PIU_SCORES_TOKEN=your_token python app.py
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PIU_SCORES_TOKEN` | — (required) | Password for HTTP Basic auth to the PIU Scores API (the username is ignored). |
| `PIU_SCORES_URL` | `https://piuscores.arroweclip.se` | API base URL. |
| `PIU_SCORES_PLAYER_ID` | auto | Pin a player id. By default the app tries `me` and falls back to the one player your token can read. Set this if your tool key has access to several players. |
| `PIU_SCORES_GRACE_MINUTES` | `10` | PIU Scores journals plays at import time, not exact play time, so finished sprints keep their score window open this many extra minutes. |
| `PIU_CACHE_TTL_SECONDS` | `3600` | How long the mix/song/chart catalogs are cached. |
| `DATA_DIR` | `/app/data` | Where the sprint database lives (mounted as a volume in compose). |

## Notes

- Scores are matched to your chosen songs by chart id, so every difficulty of a
  selected song counts.
- Sprint history is stored in SQLite at `DATA_DIR/sprints.db`.
- A play's `occurredAt` is when it reached PIU Scores (an import), not the exact
  moment it was played — hence the grace period above.