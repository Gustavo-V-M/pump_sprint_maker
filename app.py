"""Pump Sprint webapp: timed Pump it Up score-chasing sprints.

Routes:
  GET  /                    -> single-page UI
  GET  /api/health          -> liveness + token check
  GET  /api/charts          -> song/chart catalog from charts_phoenix-2.csv
  GET  /api/sprint          -> current/last sprint + server time
  POST /api/sprint          -> start a new sprint
  POST /api/sprint/end      -> end the active sprint early
  GET  /api/sprint/scores   -> plays on the sprint's charts inside its window
"""

import csv
import logging
import os
import threading
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, render_template, request

from piu_api import PiuApiError, PiuClient, _utcnow
from store import SprintStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = Flask(__name__)

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
CHARTS_CSV = os.path.join(os.path.dirname(__file__), "charts_phoenix-2.csv")
GRACE_MINUTES = int(os.environ.get("PIU_SCORES_GRACE_MINUTES", "10"))
MIN_SPRINT_SECONDS = 10
MAX_SPRINT_SECONDS = 28 * 86400


def _load_charts():
    """Parse the chart export into {song: [charts]} and {chartId: chart}."""
    by_song, by_id = {}, {}
    with open(CHARTS_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cid, song = row["ChartId"].strip(), row["Song"].strip()
            if not cid or not song or cid in by_id:
                continue
            chart = {
                "id": cid,
                "song": song,
                "type": row["Type"].strip(),
                "level": int(row["Level"]),
                "mix": row["Mix"].strip(),
            }
            by_id[cid] = chart
            by_song.setdefault(song, []).append(chart)
    for charts in by_song.values():
        charts.sort(key=lambda c: (c["type"], c["level"]))
    return by_song, by_id


_charts_by_song, _charts_by_id = _load_charts()

store = SprintStore(DATA_DIR)
_client = None
_client_lock = threading.Lock()


def get_client():
    # One shared client per process so the catalog cache actually persists.
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = PiuClient()
    return _client


def _error(message, status=400):
    return jsonify({"error": message}), status


def _sprint_window(sprint):
    """(start, end) as aware datetimes for the sprint's score window."""
    start = datetime.strptime(sprint["startedAt"], "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc
    )
    if sprint["status"] == "active":
        return start, _utcnow()
    ended = datetime.strptime(sprint["endedAt"], "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc
    )
    # occurredAt on the journal is when a play reached PIU Scores, not when it
    # was played, so allow a grace period for late-arriving imports.
    return start, ended + timedelta(minutes=GRACE_MINUTES)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    try:
        get_client()
    except PiuApiError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 200
    return jsonify({"ok": True})


@app.get("/api/charts")
def charts_catalog():
    payload = [
        {"name": song, "charts": [{"id": c["id"], "type": c["type"], "level": c["level"]} for c in charts]}
        for song, charts in sorted(_charts_by_song.items())
    ]
    return jsonify({"songs": payload})


@app.get("/api/sprint")
def current_sprint():
    store.expire_if_due()
    sprint = store.current()
    return jsonify({"sprint": sprint, "serverNow": _utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")})


@app.post("/api/sprint")
def create_sprint():
    body = request.get_json(silent=True) or {}
    charts = body.get("charts")
    duration = body.get("durationSeconds")

    if not isinstance(charts, list) or not charts or not all(isinstance(c, str) and c.strip() for c in charts):
        return _error("Pick at least one chart.")
    charts = sorted(set(charts))
    if not isinstance(duration, int) or isinstance(duration, bool):
        return _error("Duration must be a number of seconds.")
    if not MIN_SPRINT_SECONDS <= duration <= MAX_SPRINT_SECONDS:
        return _error(
            f"Sprint length must be between 10 seconds and "
            f"{MAX_SPRINT_SECONDS // 86400} days."
        )

    unknown = [c for c in charts if c not in _charts_by_id]
    if unknown:
        return _error(f"Unknown chart id(s): {', '.join(unknown[:5])}")

    mix = _charts_by_id[charts[0]]["mix"]
    songs = sorted({_charts_by_id[c]["song"] for c in charts})
    sprint = store.create(mix, songs, charts, duration)
    app.logger.info(
        "sprint %s started: mix=%s charts=%d duration=%ds",
        sprint["id"], mix, len(charts), duration,
    )
    return jsonify({"sprint": sprint}), 201


@app.post("/api/sprint/end")
def end_sprint():
    sprint = store.latest(include_active_only=True)
    if not sprint:
        return _error("No active sprint to end.", 404)
    store.expire_if_due()
    sprint = store.get(sprint["id"])
    if sprint and sprint["status"] == "active":
        sprint = store.end(sprint["id"], status="ended_early")
        app.logger.info("sprint %s ended early", sprint["id"])
    return jsonify({"sprint": sprint})


@app.get("/api/sprint/scores")
def sprint_scores():
    store.expire_if_due()
    sprint = store.current()
    if not sprint:
        return _error("No sprint yet.", 404)

    # New sprints store the exact chart ids; legacy sprints (pre-chart export)
    # count every chart of the songs they named.
    if sprint["charts"]:
        selected = set(sprint["charts"])
    else:
        songs = set(sprint["songs"])
        selected = {cid for cid, c in _charts_by_id.items() if c["song"] in songs}

    start, end = _sprint_window(sprint)
    try:
        client = get_client()
        plays = client.plays_since(sprint["mix"], start)
    except PiuApiError as exc:
        return _error(str(exc), exc.status_code or 502)

    rows = []
    for play in plays:
        occurred = play.get("_occurredAt")
        if occurred is None or not (start <= occurred <= end):
            continue
        chart = _charts_by_id.get(str(play.get("chartId")))
        if not chart or chart["id"] not in selected:
            continue
        rows.append(
            {
                "chartId": play.get("chartId"),
                "songName": chart["song"],
                "level": chart["level"],
                "chartType": chart["type"],
                "score": play.get("score"),
                "letterGrade": play.get("letterGrade"),
                "plate": play.get("plate"),
                "isBroken": play.get("isBroken"),
                "isStageBroken": play.get("isStageBroken"),
                "isBest": play.get("isBest"),
                "judgments": play.get("judgments"),
                "occurredAt": play.get("occurredAt"),
            }
        )

    rows.sort(key=lambda r: (r["occurredAt"] or ""), reverse=True)

    summary = {}
    for song in sprint["songs"]:
        song_rows = [r for r in rows if r["songName"] == song]
        passed = [r for r in song_rows if not r["isBroken"] and r["score"] is not None]
        best = max(passed, key=lambda r: r["score"]) if passed else None
        broken = [r for r in song_rows if r["isBroken"] and r["score"] is not None]
        best_broken = max(broken, key=lambda r: r["score"]) if broken else None
        summary[song] = {
            "attempts": len(song_rows),
            "passes": len(passed),
            "bestScore": best["score"] if best else (best_broken["score"] if best_broken else None),
            "bestGrade": (best or best_broken or {}).get("letterGrade"),
            "bestPlate": (best or best_broken or {}).get("plate"),
            "bestLevel": (best or best_broken or {}).get("level"),
            "bestIsPass": best is not None,
        }

    selected_charts = []
    for cid in sorted(selected):
        chart = _charts_by_id.get(cid)
        if chart:
            selected_charts.append(
                {"id": cid, "song": chart["song"], "type": chart["type"], "level": chart["level"]}
            )

    return jsonify(
        {
            "sprint": sprint,
            "plays": rows,
            "charts": selected_charts,
            "summary": summary,
            "graceMinutes": GRACE_MINUTES if sprint["status"] != "active" else 0,
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), debug=False)