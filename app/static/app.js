const QUADRANTS = [
  { id: "do", title: "Do", important: true, urgent: true },
  { id: "schedule", title: "Schedule", important: true, urgent: false },
  { id: "handoff", title: "Hand off", important: false, urgent: true },
  { id: "later", title: "Later", important: false, urgent: false },
];

const state = {
  streams: [],
  tasks: [],
  events: [],
  calendars: [],
  weekWarnings: [],
  weekStart: mondayISO(new Date()),
  filterStreamId: null,
  doneOpen: false,
  editingTaskId: null,
  editingStreamId: null,
  editingTimeId: null,
  planningTaskId: null,
  deletingStreamId: null,
  timeEntries: [],
  weekReady: false,
  settings: { app_name: "Machtls-Planner", calendars: [] },
};

let drag = null;
let suppressClick = false;

const $ = (selector) => document.querySelector(selector);

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isoDate(day) {
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return `${day.getFullYear()}-${month}-${date}`;
}

function parseISO(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function mondayISO(day) {
  const copy = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const weekday = copy.getDay();
  const shift = weekday === 0 ? -6 : 1 - weekday;
  copy.setDate(copy.getDate() + shift);
  return isoDate(copy);
}

function quadrantOf(task) {
  return QUADRANTS.find((quadrant) => quadrant.important === task.important && quadrant.urgent === task.urgent);
}

function priority(task) {
  if (task.important && task.urgent) return 0;
  if (task.important) return 1;
  if (task.urgent) return 2;
  return 3;
}

function streamById(id) {
  return state.streams.find((stream) => stream.id === id);
}

function activeStreams() {
  return state.streams.filter((stream) => !stream.archived);
}

function isLiveTask(task) {
  const stream = streamById(task.stream_id);
  return Boolean(stream && !stream.archived);
}

function visibleTasks(status) {
  return state.tasks.filter((task) => {
    if (task.status !== status || !isLiveTask(task)) return false;
    if (state.filterStreamId !== null && task.stream_id !== state.filterStreamId) return false;
    return true;
  });
}

function applyAppName(name) {
  const title = name || "Machtls-Planner";
  document.title = title;
  const heading = $("#app-title");
  if (heading) heading.textContent = title;
  const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (meta) meta.content = title;
}

function renderCalendarSettings() {
  const list = $("#calendar-settings");
  const calendars = state.settings.calendars || [];
  list.innerHTML = calendars.length
    ? calendars.map((calendar) => `
      <li>
        <span class="dot" style="--c:${esc(calendar.color)}"></span>
        <span>${esc(calendar.name)}</span>
        <button type="button" class="btn ghost" data-remove-calendar="${calendar.id}">Remove</button>
      </li>
    `).join("")
    : `<li class="muted">No calendars yet.</li>`;
}

function openSettings() {
  $("#calendar-error").hidden = true;
  $("#settings-form").elements.app_name.value = state.settings.app_name || "Machtls-Planner";
  renderCalendarSettings();
  $("#settings-dialog").showModal();
}

async function load() {
  const [streamsRes, tasksRes, timeRes, settingsRes] = await Promise.all([
    fetch("/api/streams"),
    fetch("/api/tasks"),
    fetch("/api/time"),
    fetch("/api/settings"),
  ]);
  if (!streamsRes.ok || !tasksRes.ok || !timeRes.ok || !settingsRes.ok) throw new Error("load failed");
  state.streams = await streamsRes.json();
  state.tasks = await tasksRes.json();
  state.timeEntries = await timeRes.json();
  state.settings = await settingsRes.json();
  applyAppName(state.settings.app_name);
  const selected = state.filterStreamId === null ? null : streamById(state.filterStreamId);
  if (!selected || selected.archived) state.filterStreamId = null;
  render();
}

async function loadWeek(refresh = false) {
  const status = $("#week-status");
  status.textContent = "Loading calendars…";
  const data = await api(`/api/week?start=${state.weekStart}${refresh ? "&refresh=true" : ""}`);
  state.weekStart = data.start;
  state.events = data.events;
  state.calendars = data.calendars;
  state.weekWarnings = data.warnings;
  state.weekReady = true;
  renderWeek();
  if (data.warnings.length) toast(data.warnings.join(". "));
}

const SLICE_COLORS = {
  do: "#9d3d2f",
  schedule: "#24598a",
  handoff: "#8a5810",
  later: "#5e655c",
};

function pieSvg(slices, centerLabel) {
  const active = slices.filter((slice) => slice.value > 0);
  const total = active.reduce((sum, slice) => sum + slice.value, 0);
  if (!total) {
    return `<p class="empty">${esc(centerLabel)}</p>`;
  }
  let angle = -Math.PI / 2;
  const paths = active.length === 1
    ? `<circle cx="100" cy="100" r="78" fill="${active[0].color}"/>`
    : active.map((slice) => {
      const sweep = (slice.value / total) * Math.PI * 2;
      const start = angle;
      const end = angle + sweep;
      angle = end;
      const x0 = 100 + 78 * Math.cos(start);
      const y0 = 100 + 78 * Math.sin(start);
      const x1 = 100 + 78 * Math.cos(end);
      const y1 = 100 + 78 * Math.sin(end);
      const large = sweep > Math.PI ? 1 : 0;
      return `<path d="M 100 100 L ${x0} ${y0} A 78 78 0 ${large} 1 ${x1} ${y1} Z" fill="${slice.color}"></path>`;
    }).join("");
  const legend = slices.map((slice) => `
    <li><span class="dot" style="--c:${slice.color}"></span><span>${esc(slice.label)}</span><strong>${slice.value}</strong></li>
  `).join("");
  return `
    <svg class="pie" viewBox="0 0 200 200" role="img" aria-label="${esc(centerLabel)}">
      ${paths}
      <circle cx="100" cy="100" r="46" fill="#fffcf7"/>
      <text x="100" y="96" text-anchor="middle" fill="#1e1a16" font-size="32" font-weight="650">${total}</text>
      <text x="100" y="116" text-anchor="middle" fill="#6f675e" font-size="12">tasks</text>
    </svg>
    <ul class="chart-legend">${legend}</ul>`;
}

function recentDays(count) {
  const days = [];
  const today = new Date();
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    days.push(isoDate(day));
  }
  return days;
}

