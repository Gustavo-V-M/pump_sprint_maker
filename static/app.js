/* Pump Sprints — front-end controller */

const $ = (id) => document.getElementById(id);

const state = {
  catalog: null, // { songs: [{name, charts: [...]}], byId: {id: chart} }
  selected: new Set(), // chart ids
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

async function loadCharts() {
  const data = await api("/api/charts");
  const byId = {};
  for (const s of data.songs) {
    for (const c of s.charts) byId[c.id] = { ...c, song: s.name };
  }
  state.catalog = { songs: data.songs, byId };
  const songSelect = $("song-select");
  songSelect.innerHTML = "";
  for (const s of data.songs) songSelect.append(new Option(s.name, s.name));
  fillChartSelect();
}

function fillChartSelect() {
  const chartSelect = $("chart-select");
  chartSelect.innerHTML = "";
  const song = (state.catalog?.songs || []).find((s) => s.name === $("song-select").value);
  if (!song) {
    chartSelect.disabled = true;
    $("add-chart-btn").disabled = true;
    return;
  }
  for (const c of song.charts) chartSelect.append(new Option(`${c.type}${c.level}`, c.id));
  chartSelect.disabled = false;
  $("add-chart-btn").disabled = false;
}

function addChart() {
  const id = $("chart-select").value;
  if (!id || state.selected.has(id)) return;
  state.selected.add(id);
  renderSelectedCharts();
}

function removeChart(id) {
  state.selected.delete(id);
  renderSelectedCharts();
}

function renderSelectedCharts() {
  const wrap = $("selected-charts");
  wrap.innerHTML = "";
  for (const id of state.selected) {
    const c = state.catalog.byId[id];
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.append(Object.assign(document.createElement("span"), { textContent: `${c.song} · ${c.type}${c.level}` }));
    const x = document.createElement("button");
    x.type = "button";
    x.className = "chip-remove";
    x.textContent = "×";
    x.addEventListener("click", () => removeChart(id));
    chip.append(x);
    wrap.append(chip);
  }
  $("chart-count").textContent = state.selected.size ? `· ${state.selected.size} selected` : "";
  $("start-btn").disabled = state.selected.size === 0;
}

/* ---------------------------------------------------------------- sprint */

function selectedDuration() {
  const w = parseInt($("duration-weeks").value || "0", 10);
  return w * 604800;
}

async function startSprint({ charts, durationSeconds }) {
  hideError("setup-error");
  try {
    const { sprint } = await api("/api/sprint", {
      method: "POST",
      body: JSON.stringify({ charts, durationSeconds }),
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
  showView("active");
  tickTimer();
  clearInterval(state.timerHandle);
  state.timerHandle = setInterval(tickTimer, 250);
  clearInterval(state.scoresHandle);
  refreshActiveScores();
  state.scoresHandle = setInterval(refreshActiveScores, 20000);
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
    renderScoreGrid(data);
  } catch (err) {
    $("active-status").textContent = "Score sync failed: " + err.message;
  }
}

function localDayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function buildGrid(data) {
  const charts = [...(data.charts || [])].sort(
    (a, b) =>
      (a.type === "S" ? 0 : 1) - (b.type === "S" ? 0 : 1) ||
      a.song.localeCompare(b.song) ||
      a.type.localeCompare(b.type) ||
      a.level - b.level
  );
  const days = [];
  const best = new Map(); // chartId -> Map(dayKey -> {score, broken})
  for (const p of data.plays || []) {
    if (p.score == null || !p.occurredAt) continue;
    const key = localDayKey(p.occurredAt);
    if (!days.includes(key)) days.push(key);
    const byDay = best.get(p.chartId) || new Map();
    best.set(p.chartId, byDay);
    const cur = byDay.get(key);
    const broken = !!p.isBroken || !!p.isStageBroken;
    // A passing score always beats a broken one on the same day.
    if (!cur || (cur.broken && !broken) || (cur.broken === broken && p.score > cur.score)) {
      byDay.set(key, { score: p.score, broken });
    }
  }
  days.sort();
  const rows = charts.map((c) => {
    const byDay = best.get(c.id) || new Map();
    const cells = days.map((d) => {
      const v = byDay.get(d);
      return v ? { score: v.score, broken: v.broken } : null;
    });
    const rowBest = Math.max(...cells.filter(Boolean).map((v) => v.score), -1);
    return { song: c.song, chart: `${c.type}${c.level}`, cells, rowBest };
  });
  return { days, rows };
}

function renderScoreGrid(data) {
  const { days, rows } = buildGrid(data);
  const head = `<tr><th>Song</th><th>Chart</th>${days
    .map((d) => `<th>${escapeHtml(dayLabel(d))}</th>`)
    .join("")}</tr>`;
  const body = rows
    .map((r) => {
      const cells = r.cells
        .map((v) => {
          if (v == null) return "<td></td>";
          const cls = [v.broken && "broken", v.score === r.rowBest && "best"].filter(Boolean).join(" ");
          return `<td${cls ? ` class="${cls}"` : ""}>${v.score}</td>`;
        })
        .join("");
      return `<tr><td>${escapeHtml(r.song)}</td><td>${escapeHtml(r.chart)}</td>${cells}</tr>`;
    })
    .join("");
  $("score-grid").innerHTML = head + body;
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
        <span class="muted">${escapeHtml((p.chartType || "") + String(p.level ?? "?"))}</span>
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
    await loadCharts();
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
    showError("setup-error", "Pick at least one chart.");
    return;
  }
  startSprint({
    charts: [...state.selected],
    durationSeconds: duration,
  });
});

document.querySelectorAll(".presets button").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("duration-weeks").value = btn.dataset.weeks;
  });
});
$("song-select").addEventListener("change", fillChartSelect);
$("add-chart-btn").addEventListener("click", addChart);
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
    if (!state.catalog) await loadCharts();
  } catch (err) {
    showError("setup-error", err.message);
  }
});
$("repeat-sprint-btn").addEventListener("click", () => {
  const s = state.sprint;
  if (!s) return;
  startSprint({ charts: s.charts, durationSeconds: s.durationSeconds });
});

boot();