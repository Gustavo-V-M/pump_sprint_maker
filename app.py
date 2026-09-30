"""Pump Sprint webapp: timed Pump it Up score-chasing sprints.

Routes:
  GET  /                    -> single-page UI
  GET  /api/health          -> liveness + token check
  GET  /api/mixes           -> mix list for the setup form
  GET  /api/songs?mix=...   -> song catalog (dropdown) with chart ids
  GET  /api/sprint          -> current/last sprint + server time
  POST /api/sprint          -> start a new sprint
  POST /api/sprint/end      -> end the active sprint early
  GET  /api/sprint/scores   -> plays on the sprint's songs inside its window
"""

import logging
import os
import secrets
import threading
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, render_template, request

from piu_api import PiuApiError, PiuClient, _utcnow
from store import SprintStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = Flask(__name__)

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
GRACE_MINUTES = int(os.environ.get("PIU_SCORES_GRACE_MINUTES", "10"))
MIN_SPRINT_SECONDS = 10
MAX_SPRINT_SECONDS = 7200
# Basic-auth password. Username is ignored.
AUTH_TOKEN = os.environ.get("PIU_SCORES_TOKEN", "").strip()

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


@app.before_request
def require_auth():
    """HTTP Basic: any username, password must equal PIU_SCORES_TOKEN.

    Skipped when no token is configured so the setup error stays visible.
    """
    if not AUTH_TOKEN:
        return None
    auth = request.authorization
    if auth and auth.password and secrets.compare_digest(auth.password, AUTH_TOKEN):
        return None
    resp = jsonify({"error": "Unauthorized."})
    resp.status_code = 401
    # WWW-Authenticate makes the browser prompt natively and replay the
    # credentials on every subsequent request to this origin.
    resp.headers["WWW-Authenticate"] = 'Basic realm="Pump Sprints"'
    return resp


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


@app.get("/api/mixes")
def mixes():
    try:
        return jsonify({"mixes": get_client().mixes()})
    except PiuApiError as exc:
        return _error(str(exc), exc.status_code or 502)


@app.get("/api/songs")
def songs():
    mix = request.args.get("mix", "").strip()
    if not mix:
        return _error("Query parameter 'mix' is required.")
    try:
        catalog = get_client().song_catalog(mix)
    except PiuApiError as exc:
        return _error(str(exc), exc.status_code or 502)
    return jsonify(catalog)


@app.get("/api/sprint")
def current_sprint():
    store.expire_if_due()
    sprint = store.current()
    return jsonify({"sprint": sprint, "serverNow": _utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")})


@app.post("/api/sprint")
def create_sprint():
    body = request.get_json(silent=True) or {}
    mix = str(body.get("mix", "")).strip()
    songs = body.get("songs")
    duration = body.get("durationSeconds")

    if not mix:
        return _error("Pick a mix.")
    if not isinstance(songs, list) or not songs or not all(isinstance(s, str) and s.strip() for s in songs):
        return _error("Pick at least one song.")
    songs = sorted({s.strip() for s in songs})
    if not isinstance(duration, int) or isinstance(duration, bool):
        return _error("Duration must be a number of seconds.")
    if not MIN_SPRINT_SECONDS <= duration <= MAX_SPRINT_SECONDS:
        return _error(
            f"Duration must be between {MIN_SPRINT_SECONDS} and "
            f"{MAX_SPRINT_SECONDS} seconds."
        )

    # Songs must exist on the chosen mix so the score fetch can match charts.
    try:
        client = get_client()
        catalog = client.song_catalog(mix)
    except PiuApiError as exc:
        return _error(str(exc), exc.status_code or 502)
    known = {s["name"] for s in catalog["songs"]}
    unknown = [s for s in songs if s not in known]
    if unknown:
        return _error(f"Unknown song(s) on {mix}: {', '.join(unknown)}")

    sprint = store.create(mix, songs, duration)
    app.logger.info(
        "sprint %s started: mix=%s songs=%d duration=%ds",
        sprint["id"], mix, len(songs), duration,
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

    try:
        client = get_client()
        catalog = client.song_catalog(sprint["mix"])
    except PiuApiError as exc:
        return _error(str(exc), exc.status_code or 502)

    selected = set(sprint["songs"])
    chart_index = catalog["chartIndex"]
    selected_chart_ids = {
        cid for cid, c in chart_index.items() if c["songName"] in selected
    }

    start, end = _sprint_window(sprint)
    try:
        plays = client.plays_since(sprint["mix"], start)
    except PiuApiError as exc:
        return _error(str(exc), exc.status_code or 502)

    rows = []
    for play in plays:
        occurred = play.get("_occurredAt")
        if occurred is None or not (start <= occurred <= end):
            continue
        chart = chart_index.get(str(play.get("chartId")))
        if not chart or chart["songName"] not in selected:
            continue
        rows.append(
            {
                "chartId": play.get("chartId"),
                "songName": chart["songName"],
                "level": chart["level"],
                "chartType": chart["type"],
                "difficulty": chart["difficulty"],
                "imageUrl": chart.get("imageUrl"),
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

    return jsonify(
        {
            "sprint": sprint,
            "plays": rows,
            "summary": summary,
            "graceMinutes": GRACE_MINUTES if sprint["status"] != "active" else 0,
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), debug=False)