function completionBars(doneTasks) {
  const days = recentDays(14);
  const counts = days.map((day) => doneTasks.filter((task) => task.completed_on === day).length);
  const peak = Math.max(...counts, 1);
  const columns = days.map((day, index) => {
    const count = counts[index];
    const height = count ? Math.max((count / peak) * 100, 8) : 0;
    const label = day.slice(8);
    return `
      <div class="bar-col" title="${day}: ${count}">
        <span class="bar-count">${count || ""}</span>
        <span class="bar-track"><span class="bar" style="height:${height}%"></span></span>
        <span class="bar-day">${label}</span>
      </div>`;
  }).join("");
  return `
    <div class="chart-card">
      <h3>Completed per day</h3>
      <div class="bars" role="img" aria-label="Tasks completed over the last 14 days">${columns}</div>
    </div>`;
}

function renderCharts() {
  const open = state.tasks.filter((task) => task.status === "open" && isLiveTask(task));
  const done = state.tasks.filter((task) => task.status === "done" && isLiveTask(task));
  const quadrantSlices = QUADRANTS.map((quadrant) => ({
    label: quadrant.title,
    color: SLICE_COLORS[quadrant.id],
    value: open.filter((task) => task.important === quadrant.important && task.urgent === quadrant.urgent).length,
  }));
  $("#stream-pie").innerHTML = `
    <h3>Open</h3>
    ${pieSvg(quadrantSlices, "No open tasks")}
  `;
  const streamSlices = activeStreams().map((stream) => ({
    label: stream.name,
    color: /^#[0-9a-fA-F]{6}$/.test(stream.color) ? stream.color : "#6f675e",
    value: done.filter((task) => task.stream_id === stream.id).length,
  }));
  $("#done-charts").innerHTML = `
    <div class="chart-card">
      <h3>Done</h3>
      ${pieSvg(streamSlices, "Nothing finished")}
    </div>
    ${completionBars(done)}
  `;
}

function render() {
  renderFilters();
  renderMatrix();
  renderStreams();
  renderCharts();
  renderWeek();
  renderDone();
  renderGraveyard();
  const selected = state.filterStreamId === null ? null : streamById(state.filterStreamId);
  $("#matrix-scope").textContent = selected ? selected.name : "All streams";
}

function renderFilters() {
  const chips = [
    `<button type="button" class="chip ${state.filterStreamId === null ? "is-on" : ""}" data-filter="all">All</button>`,
  ];
  for (const stream of activeStreams()) {
    const on = state.filterStreamId === stream.id ? "is-on" : "";
    chips.push(
      `<button type="button" class="chip ${on}" data-filter="${stream.id}"><span class="dot" style="--c:${esc(stream.color)}"></span>${esc(stream.name)}</button>`,
    );
  }
  $("#filters").innerHTML = chips.join("");
}

function cardHtml(task) {
  const stream = streamById(task.stream_id);
  const name = stream ? stream.name : "Stream";
  const color = stream ? stream.color : "#6f675e";
  const note = task.note ? `<p class="card-note">${esc(task.note)}</p>` : "";
  return `
    <article class="card" data-task-id="${task.id}" style="--c:${esc(color)}">
      <button type="button" class="drag-handle" data-drag aria-label="Move ${esc(task.title)}"></button>
      <button type="button" class="card-body" data-open-task="${task.id}">
        <span class="stream-pill">${esc(name)}</span>
        <strong>${esc(task.title)}</strong>
        ${note}
      </button>
      <div class="card-actions">
        <button type="button" class="icon-btn plan-btn" data-plan="${task.id}" aria-label="Plan ${esc(task.title)}">!</button>
        <button type="button" class="icon-btn" data-done="${task.id}" aria-label="Mark done">✓</button>
      </div>
    </article>`;
}

function taskChip(task) {
  const stream = streamById(task.stream_id);
  const color = stream ? stream.color : "#6f675e";
  const hint = planHint(task);
  return `
    <article class="chip-task" data-task-id="${task.id}" style="--c:${esc(color)}">
      <button type="button" class="drag-handle" data-drag aria-label="Move ${esc(task.title)}"></button>
      <button type="button" class="chip-label" data-open-task="${task.id}">
        <strong>${esc(task.title)}</strong>
        ${hint ? `<span class="plan-hint">${esc(hint)}</span>` : ""}
      </button>
      <div class="card-actions">
        <button type="button" class="icon-btn plan-btn" data-plan="${task.id}" aria-label="Plan ${esc(task.title)}">!</button>
        <button type="button" class="icon-btn" data-done="${task.id}" aria-label="Mark done">✓</button>
      </div>
    </article>`;
}

