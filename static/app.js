/* Pump Sprints — front-end controller */

const $ = (id) => document.getElementById(id);

const state = {
  mixes: [],
  catalog: null, // { songs: [...], chartIndex: {...} } for selected mix
  selected: new Set(),
  sprint: null,
  serverOffsetMs: 0,
  timerHandle: null,
  scoresHandle: null,
  finished: false,
};

/* ------------------------------------------------------------------ views */

function showView(name) {
  for (const v of document.querySelectorAll(".view")) v.classList.add("hidden");
  $(`view-${name}`).classList.remove("hidden");
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.classList.remove("hidden");
}

function hideError(id) {
  $(id).classList.add("hidden");
}

/* --------------------------------------------------------------- helpers */

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = null;
  try {
    body = await resp.json();
  } catch {
    /* ignore */
  }
  if (!resp.ok) {
    throw new Error((body && body.error) || `Request failed (${resp.status})`);
  }
  return body;
}

function fmtDuration(seconds) {
  if (seconds < 0) seconds = 0;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const clock = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

/* ---------------------------------------------------------------- setup */

async function loadMixes() {
  const { mixes } = await api("/api/mixes");
  state.mixes = mixes;
  const select = $("mix-select");
  select.innerHTML = "";
  const primary = mixes.filter((m) => m.isPrimary);
  const others = mixes.filter((m) => !m.isPrimary);
  if (primary.length && others.length) {
    const g1 = document.createElement("optgroup");
    g1.label = "Main mixes";
    primary.forEach((m) => g1.append(new Option(m.displayName, m.name)));
    const g2 = document.createElement("optgroup");
    g2.label = "More";
    others.forEach((m) => g2.append(new Option(m.displayName, m.name)));
    select.append(g1, g2);
  } else {
    mixes.forEach((m) => select.append(new Option(m.displayName, m.name)));
  }
  select.addEventListener("change", () => loadSongs(select.value));
}

async function loadSongs(mix) {
  $("song-list").innerHTML = '<div class="muted loading">Loading songs...</div>';
  try {
    state.catalog = await api(`/api/songs?mix=${encodeURIComponent(mix)}`);
  } catch (err) {
    $("song-list").innerHTML = "";
    showError("setup-error", err.message);
    return;
  }
  state.selected.clear();
  renderSongList("");
}

function matches(song, q) {
  return !q || song.name.toLowerCase().includes(q) || (song.artist || "").toLowerCase().includes(q);
}

function renderSongList(query) {
  const list = $("song-list");
  list.innerHTML = "";
  const q = query.trim().toLowerCase();
  const songs = (state.catalog?.songs || []).filter((s) => matches(s, q));
  if (!songs.length) {
    list.innerHTML = '<div class="muted">No songs match.</div>';
    updateSongCount();
    return;
  }
  for (const song of songs) {
    const label = document.createElement("label");
    label.className = "song-item" + (state.selected.has(song.name) ? " selected" : "");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.selected.has(song.name);
    input.addEventListener("change", () => {
      if (input.checked) state.selected.add(song.name);
      else state.selected.delete(song.name);
      label.classList.toggle("selected", input.checked);
      updateSongCount();
    });
    const text = document.createElement("span");
    text.className = "song-name";
    const chartLevels = song.charts
      .map((c) => c.level)
      .filter((l) => l != null)
      .sort((a, b) => b - a);
    text.textContent = song.name;
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent =
      (song.artist ? song.artist + " · " : "") +
      (chartLevels.length ? `S${chartLevels[0]}` : song.type || "");
    label.append(input, text, meta);
    list.append(label);
  }
  updateSongCount();
}

function updateSongCount() {
  const n = state.selected.size;
  $("song-count").textContent = n ? `· ${n} selected` : "";
  $("start-btn").disabled = n === 0;
}

/* ---------------------------------------------------------------- sprint */

function selectedDuration() {
  const w = parseInt($("duration-weeks").value || "0", 10);
  return w * 604800;
}

async function startSprint({ mix, songs, durationSeconds }) {
  hideError("setup-error");
  try {
    const { sprint } = await api("/api/sprint", {
      method: "POST",
      body: JSON.stringify({ mix, songs, durationSeconds }),
    });
    enterActive(sprint);
  } catch (err) {
    showError("setup-error", err.message);
  }
}

function enterActive(sprint) {
  state.sprint = sprint;
  state.finished = false;
  $("active-mix").textContent = sprint.mix;
  renderChips(sprint.songs);
  showView("active");
  tickTimer();
  clearInterval(state.timerHandle);
  state.timerHandle = setInterval(tickTimer, 250);
  clearInterval(state.scoresHandle);
  refreshActiveScores();
  state.scoresHandle = setInterval(refreshActiveScores, 20000);
}

function renderChips(songs) {
  const wrap = $("song-chips");
  wrap.innerHTML = "";
  for (const song of songs) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = song;
    wrap.append(chip);
  }
}

