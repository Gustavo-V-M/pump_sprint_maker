"""Client for the PIU Scores API (https://piuscores.arroweclip.se).

Handles bearer-token auth from the environment, cursor paging, and an
in-memory TTL cache for catalog data (mixes, songs, charts).
"""

import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

import requests

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://piuscores.arroweclip.se"


class PiuApiError(Exception):
    def __init__(self, message, status_code=None):
        super().__init__(message)
        self.status_code = status_code


def _utcnow():
    return datetime.now(timezone.utc)


def _parse_iso(value):
    if value is None:
        return None
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


class PiuClient:
    def __init__(self):
        token = os.environ.get("PIU_SCORES_TOKEN", "").strip()
        if not token:
            raise PiuApiError(
                "PIU_SCORES_TOKEN environment variable is not set. "
                "Provide your PIU Scores API token to authenticate."
            )
        self._base = os.environ.get("PIU_SCORES_URL", DEFAULT_BASE_URL).rstrip("/")
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            }
        )
        self._cache = {}
        self._cache_ttl = int(os.environ.get("PIU_CACHE_TTL_SECONDS", "3600"))
        self._lock = threading.RLock()
        self._player_id = os.environ.get("PIU_SCORES_PLAYER_ID", "").strip() or None

    # ------------------------------------------------------------------ core

    def _get(self, path, params=None, retries=1):
        url = path if path.startswith("http") else self._base + path
        resp = self._session.get(url, params=params, timeout=30)
        if resp.status_code == 429 and retries > 0:
            log.warning("429 from PIU API, retrying %s", url)
            time.sleep(2)
            return self._get(path, params, retries - 1)
        if resp.status_code != 200:
            log.warning("PIU API %s for %s", resp.status_code, url)
            raise PiuApiError(
                f"PIU Scores API returned {resp.status_code} for {url}",
                status_code=resp.status_code,
            )
        return resp.json()

    def _get_paged(self, path, params=None, max_pages=100):
        """Follow the envelope's `next` link, collecting every row."""
        rows = []
        url = path
        for _ in range(max_pages):
            payload = self._get(url, params=params)
            rows.extend(payload.get("data") or [])
            next_url = payload.get("next")
            if not next_url:
                break
            url, params = next_url, None
        return rows

    def _cached(self, key, loader):
        with self._lock:
            entry = self._cache.get(key)
            now = time.monotonic()
            if entry and now - entry[0] < self._cache_ttl:
                return entry[1]
            value = loader()
            self._cache[key] = (now, value)
            return value

    # ------------------------------------------------------------- catalogs

    def mixes(self):
        def load():
            rows = self._get_paged("/api/v2/mixes", {"limit": 500})
            return [
                {
                    "name": r.get("name"),
                    "displayName": r.get("displayName") or r.get("name"),
                    "isPrimary": bool(r.get("isPrimary")),
                }
                for r in rows
                if r.get("name")
            ]

        return self._cached("mixes", load)

    def song_catalog(self, mix):
        """Songs on a mix joined with their charts, sorted for a dropdown.

        Returns {songs: [{name, artist, durationSeconds, bpm, imageUrl,
                          charts: [{id, level, type, difficulty, noteCount,
                                    imageUrl, stepArtist}]}, ...],
                 chartIndex: {chartId: chartInfo}, errors: []}
        """
        def load():
            songs = self._get_paged("/api/v2/songs", {"mix": mix, "limit": 500})
            charts = self._get_paged("/api/v2/charts", {"mix": mix, "limit": 500})
            by_song = {s.get("name"): dict(s, charts=[]) for s in songs if s.get("name")}
            chart_index = {}
            for c in charts:
                name = c.get("songName")
                chart = {
                    "id": c.get("id"),
                    "level": c.get("level"),
                    "type": c.get("type"),
                    "difficulty": c.get("difficulty"),
                    "noteCount": c.get("noteCount"),
                    "imageUrl": c.get("imageUrl"),
                    "stepArtist": c.get("stepArtist"),
                }
                if c.get("id"):
                    chart_index[c["id"]] = dict(chart, songName=name)
                if name in by_song:
                    by_song[name]["charts"].append(chart)
            catalog = sorted(by_song.values(), key=lambda s: s["name"].lower())
            return {"songs": catalog, "chartIndex": chart_index}

        return self._cached(f"catalog:{mix}", load)

    # --------------------------------------------------------------- players

    def player_id(self):
        """Resolve the player whose data to read.

        Order: PIU_SCORES_PLAYER_ID env, then `me` (personal tokens),
        then the single player the token can read (tool tokens).
        """
        if self._player_id:
            return self._player_id
        try:
            me = self._get("/api/v2/players/me")
            self._player_id = me.get("userId") or "me"
            log.info("player resolved via `me`: %s", self._player_id)
            return self._player_id
        except PiuApiError:
            log.info("`me` unavailable for this token, falling back to /players")
        players = self._get_paged("/api/v2/players", {"limit": 500})
        if not players:
            raise PiuApiError(
                "Could not resolve a player: token has no `me` player and "
                "no shared players were found."
            )
        # Multiple players visible (tool tokens)? Defaults to the first one;
        # set PIU_SCORES_PLAYER_ID to pin a specific player.
        self._player_id = players[0].get("userId")
        log.info("player resolved via /players fallback: %s", self._player_id)
        return self._player_id

    # --------------------------------------------------------------- journal

    def plays_since(self, mix, since):
        """Every journal play on a mix at or after `since` (aware datetime)."""
        player = self.player_id()
        rows = self._get_paged(
            f"/api/v2/players/{player}/journal",
            {"mix": mix, "since": since.strftime("%Y-%m-%dT%H:%M:%SZ"), "limit": 500},
            max_pages=8,
        )
        for r in rows:
            r["_occurredAt"] = _parse_iso(r.get("occurredAt"))
        return rows