function miniCard(task) {
  const stream = streamById(task.stream_id);
  const color = stream ? stream.color : "#6f675e";
  return `
    <article class="mini-card" data-task-id="${task.id}" style="--c:${esc(color)}">
      <button type="button" class="drag-handle" data-drag aria-label="Move ${esc(task.title)}"></button>
      <button type="button" class="mini-label" data-open-task="${task.id}">${esc(task.title)}</button>
      <button type="button" class="icon-btn plan-btn" data-plan="${task.id}" aria-label="Plan ${esc(task.title)}">!</button>
    </article>`;
}

function quadrantSection(quadrant, tasks, mini) {
  const cards = tasks.map(mini ? miniCard : cardHtml).join("");
  const body = cards || (mini ? "" : `<p class="empty">Empty</p>`);
  const title = mini ? `<h3>${quadrant.title}</h3>` : `<h2>${quadrant.title}</h2>`;
  return `
    <section class="${mini ? "mini-quadrant" : "quadrant"} quadrant-${quadrant.id}" data-drop-quadrant="${quadrant.id}">
      ${title}
      <div class="cards">${body}</div>
    </section>`;
}

function renderMatrix() {
  const open = visibleTasks("open");
  const cell = (id) => {
    const quadrant = QUADRANTS.find((item) => item.id === id);
    const tasks = open.filter((task) => task.important === quadrant.important && task.urgent === quadrant.urgent);
    return quadrantSection(quadrant, tasks, false);
  };
  $("#matrix").innerHTML = `
    <div class="axis-corner"></div>
    <div class="axis-col">Urgent</div>
    <div class="axis-col">Not urgent</div>
    <div class="axis-row">Important</div>
    ${cell("do")}
    ${cell("schedule")}
    <div class="axis-row">Not important</div>
    ${cell("handoff")}
    ${cell("later")}
  `;
}

function renderStreams() {
  const streams = activeStreams();
  if (!streams.length) {
    $("#stream-list").innerHTML = `<p class="empty">Add a stream to start.</p>`;
    return;
  }
  $("#stream-list").innerHTML = streams.map((stream) => {
    const open = state.tasks.filter((task) => task.stream_id === stream.id && task.status === "open");
    const on = state.filterStreamId === stream.id ? "is-on" : "";
    const matrixOn = stream.show_matrix ? "is-on" : "";
    const mini = stream.show_matrix
      ? `<div class="mini-matrix">${QUADRANTS.map((quadrant) => {
          const tasks = open.filter((task) => task.important === quadrant.important && task.urgent === quadrant.urgent);
          return quadrantSection(quadrant, tasks, true);
        }).join("")}</div>`
      : "";
    return `
      <article class="stream ${on}" data-drop-stream="${stream.id}">
        <div class="stream-top">
          <button type="button" class="stream-select" data-filter="${stream.id}">
            <span class="dot" style="--c:${esc(stream.color)}"></span>
            <span class="stream-name">${esc(stream.name)}</span>
            <span class="muted">${open.length} open</span>
          </button>
          <div class="stream-actions">
            <button type="button" class="btn" data-add-task="${stream.id}">Add</button>
            <button type="button" class="btn ghost" data-rename-stream="${stream.id}">Rename</button>
            <button type="button" class="btn ${matrixOn}" data-matrix-toggle="${stream.id}">Matrix</button>
            <button type="button" class="btn ghost" data-delete-stream="${stream.id}">Delete</button>
          </div>
        </div>
        ${mini}
      </article>`;
  }).join("");
}

const CLOCK_START = 6 * 60;
const CLOCK_END = 20 * 60;

function placeOnClock(events) {
  const items = events
    .filter((event) => !event.all_day && event.end_min > CLOCK_START && event.start_min < CLOCK_END)
    .map((event) => ({
      ...event,
      viewStart: Math.max(event.start_min, CLOCK_START),
      viewEnd: Math.min(Math.max(event.end_min, event.start_min + 15), CLOCK_END),
    }))
    .sort((a, b) => a.viewStart - b.viewStart || b.viewEnd - a.viewEnd);
  const columnEnds = [];
  for (const item of items) {
    let column = columnEnds.findIndex((end) => end <= item.viewStart);
    if (column < 0) {
      column = columnEnds.length;
      columnEnds.push(item.viewEnd);
    } else {
      columnEnds[column] = item.viewEnd;
    }
    item.column = column;
  }
  const total = Math.max(columnEnds.length, 1);
  return items.map((item) => ({ ...item, total }));
}

function eventCard(event) {
  return `
    <div class="event" style="--c:${esc(event.color)}">
      <time>${esc(event.time)} · ${esc(event.calendar)}</time>
      <strong>${esc(event.title)}</strong>
    </div>`;
}