function sprintEndMs(sprint) {
  return Date.parse(sprint.startedAt) + sprint.durationSeconds * 1000;
}

function tickTimer() {
  const sprint = state.sprint;
  if (!sprint) return;
  const now = Date.now() + state.serverOffsetMs;
  const end = sprintEndMs(sprint);
  const remaining = (end - now) / 1000;
  const total = sprint.durationSeconds;
  $("timer").textContent = fmtDuration(Math.ceil(remaining));
  const pct = Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
  $("progress-bar").style.width = `${pct}%`;
  if (remaining <= 0 && !state.finished) {
    state.finished = true;
    $("timer").textContent = "00:00:00";
    finishSprint();
  }
}

async function refreshActiveScores() {
  if (!state.sprint || state.finished) return;
  try {
    const data = await api("/api/sprint/scores");
    const plays = data.plays || [];
    $("active-plays").textContent = `${plays.length} play${plays.length === 1 ? "" : "s"} so far`;
    $("active-status").textContent = "Scores syncing with PIU Scores";
    for (const [song, sum] of Object.entries(data.summary || {})) {
      const chip = [...document.querySelectorAll("#song-chips .chip")].find(
        (c) => c.textContent === song
      );
      if (chip && sum.attempts > 0) {
        const best = sum.bestScore != null ? sum.bestScore.toLocaleString() : "—";
        chip.textContent = `${song} · ${sum.attempts}× · best ${best}`;
        chip.classList.add("played");
      }
    }
  } catch (err) {
    $("active-status").textContent = "Score sync failed: " + err.message;
  }
}

async function finishSprint() {
  clearInterval(state.timerHandle);
  clearInterval(state.scoresHandle);
  // Confirm end state server-side (marks completed if naturally expired).
  try {
    const { sprint } = await api("/api/sprint");
    state.sprint = sprint;
  } catch {
    /* keep local sprint */
  }
  await showResults();
}

async function showResults() {
  showView("results");
  $("plays-table").innerHTML = '<div class="muted loading">Loading your plays...</div>';
  try {
    const data = await api("/api/sprint/scores");
    state.sprint = data.sprint;
    renderResults(data);
  } catch (err) {
    showError("result-error", "Could not load scores: " + err.message);
    $("plays-table").innerHTML = "";
  }
}

