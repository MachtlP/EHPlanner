const QUADRANTS = [
  { id: "do", title: "Do", hint: "Important · Urgent", important: true, urgent: true },
  { id: "schedule", title: "Schedule", hint: "Important", important: true, urgent: false },
  { id: "handoff", title: "Hand off", hint: "Urgent", important: false, urgent: true },
  { id: "later", title: "Later", hint: "Neither", important: false, urgent: false },
];

const state = {
  streams: [],
  tasks: [],
  filterStreamId: null,
  doneOpen: window.matchMedia("(min-width: 801px)").matches,
  editingTaskId: null,
  editingStreamId: null,
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

function quadrantOf(task) {
  return QUADRANTS.find((quadrant) => quadrant.important === task.important && quadrant.urgent === task.urgent);
}

function streamById(id) {
  return state.streams.find((stream) => stream.id === id);
}

function visibleTasks(status) {
  return state.tasks.filter((task) => {
    if (task.status !== status) return false;
    if (state.filterStreamId !== null && task.stream_id !== state.filterStreamId) return false;
    return true;
  });
}

async function load() {
  const [streamsRes, tasksRes] = await Promise.all([fetch("/api/streams"), fetch("/api/tasks")]);
  if (!streamsRes.ok || !tasksRes.ok) throw new Error("load failed");
  state.streams = await streamsRes.json();
  state.tasks = await tasksRes.json();
  if (state.filterStreamId !== null && !streamById(state.filterStreamId)) {
    state.filterStreamId = null;
  }
  render();
}

function render() {
  renderFilters();
  renderMatrix();
  renderStreams();
  renderDone();
  const selected = state.filterStreamId === null ? null : streamById(state.filterStreamId);
  $("#matrix-scope").textContent = selected ? selected.name : "All streams";
}

function renderFilters() {
  const chips = [
    `<button type="button" class="chip ${state.filterStreamId === null ? "is-on" : ""}" data-filter="all">All</button>`,
  ];
  for (const stream of state.streams) {
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
      <button type="button" class="icon-btn" data-done="${task.id}" aria-label="Mark done">✓</button>
    </article>`;
}

function renderMatrix() {
  const open = visibleTasks("open");
  $("#matrix").innerHTML = QUADRANTS.map((quadrant) => {
    const cards = open.filter((task) => task.important === quadrant.important && task.urgent === quadrant.urgent);
    const body = cards.length ? cards.map(cardHtml).join("") : `<p class="empty">Empty</p>`;
    return `
      <section class="quadrant quadrant-${quadrant.id}" data-drop-quadrant="${quadrant.id}">
        <header>
          <h2>${quadrant.title}</h2>
          <p>${quadrant.hint}</p>
        </header>
        <div class="cards">${body}</div>
      </section>`;
  }).join("");
}

function renderStreams() {
  if (!state.streams.length) {
    $("#stream-list").innerHTML = `<p class="empty">Add a stream to start.</p>`;
    return;
  }
  $("#stream-list").innerHTML = state.streams.map((stream) => {
    const openCount = state.tasks.filter((task) => task.stream_id === stream.id && task.status === "open").length;
    const on = state.filterStreamId === stream.id ? "is-on" : "";
    return `
      <article class="stream ${on}" data-drop-stream="${stream.id}">
        <button type="button" class="stream-select" data-filter="${stream.id}">
          <span class="dot" style="--c:${esc(stream.color)}"></span>
          <span class="stream-name">${esc(stream.name)}</span>
          <span class="muted">${openCount} open</span>
        </button>
        <button type="button" class="btn" data-add-task="${stream.id}">Add</button>
        <button type="button" class="btn ghost" data-rename-stream="${stream.id}">Rename</button>
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

async function api(url, options) {
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
  }, 3200);
}

function fillStreamSelect(selectedId) {
  const select = $("#task-form").elements.stream_id;
  select.innerHTML = state.streams
    .map((stream) => `<option value="${stream.id}">${esc(stream.name)}</option>`)
    .join("");
  if (selectedId) select.value = String(selectedId);
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
  const del = $("#stream-delete");
  $("#stream-error").hidden = true;
  state.editingStreamId = stream ? stream.id : null;
  form.reset();
  del.dataset.armed = "0";
  if (stream) {
    $("#stream-dialog-title").textContent = "Rename stream";
    form.elements.name.value = stream.name;
    del.hidden = false;
    del.textContent = "Delete";
  } else {
    $("#stream-dialog-title").textContent = "New stream";
    del.hidden = true;
  }
  $("#stream-dialog").showModal();
  form.elements.name.focus();
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

  const addTask = event.target.closest("[data-add-task]");
  if (addTask) {
    openTaskDialog(null, Number(addTask.dataset.addTask));
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
      body: JSON.stringify({ status: "done" }),
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

$("#stream-delete").addEventListener("click", async () => {
  const button = $("#stream-delete");
  const stream = streamById(state.editingStreamId);
  if (!stream) return;
  if (button.dataset.armed !== "1") {
    const count = state.tasks.filter((task) => task.stream_id === stream.id).length;
    button.dataset.armed = "1";
    button.textContent = count ? `Delete stream and ${count} tasks` : "Delete stream now";
    return;
  }
  try {
    await api(`/api/streams/${stream.id}`, { method: "DELETE" });
    if (state.filterStreamId === stream.id) state.filterStreamId = null;
    $("#stream-dialog").close();
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
  try {
    if (target.dataset.dropQuadrant) {
      const quadrant = QUADRANTS.find((item) => item.id === target.dataset.dropQuadrant);
      if (task.important === quadrant.important && task.urgent === quadrant.urgent) return;
      await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ important: quadrant.important, urgent: quadrant.urgent }),
      });
    } else if (target.dataset.dropStream) {
      const streamId = Number(target.dataset.dropStream);
      if (task.stream_id === streamId) return;
      await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ stream_id: streamId }),
      });
    } else {
      return;
    }
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
  return el ? el.closest("[data-drop-quadrant], [data-drop-stream]") : null;
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

load().catch(() => toast("The planner could not load."));