function renderWeek() {
  const start = parseISO(state.weekStart);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const format = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
  $("#week-title").textContent = `${format.format(start)} – ${format.format(end)}`;
  const status = $("#week-status");
  if (!state.weekReady) {
    status.textContent = "Loading calendars…";
  } else if (state.weekWarnings.length) {
    status.textContent = state.weekWarnings.join(". ");
  } else if (!state.events.length) {
    status.textContent = "No calendar events this week.";
  } else {
    status.textContent = "";
  }
  $("#week-legend").innerHTML = state.calendars
    .map((calendar) => `<span><span class="dot" style="--c:${esc(calendar.color)}"></span>${esc(calendar.name)}</span>`)
    .join("");
  const today = isoDate(new Date());
  const headers = [];
  const notes = [];
  const clocks = [];
  const hourMarks = [];
  for (let hour = 6; hour <= 20; hour += 1) {
    const top = ((hour - 6) / 14) * 100;
    hourMarks.push(`<span style="top:${top}%">${String(hour).padStart(2, "0")}:00</span>`);
  }
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const key = isoDate(day);
    const name = day.toLocaleDateString("en", { weekday: "short" });
    const events = state.events.filter((event) => event.day === key);
    const tasks = state.tasks
      .filter((task) => task.status === "open" && task.scheduled_on === key && isLiveTask(task))
      .sort((a, b) => priority(a) - priority(b) || a.id - b.id);
    const parked = events.filter((event) => event.all_day || event.end_min <= CLOCK_START || event.start_min >= CLOCK_END);
    const clockTasks = tasks.filter(onClock).map((task) => {
      const stream = streamById(task.stream_id);
      return {
        kind: "task",
        taskId: task.id,
        title: task.title,
        color: stream ? stream.color : "#6f675e",
        time: `${task.plan_start}–${task.plan_end}`,
        all_day: false,
        start_min: clockToMin(task.plan_start),
        end_min: clockToMin(task.plan_end),
      };
    });
    const placed = placeOnClock([...events, ...clockTasks]);
    const noteHtml = [
      ...parked.map(eventCard),
      ...tasks.filter((task) => !onClock(task)).map(taskChip),
    ].join("");
    const blockHtml = placed.map((event) => {
      const top = ((event.viewStart - CLOCK_START) / 60) * 36;
      const height = Math.max(((event.viewEnd - event.viewStart) / 60) * 36, 18);
      const width = 100 / event.total;
      const left = event.column * width;
      const style = `--c:${esc(event.color)};top:${top}px;height:${height}px;left:${left}%;width:${width}%`;
      if (event.kind === "task") {
        return `
          <button type="button" class="event event-block task-block" data-plan="${event.taskId}" style="${style}">
            <time>${esc(event.time)}</time>
            <strong>${esc(event.title)}</strong>
          </button>`;
      }
      return `
        <div class="event event-block" style="${style}">
          <time>${esc(event.time)}</time>
          <strong>${esc(event.title)}</strong>
        </div>`;
    }).join("");
    const tone = key === today ? "is-today" : key < today ? "is-past" : "";
    headers.push(`
      <header class="day-head ${tone}" data-drop-day="${key}">
        <span>${name}</span><strong>${day.getDate()}</strong>
      </header>`);
    notes.push(`
      <div class="day-notes ${tone}" data-drop-day="${key}">${noteHtml}</div>`);
    clocks.push(`
      <div class="hours ${tone}" data-drop-day="${key}">
        ${Array.from({ length: 14 }, () => `<div class="hour-slot"></div>`).join("")}
        ${blockHtml}
      </div>`);
  }
  $("#week-grid").innerHTML = `
    <div class="week-board">
      <div class="gutter-corner"></div>
      ${headers.join("")}
      <div class="gutter-all">All day</div>
      ${notes.join("")}
      <div class="hour-gutter">${hourMarks.join("")}</div>
      ${clocks.join("")}
    </div>`;
  const waiting = state.tasks
    .filter((task) => task.status === "open" && !task.scheduled_on && isLiveTask(task))
    .sort((a, b) => priority(a) - priority(b) || a.id - b.id);
  const openLeft = state.tasks.some((task) => task.status === "open" && isLiveTask(task));
  $("#builder-list").innerHTML = waiting.length
    ? waiting.map(taskChip).join("")
    : `<p class="empty">${openLeft ? "Every open task is on a day." : "Add a task in a stream, then drag it onto a day."}</p>`;
  renderTime();
}

function clockToMin(value) {
  const [hour, minute] = String(value).split(":").map(Number);
  return hour * 60 + minute;
}

function onClock(task) {
  if (!task.plan_start || !task.plan_end) return false;
  const start = clockToMin(task.plan_start);
  const end = clockToMin(task.plan_end);
  return end > CLOCK_START && start < CLOCK_END;
}

function planHint(task) {
  if (task.plan_start && task.plan_end) return `${task.plan_start}–${task.plan_end}`;
  if (task.estimate_min) return formatHours(task.estimate_min);
  return "";
}

function formatHours(minutes) {
  const hours = minutes / 60;
  const text = Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 100) / 100);
  return `${text} h`;
}

function renderTime() {
  const start = parseISO(state.weekStart);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const format = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
  $("#time-range").textContent = `${format.format(start)} – ${format.format(end)}`;
  const today = isoDate(new Date());
  const columns = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const key = isoDate(day);
    const name = day.toLocaleDateString("en", { weekday: "short" });
    const entries = state.timeEntries
      .filter((entry) => entry.day === key)
      .sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id);
    const tone = key === today ? "is-today" : key < today ? "is-past" : "";
    const rows = entries.map((entry) => {
      const stream = entry.stream_id ? streamById(entry.stream_id) : null;
      const color = stream ? stream.color : "#6f675e";
      const label = stream ? stream.name : "No stream";
      return `
        <button type="button" class="time-entry" data-open-time="${entry.id}" style="--c:${esc(color)}">
          <strong>${esc(entry.note)}</strong>
          <span>${esc(entry.start)}–${esc(entry.end)} · ${esc(label)}</span>
        </button>`;
    }).join("");
    columns.push(`
      <article class="time-day ${tone}">
        <header><span>${name}</span><strong>${day.getDate()}</strong></header>
        <div class="time-entries">${rows}</div>
        <div class="time-sums">${streamSums(entries)}</div>
        <button type="button" class="btn time-add" data-add-time="${key}">Add</button>
      </article>`);
  }
  $("#time-grid").innerHTML = `<div class="time-board">${columns.join("")}</div>`;
}