function renderResults(data) {
  const sprint = data.sprint;
  const early = sprint.status === "ended_early";
  $("results-title").textContent = early ? "SPRINT ENDED" : "SPRINT COMPLETE";
  $("results-sub").textContent =
    `${sprint.mix} · ${fmtDuration(sprint.durationSeconds)} · ` +
    `${(data.plays || []).length} plays` +
    (data.graceMinutes ? ` · includes plays arriving up to ${data.graceMinutes} min after the end` : "");

  const grid = $("results-summary");
  grid.innerHTML = "";
  for (const [song, sum] of Object.entries(data.summary || {})) {
    const card = document.createElement("div");
    card.className = "result-card" + (sum.attempts ? " played" : "");
    const best = sum.bestScore != null ? sum.bestScore.toLocaleString() : "—";
    const grade = sum.bestGrade ? ` (${sum.bestGrade}${sum.bestPlate ? " · " + sum.bestPlate : ""})` : "";
    card.innerHTML = `
      <div class="result-song">${escapeHtml(song)}</div>
      <div class="result-best">${escapeHtml(best)}<span class="muted">${escapeHtml(grade)}</span></div>
      <div class="muted">${sum.attempts} attempt${sum.attempts === 1 ? "" : "s"} · ${sum.passes} pass${sum.passes === 1 ? "" : "es"}</div>
    `;
    grid.append(card);
  }

  const table = $("plays-table");
  table.innerHTML = "";
  const plays = data.plays || [];
  if (!plays.length) {
    table.innerHTML =
      '<div class="muted">No plays recorded during this sprint window. ' +
      "PIU Scores learns plays at import time — make sure your cab results were synced.</div>";
    return;
  }
  const rows = plays.map((p) => {
    const jd = p.judgments || {};
    const judgments = [
      jd.perfects, jd.greats, jd.goods, jd.bads, jd.misses,
    ].every((v) => v == null) ? "" : `P${jd.perfects ?? 0} G${jd.greats ?? 0} ${jd.goods ?? 0}/${jd.bads ?? 0}/${jd.misses ?? 0}`;
    const cls = p.isStageBroken ? "stage-broken" : p.isBroken ? "broken" : "passed";
    return `
      <div class="play-row ${cls}">
        <span class="play-song">${escapeHtml(p.songName)}</span>
        <span class="muted">S${p.level ?? "?"} ${escapeHtml(p.chartType || "")} ${escapeHtml(p.difficulty || "")}</span>
        <span class="play-score">${p.score != null ? escapeHtml(p.score.toLocaleString()) : "—"}</span>
        <span>${escapeHtml(p.letterGrade || "")} ${escapeHtml(p.plate || "")}</span>
        <span class="muted">${escapeHtml(judgments)}</span>
        <span class="muted">${p.isBest ? "★ best" : ""}</span>
      </div>`;
  });
  table.innerHTML = rows.join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  showView("boot");
  try {
    const health = await api("/api/health");
    if (!health.ok) {
      showView("setup");
      showError("setup-error", health.error);
      return;
    }
  } catch {
    showView("setup");
    showError("setup-error", "Cannot reach the app backend.");
    return;
  }
  try {
    const { sprint, serverNow } = await api("/api/sprint");
    state.serverOffsetMs = Date.parse(serverNow) - Date.now();
    if (sprint && sprint.status === "active") {
      const endMs = sprintEndMs(sprint);
      if (endMs <= Date.now() + state.serverOffsetMs) {
        state.sprint = sprint;
        state.finished = true;
        await finishSprint();
        return;
      }
      enterActive(sprint);
      return;
    }
    if (sprint) {
      // A past sprint exists — show its results with the "create another" prompt.
      state.sprint = sprint;
      await showResults();
      return;
    }
  } catch {
    /* fall through to setup */
  }
  showView("setup");
  try {
    await loadMixes();
    if (state.mixes.length) await loadSongs($("mix-select").value);
  } catch (err) {
    showError("setup-error", err.message);
  }
}

/* ---------------------------------------------------------------- events */

$("setup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const duration = selectedDuration();
  if (!duration) {
    showError("setup-error", "Set a sprint length.");
    return;
  }
  if (state.selected.size === 0) {
    showError("setup-error", "Pick at least one song.");
    return;
  }
  startSprint({
    mix: $("mix-select").value,
    songs: [...state.selected],
    durationSeconds: duration,
  });
});

$("song-search").addEventListener("input", (e) => renderSongList(e.target.value));
$("select-all").addEventListener("click", () => {
  const q = $("song-search").value.trim().toLowerCase();
  (state.catalog?.songs || []).forEach((s) => {
    if (matches(s, q)) state.selected.add(s.name);
  });
  renderSongList(q);
});
$("clear-all").addEventListener("click", () => {
  state.selected.clear();
  renderSongList($("song-search").value);
});
document.querySelectorAll(".presets button").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("duration-weeks").value = btn.dataset.weeks;
  });
});
$("end-early-btn").addEventListener("click", async () => {
  clearInterval(state.timerHandle);
  clearInterval(state.scoresHandle);
  try {
    const { sprint } = await api("/api/sprint/end", { method: "POST" });
    state.sprint = sprint;
  } catch (err) {
    showError("active-error", err.message);
  }
  await showResults();
});
$("new-sprint-btn").addEventListener("click", async () => {
  showView("setup");
  hideError("setup-error");
  try {
    if (!state.mixes.length) await loadMixes();
    if ($("mix-select").value) await loadSongs($("mix-select").value);
  } catch (err) {
    showError("setup-error", err.message);
  }
});
$("repeat-sprint-btn").addEventListener("click", () => {
  const s = state.sprint;
  if (!s) return;
  startSprint({ mix: s.mix, songs: s.songs, durationSeconds: s.durationSeconds });
});

boot();