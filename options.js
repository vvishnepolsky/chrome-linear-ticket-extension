// options.js — manage the Linear API key and default team/project/priority.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

async function load() {
  const stored = await chrome.storage.local.get([
    "linearApiKey",
    "defaultTeamId",
    "defaultProjectId",
    "defaultStateId",
    "defaultPriority",
  ]);
  if (stored.linearApiKey) $("api-key").value = stored.linearApiKey;
  if (stored.defaultPriority != null) $("default-priority").value = String(stored.defaultPriority);

  if (stored.linearApiKey) {
    await populateTeams(stored.defaultTeamId, stored.defaultProjectId, stored.defaultStateId);
  } else {
    $("defaults-card").classList.add("disabled");
  }
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = `vstatus ${kind || ""}`;
}

$("toggle-key").onclick = () => {
  const input = $("api-key");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  $("toggle-key").textContent = showing ? "Show" : "Hide";
};

$("verify").onclick = async () => {
  const key = $("api-key").value.trim();
  const status = $("verify-status");
  if (!key) return setStatus(status, "Enter a key first.", "err");

  setStatus(status, "Verifying…", "busy");
  await chrome.storage.local.set({ linearApiKey: key });
  try {
    const resp = await send({ type: "LINEAR_VERIFY" });
    if (!resp || !resp.ok) throw new Error(resp && resp.error);
    setStatus(status, `Connected as ${resp.viewer.name} (${resp.viewer.email})`, "ok");
    $("defaults-card").classList.remove("disabled");
    await populateTeams();
  } catch (err) {
    setStatus(status, `Failed: ${err.message || err}`, "err");
  }
};

async function populateTeams(selectedTeam, selectedProject, selectedState) {
  const teamSel = $("default-team");
  try {
    const resp = await send({ type: "LINEAR_LIST_TEAMS" });
    if (!resp || !resp.ok) throw new Error(resp && resp.error);
    teamSel.innerHTML = '<option value="">—</option>';
    for (const t of resp.teams) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.name} (${t.key})`;
      teamSel.appendChild(opt);
    }
    if (selectedTeam) teamSel.value = selectedTeam;
    await Promise.all([
      populateProjects(teamSel.value, selectedProject),
      populateStates(teamSel.value, selectedState),
    ]);
  } catch (err) {
    setStatus($("verify-status"), `Couldn't load teams: ${err.message || err}`, "err");
  }
}

async function populateProjects(teamId, selectedProject) {
  const projSel = $("default-project");
  projSel.innerHTML = '<option value="">—</option>';
  if (!teamId) return;
  try {
    const resp = await send({ type: "LINEAR_LIST_PROJECTS", teamId });
    if (!resp || !resp.ok) throw new Error(resp && resp.error);
    for (const p of resp.projects) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      projSel.appendChild(opt);
    }
    if (selectedProject) projSel.value = selectedProject;
  } catch (_) {}
}

async function populateStates(teamId, selectedState) {
  const stateSel = $("default-state");
  stateSel.innerHTML = '<option value="">Team default</option>';
  if (!teamId) return;
  try {
    const resp = await send({ type: "LINEAR_LIST_STATES", teamId });
    if (!resp || !resp.ok) throw new Error(resp && resp.error);
    for (const s of resp.states) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      stateSel.appendChild(opt);
    }
    if (selectedState) stateSel.value = selectedState;
  } catch (_) {}
}

$("default-team").onchange = () => {
  populateProjects($("default-team").value);
  populateStates($("default-team").value);
};

$("save-defaults").onclick = async () => {
  await chrome.storage.local.set({
    defaultTeamId: $("default-team").value || null,
    defaultProjectId: $("default-project").value || null,
    defaultStateId: $("default-state").value || null,
    defaultPriority: Number($("default-priority").value || 0),
  });
  setStatus($("defaults-status"), "Saved.", "ok");
  setTimeout(() => setStatus($("defaults-status"), "", ""), 2000);
};

load();