function streamSums(entries) {
  const totals = new Map();
  for (const entry of entries) {
    const key = entry.stream_id ?? "none";
    totals.set(key, (totals.get(key) || 0) + entry.minutes);
  }
  const lines = [];
  for (const stream of state.streams) {
    if (!totals.has(stream.id)) continue;
    lines.push({ name: stream.name, color: stream.color, minutes: totals.get(stream.id) });
    totals.delete(stream.id);
  }
  if (totals.has("none")) {
    lines.push({ name: "No stream", color: "#6f675e", minutes: totals.get("none") });
  }
  if (!lines.length) return "";
  return lines.map((line) => `
    <p class="time-sum">
      <span class="dot" style="--c:${esc(line.color)}"></span>
      <span>${esc(line.name)}</span>
      <strong>${formatHours(line.minutes)}</strong>
    </p>`).join("");
}

function renderGraveyard() {
  const parked = state.streams.filter((stream) => stream.archived);
  if (!parked.length) {
    $("#graveyard-list").innerHTML = `<p class="empty">The graveyard is empty.</p>`;
    return;
  }
  $("#graveyard-list").innerHTML = parked.map((stream) => {
    const tasks = state.tasks.filter((task) => task.stream_id === stream.id);
    const items = tasks.length
      ? `<ul class="grave-tasks">${tasks.map((task) => `<li>${esc(task.title)}</li>`).join("")}</ul>`
      : `<p class="empty">No tasks</p>`;
    return `
      <article class="grave-card">
        <div class="stream-top">
          <span class="stream-select">
            <span class="dot" style="--c:${esc(stream.color)}"></span>
            <span class="stream-name">${esc(stream.name)}</span>
            <span class="muted">${tasks.length}</span>
          </span>
          <div class="stream-actions">
            <button type="button" class="btn" data-restore-stream="${stream.id}">Restore</button>
            <button type="button" class="btn ghost" data-delete-stream="${stream.id}">Delete</button>
          </div>
        </div>
        ${items}
      </article>`;
  }).join("");
}

function renderDone() {
  const done = visibleTasks("done");
  $("#done-count").textContent = String(done.length);
  $("#done-toggle").textContent = state.doneOpen ? "Hide" : "Show";
  const list = $("#done-list");
  list.hidden = !state.doneOpen;
  if (!done.length) {
    const where = state.filterStreamId === null ? "" : " in this stream";
    list.innerHTML = `<p class="empty">Nothing finished${where}.</p>`;
    return;
  }
  list.innerHTML = done.map((task) => {
    const stream = streamById(task.stream_id);
    return `
      <article class="done-row">
        <div>
          <strong>${esc(task.title)}</strong>
          <span class="muted">${esc(stream ? stream.name : "")}</span>
        </div>
        <button type="button" class="btn" data-reopen="${task.id}">Reopen</button>
        <button type="button" class="btn ghost" data-delete-task="${task.id}">Delete</button>
      </article>`;
  }).join("");
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }
  return data;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 3600);
}

function fillStreamSelect(selectedId) {
  const select = $("#task-form").elements.stream_id;
  const streams = state.streams.filter((stream) => !stream.archived || stream.id === selectedId);
  select.innerHTML = streams
    .map((stream) => `<option value="${stream.id}">${esc(stream.name)}</option>`)
    .join("");
  if (selectedId) select.value = String(selectedId);
}

function fillTimeStreamSelect(selectedId) {
  const select = $("#time-form").elements.stream_id;
  const streams = state.streams.filter((stream) => !stream.archived || stream.id === selectedId);
  select.innerHTML = `<option value="">No stream</option>${streams
    .map((stream) => `<option value="${stream.id}">${esc(stream.name)}</option>`)
    .join("")}`;
  select.value = selectedId ? String(selectedId) : "";
}

function updateLanding() {
  const form = $("#task-form");
  $("#landing").textContent = `Lands in ${quadrantOf({
    important: form.elements.important.checked,
    urgent: form.elements.urgent.checked,
  }).title}`;
}

function openTaskDialog(task, streamId) {
  const form = $("#task-form");
  $("#task-error").hidden = true;
  state.editingTaskId = task ? task.id : null;
  form.reset();
  fillStreamSelect(task ? task.stream_id : streamId);
  if (task) {
    $("#task-dialog-title").textContent = "Edit task";
    form.elements.title.value = task.title;
    form.elements.note.value = task.note;
    form.elements.scheduled_on.value = task.scheduled_on || "";
    form.elements.important.checked = task.important;
    form.elements.urgent.checked = task.urgent;
    $("#task-delete").hidden = false;
  } else {
    $("#task-dialog-title").textContent = "Add task";
    $("#task-delete").hidden = true;
  }
  updateLanding();
  $("#task-dialog").showModal();
  form.elements.title.focus();
}

function openStreamDialog(stream) {
  const form = $("#stream-form");
  $("#stream-error").hidden = true;
  state.editingStreamId = stream ? stream.id : null;
  form.reset();
  if (stream) {
    $("#stream-dialog-title").textContent = "Rename stream";
    form.elements.name.value = stream.name;
  } else {
    $("#stream-dialog-title").textContent = "New stream";
  }
  $("#stream-dialog").showModal();
  form.elements.name.focus();
}

function openDeleteStream(stream) {
  state.deletingStreamId = stream.id;
  const count = state.tasks.filter((task) => task.stream_id === stream.id).length;
  const noun = count === 1 ? "1 task is" : `${count} tasks are`;
  $("#delete-stream-title").textContent = `Delete ${stream.name}`;
  $("#delete-stream-copy").textContent = count ? `${noun} in this stream.` : "This stream has no tasks.";
  const purge = $("#purge-stream");
  purge.dataset.armed = "0";
  purge.textContent = "Delete permanently";
  $("#graveyard-stream").hidden = Boolean(stream.archived);
  $("#delete-stream-error").hidden = true;
  $("#delete-stream-dialog").showModal();
}

function openTimeDialog(entry, day) {
  const form = $("#time-form");
  $("#time-error").hidden = true;
  state.editingTimeId = entry ? entry.id : null;
  form.reset();
  fillTimeStreamSelect(entry ? entry.stream_id : null);
  if (entry) {
    $("#time-dialog-title").textContent = "Edit time";
    form.elements.note.value = entry.note;
    form.elements.start.value = entry.start;
    form.elements.end.value = entry.end;
    form.elements.day.value = entry.day;
    $("#time-delete").hidden = false;
  } else {
    $("#time-dialog-title").textContent = "Log time";
    form.elements.start.value = "09:00";
    form.elements.end.value = "10:00";
    form.elements.day.value = day || isoDate(new Date());
    $("#time-delete").hidden = true;
  }
  $("#time-dialog").showModal();
  form.elements.note.focus();
}

function syncPlanMode() {
  const clock = $("#plan-form").elements.mode.value === "clock";
  $("#plan-clock").hidden = !clock;
  $("#plan-estimate").hidden = clock;
}

function openPlanDialog(task) {
  const form = $("#plan-form");
  $("#plan-error").hidden = true;
  state.planningTaskId = task.id;
  form.reset();
  $("#plan-task-name").textContent = task.title;
  form.elements.day.value = task.scheduled_on || isoDate(new Date());
  if (task.plan_start && task.plan_end) {
    form.elements.mode.value = "clock";
    form.elements.start.value = task.plan_start;
    form.elements.end.value = task.plan_end;
  } else if (task.estimate_min) {
    form.elements.mode.value = "estimate";
    form.elements.hours.value = String(task.estimate_min / 60);
  } else {
    form.elements.mode.value = "clock";
    form.elements.start.value = "09:00";
    form.elements.end.value = "10:00";
    form.elements.hours.value = "1";
  }
  if (!task.estimate_min) form.elements.hours.value = form.elements.hours.value || "1";
  $("#plan-clear").hidden = !task.scheduled_on;
  syncPlanMode();
  $("#plan-dialog").showModal();
}

function shiftWeek(days) {
  const start = parseISO(state.weekStart);
  start.setDate(start.getDate() + days);
  state.weekStart = isoDate(start);
  loadWeek().catch((error) => toast(error.message));
}

document.body.addEventListener("click", async (event) => {
  if (suppressClick) {
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  const filter = event.target.closest("[data-filter]");
  if (filter) {
    if (filter.dataset.filter === "all") {
      state.filterStreamId = null;
    } else {
      const next = Number(filter.dataset.filter);
      state.filterStreamId = state.filterStreamId === next ? null : next;
    }
    render();
    return;
  }

  const matrixToggle = event.target.closest("[data-matrix-toggle]");
  if (matrixToggle) {
    const stream = streamById(Number(matrixToggle.dataset.matrixToggle));
    if (!stream) return;
    await run(() => api(`/api/streams/${stream.id}`, {
      method: "PATCH",
      body: JSON.stringify({ show_matrix: !stream.show_matrix }),
    }));
    return;
  }

  const addTask = event.target.closest("[data-add-task]");
  if (addTask) {
    openTaskDialog(null, Number(addTask.dataset.addTask));
    return;
  }

  const plan = event.target.closest("[data-plan]");
  if (plan) {
    const task = state.tasks.find((item) => item.id === Number(plan.dataset.plan));
    if (task) openPlanDialog(task);
    return;
  }

  const openTask = event.target.closest("[data-open-task]");
  if (openTask) {
    const task = state.tasks.find((item) => item.id === Number(openTask.dataset.openTask));
    if (task) openTaskDialog(task);
    return;
  }

  const done = event.target.closest("[data-done]");
  if (done) {
    await run(() => api(`/api/tasks/${done.dataset.done}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done", scheduled_on: null }),
    }));
    return;
  }

  const reopen = event.target.closest("[data-reopen]");
  if (reopen) {
    await run(() => api(`/api/tasks/${reopen.dataset.reopen}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "open" }),
    }));
    return;
  }

  const remove = event.target.closest("[data-delete-task]");
  if (remove) {
    await run(() => api(`/api/tasks/${remove.dataset.deleteTask}`, { method: "DELETE" }));
    return;
  }

  const rename = event.target.closest("[data-rename-stream]");
  if (rename) {
    const stream = streamById(Number(rename.dataset.renameStream));
    if (stream) openStreamDialog(stream);
    return;
  }

  const removeStream = event.target.closest("[data-delete-stream]");
  if (removeStream) {
    const stream = streamById(Number(removeStream.dataset.deleteStream));
    if (stream) openDeleteStream(stream);
    return;
  }

  const restore = event.target.closest("[data-restore-stream]");
  if (restore) {
    await run(() => api(`/api/streams/${restore.dataset.restoreStream}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: false }),
    }));
    return;
  }

  const addTime = event.target.closest("[data-add-time]");
  if (addTime) {
    openTimeDialog(null, addTime.dataset.addTime);
    return;
  }

  const openTime = event.target.closest("[data-open-time]");
  if (openTime) {
    const entry = state.timeEntries.find((item) => item.id === Number(openTime.dataset.openTime));
    if (entry) openTimeDialog(entry);
  }
});

async function run(action) {
  try {
    await action();
    await load();
  } catch (error) {
    toast(error.message);
  }
}

$("#add-stream").addEventListener("click", () => openStreamDialog(null));
$("#done-toggle").addEventListener("click", () => {
  state.doneOpen = !state.doneOpen;
  renderDone();
});
$("#week-prev").addEventListener("click", () => shiftWeek(-7));
$("#week-next").addEventListener("click", () => shiftWeek(7));
$("#time-prev").addEventListener("click", () => shiftWeek(-7));
$("#time-next").addEventListener("click", () => shiftWeek(7));
$("#week-today").addEventListener("click", () => {
  state.weekStart = mondayISO(new Date());
  loadWeek().catch((error) => toast(error.message));
});
$("#time-today").addEventListener("click", () => {
  state.weekStart = mondayISO(new Date());
  loadWeek().catch((error) => toast(error.message));
});
$("#refresh-cal").addEventListener("click", () => {
  loadWeek(true).catch((error) => toast(error.message));
});
$("#fill-week").addEventListener("click", async () => {
  try {
    const result = await api("/api/week/fill", {
      method: "POST",
      body: JSON.stringify({ start: state.weekStart }),
    });
    toast(result.message);
    await load();
  } catch (error) {
    toast(error.message);
  }
});
$("#task-form").addEventListener("input", updateLanding);
$("#task-cancel").addEventListener("click", () => $("#task-dialog").close());
$("#stream-cancel").addEventListener("click", () => $("#stream-dialog").close());

for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    stream_id: Number(form.elements.stream_id.value),
    title: form.elements.title.value,
    note: form.elements.note.value,
    important: form.elements.important.checked,
    urgent: form.elements.urgent.checked,
    scheduled_on: form.elements.scheduled_on.value || null,
  };
  const errorEl = $("#task-error");
  errorEl.hidden = true;
  try {
    if (state.editingTaskId) {
      await api(`/api/tasks/${state.editingTaskId}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
    }
    $("#task-dialog").close();
    await load();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  }
});

$("#task-delete").addEventListener("click", async () => {
  if (!state.editingTaskId) return;
  try {
    await api(`/api/tasks/${state.editingTaskId}`, { method: "DELETE" });
    $("#task-dialog").close();
    await load();
  } catch (error) {
    toast(error.message);
  }
});

$("#stream-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = event.currentTarget.elements.name.value;
  const errorEl = $("#stream-error");
  errorEl.hidden = true;
  try {
    if (state.editingStreamId) {
      await api(`/api/streams/${state.editingStreamId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
    } else {
      await api("/api/streams", { method: "POST", body: JSON.stringify({ name }) });
    }
    $("#stream-dialog").close();
    await load();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  }
});

$("#delete-stream-cancel").addEventListener("click", () => $("#delete-stream-dialog").close());
$("#delete-stream-form").addEventListener("submit", (event) => event.preventDefault());

$("#graveyard-stream").addEventListener("click", async () => {
  const stream = streamById(state.deletingStreamId);
  if (!stream) return;
  const errorEl = $("#delete-stream-error");
  errorEl.hidden = true;
  try {
    await api(`/api/streams/${stream.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
    if (state.filterStreamId === stream.id) state.filterStreamId = null;
    $("#delete-stream-dialog").close();
    await load();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  }
});

$("#purge-stream").addEventListener("click", async () => {
  const button = $("#purge-stream");
  const stream = streamById(state.deletingStreamId);
  if (!stream) return;
  if (button.dataset.armed !== "1") {
    const count = state.tasks.filter((task) => task.stream_id === stream.id).length;
    button.dataset.armed = "1";
    button.textContent = count ? `Delete stream and ${count} tasks` : "Delete stream now";
    return;
  }
  const errorEl = $("#delete-stream-error");
  errorEl.hidden = true;
  try {
    await api(`/api/streams/${stream.id}`, { method: "DELETE" });
    if (state.filterStreamId === stream.id) state.filterStreamId = null;
    $("#delete-stream-dialog").close();
    await load();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  }
});

$("#open-settings").addEventListener("click", openSettings);
$("#settings-close").addEventListener("click", () => $("#settings-dialog").close());
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = event.currentTarget.elements.app_name.value;
  try {
    const saved = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ app_name: name }) });
    state.settings.app_name = saved.app_name;
    applyAppName(saved.app_name);
    toast("Name saved");
  } catch (error) {
    toast(error.message);
  }
});
$("#calendar-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorEl = $("#calendar-error");
  errorEl.hidden = true;
  try {
    const created = await api("/api/calendars", {
      method: "POST",
      body: JSON.stringify({
        name: form.elements.name.value,
        url: form.elements.url.value,
        color: form.elements.color.value,
      }),
    });
    state.settings.calendars.push(created);
    form.reset();
    form.elements.color.value = "#0e61b9";
    renderCalendarSettings();
    await loadWeek(false);
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  }
});
$("#calendar-settings").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-calendar]");
  if (!button) return;
  const id = Number(button.dataset.removeCalendar);
  try {
    await api(`/api/calendars/${id}`, { method: "DELETE" });
    state.settings.calendars = state.settings.calendars.filter((calendar) => calendar.id !== id);
    renderCalendarSettings();
    await loadWeek(false);
  } catch (error) {
    toast(error.message);
  }
});

$("#plan-cancel").addEventListener("click", () => $("#plan-dialog").close());
$("#plan-form").addEventListener("change", (event) => {
  if (event.target.name === "mode") syncPlanMode();
});
$("#plan-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const mode = form.elements.mode.value;
  const payload = { scheduled_on: form.elements.day.value, plan_mode: mode };
  if (mode === "clock") {
    payload.plan_start = form.elements.start.value;
    payload.plan_end = form.elements.end.value;
  } else {
    payload.estimate_hours = Number(form.elements.hours.value);
  }
  const errorEl = $("#plan-error");
  errorEl.hidden = true;
  try {
    await api(`/api/tasks/${state.planningTaskId}`, { method: "PATCH", body: JSON.stringify(payload) });
    $("#plan-dialog").close();
    await load();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  }
});
$("#plan-clear").addEventListener("click", async () => {
  try {
    await api(`/api/tasks/${state.planningTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({ plan_mode: "none" }),
    });
    $("#plan-dialog").close();
    await load();
  } catch (error) {
    toast(error.message);
  }
});

$("#time-cancel").addEventListener("click", () => $("#time-dialog").close());
$("#time-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const streamValue = form.elements.stream_id.value;
  const payload = {
    day: form.elements.day.value,
    note: form.elements.note.value,
    start: form.elements.start.value,
    end: form.elements.end.value,
    stream_id: streamValue ? Number(streamValue) : null,
  };
  const errorEl = $("#time-error");
  errorEl.hidden = true;
  try {
    if (state.editingTimeId) {
      await api(`/api/time/${state.editingTimeId}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      await api("/api/time", { method: "POST", body: JSON.stringify(payload) });
    }
    $("#time-dialog").close();
    await load();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  }
});
$("#time-delete").addEventListener("click", async () => {
  if (!state.editingTimeId) return;
  try {
    await api(`/api/time/${state.editingTimeId}`, { method: "DELETE" });
    $("#time-dialog").close();
    await load();
  } catch (error) {
    toast(error.message);
  }
});

document.body.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest("[data-drag]");
  if (!handle || (event.pointerType === "mouse" && event.button !== 0)) return;
  const card = handle.closest("[data-task-id]");
  drag = {
    id: Number(card.dataset.taskId),
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
  };
  handle.setPointerCapture(event.pointerId);
});

document.body.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.active && distance < 6) return;
  const task = state.tasks.find((item) => item.id === drag.id);
  if (!drag.active) {
    drag.active = true;
    document.body.classList.add("is-dragging");
    const ghost = $("#ghost");
    ghost.hidden = false;
    ghost.textContent = task ? task.title : "";
  }
  const ghost = $("#ghost");
  ghost.style.left = `${event.clientX + 12}px`;
  ghost.style.top = `${event.clientY + 12}px`;
  markDrop(event.clientX, event.clientY);
});

document.body.addEventListener("pointerup", async (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const current = drag;
  const target = current.active ? dropTarget(event.clientX, event.clientY) : null;
  if (current.active) suppressClick = true;
  endDrag();
  if (!current.active || !target) return;
  const task = state.tasks.find((item) => item.id === current.id);
  if (!task) return;
  const patch = {};
  if (target.dataset.dropDay) {
    if (task.scheduled_on === target.dataset.dropDay) return;
    patch.scheduled_on = target.dataset.dropDay;
  } else if ("dropUnscheduled" in target.dataset) {
    if (!task.scheduled_on) return;
    patch.scheduled_on = null;
  } else if (target.dataset.dropQuadrant) {
    const quadrant = QUADRANTS.find((item) => item.id === target.dataset.dropQuadrant);
    const streamEl = target.closest("[data-drop-stream]");
    const streamId = streamEl ? Number(streamEl.dataset.dropStream) : task.stream_id;
    if (
      task.important === quadrant.important
      && task.urgent === quadrant.urgent
      && task.stream_id === streamId
    ) return;
    patch.important = quadrant.important;
    patch.urgent = quadrant.urgent;
    if (streamEl) patch.stream_id = streamId;
  } else if (target.dataset.dropStream) {
    const streamId = Number(target.dataset.dropStream);
    if (task.stream_id === streamId) return;
    patch.stream_id = streamId;
  } else {
    return;
  }
  try {
    await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    await load();
  } catch (error) {
    toast(error.message);
  }
});

document.body.addEventListener("pointercancel", (event) => {
  if (drag && event.pointerId === drag.pointerId) endDrag();
});

function dropTarget(x, y) {
  const ghost = $("#ghost");
  const wasHidden = ghost.hidden;
  ghost.style.visibility = "hidden";
  const el = document.elementFromPoint(x, y);
  ghost.style.visibility = "";
  if (wasHidden) ghost.hidden = true;
  return el
    ? el.closest("[data-drop-day], [data-drop-unscheduled], [data-drop-quadrant], [data-drop-stream]")
    : null;
}

function markDrop(x, y) {
  document.querySelectorAll(".is-drop").forEach((el) => el.classList.remove("is-drop"));
  const target = dropTarget(x, y);
  if (target) target.classList.add("is-drop");
}

function endDrag() {
  drag = null;
  document.body.classList.remove("is-dragging");
  const ghost = $("#ghost");
  ghost.hidden = true;
  ghost.style.visibility = "";
  document.querySelectorAll(".is-drop").forEach((el) => el.classList.remove("is-drop"));
}

const sectionLinks = [...document.querySelectorAll(".side a")];
function markCurrentSection() {
  const line = 120;
  let current = sectionLinks[0];
  for (const link of sectionLinks) {
    const section = document.querySelector(link.getAttribute("href"));
    if (section && section.getBoundingClientRect().top <= line) current = link;
  }
  sectionLinks.forEach((link) => link.classList.toggle("is-current", link === current));
}
document.addEventListener("scroll", markCurrentSection, { passive: true });
markCurrentSection();

load()
  .then(() => loadWeek())
  .catch(() => toast("The planner could not load."));
