#!/usr/bin/env node
// Standalone Active Ports web dashboard server.
// Spawned detached by the "Open Web Dashboard" Raycast command.
// Argv: [node, thisFile, supportPath, port]
//
// No Raycast dependencies — plain Node ESM so it can outlive the Raycast
// command process and serve a browser-based UI with batch actions and
// editable categorization (which Raycast's List view can't express).

import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const SUPPORT_PATH = process.argv[2] || process.cwd();
const PORT = parseInt(process.argv[3] || "47823", 10);
const CONFIG_PATH = join(SUPPORT_PATH, "web-dashboard-config.json");

const PATH_ENV = [
  "/usr/sbin",
  "/usr/bin",
  "/bin",
  "/sbin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  process.env.PATH || "",
].join(":");

// Every call blocks the event loop, so it must be bounded: a wedged lsof would
// otherwise make the dashboard permanently unresponsive.
const sh = (cmd, timeout = 5000) =>
  execSync(cmd, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout,
    killSignal: "SIGKILL",
    env: { ...process.env, PATH: PATH_ENV },
  });

// ---------------------------------------------------------------------------
// Config (category overrides + custom category list), persisted to disk.
// ---------------------------------------------------------------------------

const DEFAULT_CATEGORIES = ["Development Servers", "System & Apps"];

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return { categories: [...DEFAULT_CATEGORIES], overrides: {}, hidden: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return {
      categories: Array.isArray(parsed.categories) && parsed.categories.length
        ? parsed.categories
        : [...DEFAULT_CATEGORIES],
      overrides: parsed.overrides || {},
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
    };
  } catch {
    return { categories: [...DEFAULT_CATEGORIES], overrides: {}, hidden: [] };
  }
}

function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Service detection + display name (ported from src/index.tsx).
// ---------------------------------------------------------------------------

const PROJECT_CONFIGS = [
  { files: ["svelte.config.js", "svelte.config.ts"], flag: "isSvelteKit" },
  { files: ["next.config.js", "next.config.mjs", "next.config.ts"], flag: "isNextJS" },
  { files: ["vite.config.ts", "vite.config.js", "vite.config.mjs"], flag: "isVite" },
  { files: ["nuxt.config.ts", "nuxt.config.js"], flag: "isDevServer" },
  { files: ["astro.config.mjs", "astro.config.ts"], flag: "isDevServer" },
];

function detectServiceType(command, cwd) {
  const flags = {
    isVite: /vite|@vitejs/i.test(command),
    isFastAPI: /uvicorn|fastapi/i.test(command),
    isFlask: /flask/i.test(command),
    isNextJS: /next-server|next dev|next start/i.test(command),
    isSvelteKit: /svelte/i.test(command),
    isDevServer: false,
  };

  if (cwd) {
    for (const { files, flag } of PROJECT_CONFIGS) {
      if (!flags[flag] && files.some((f) => existsSync(join(cwd, f)))) {
        flags[flag] = true;
      }
    }
  }

  flags.isDevServer =
    flags.isVite ||
    flags.isNextJS ||
    flags.isSvelteKit ||
    flags.isDevServer ||
    /webpack|nuxt|nuxi|remix|astro/i.test(command);

  return flags;
}

function getDisplayName(command, cwd) {
  const appMatch = command.match(/\/([^/]+)\.app\//);
  if (appMatch) return { name: appMatch[1] };

  if (cwd) {
    const folders = cwd.split("/").filter(Boolean);
    const lastFolder = folders[folders.length - 1];
    if (lastFolder && !["node_modules", ".bin", "src", "dist"].includes(lastFolder)) {
      return { name: lastFolder, project: cwd };
    }
  }

  const nodePathMatch = command.match(/(?:node|bun|tsx|ts-node)\s+([^\s]+)/);
  if (nodePathMatch) {
    const parts = nodePathMatch[1].split("/").filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (
        !["node_modules", ".bin", "src", "dist", "bin"].includes(parts[i]) &&
        !parts[i].endsWith(".js")
      ) {
        return { name: parts[i], project: nodePathMatch[1] };
      }
    }
  }

  const pythonMatch = command.match(/python[3]?\s+(?:.*\/)?([^/\s]+\.py)/);
  if (pythonMatch) return { name: pythonMatch[1] };

  const binaryMatch = command.match(/^\/[^\s]+\/([^/\s]+)/);
  if (binaryMatch) return { name: binaryMatch[1] };

  const firstWord = command.split(/\s+/)[0];
  return { name: firstWord.split("/").pop() || command.slice(0, 20) };
}

function getDockerPorts() {
  const portMap = new Map();
  try {
    const output = sh("docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Image}}' 2>/dev/null");
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const [container, ports, image] = line.split("\t");
      const portMatches = (ports || "").matchAll(/(?:\d+\.\d+\.\d+\.\d+|::):(\d+)->/g);
      for (const match of portMatches) {
        portMap.set(parseInt(match[1], 10), { container, image });
      }
    }
  } catch {
    // docker not running / not installed
  }
  return portMap;
}

// One `lsof` and one `ps` for every pid at once. Per-pid lookups cost ~90ms
// each, which stalls the whole scan once a few hundred ports are listening.
function getProcessDetails(pids) {
  const cwds = new Map();
  const commands = new Map();
  if (!pids.length) return { cwds, commands };
  const list = pids.join(",");

  try {
    let pid = 0;
    for (const line of sh(`/usr/sbin/lsof -a -d cwd -p ${list} -Fpn 2>/dev/null`).split("\n")) {
      if (line[0] === "p") pid = parseInt(line.slice(1), 10);
      else if (line[0] === "n" && pid) cwds.set(pid, line.slice(1));
    }
  } catch {
    // ignore
  }

  try {
    for (const line of sh(`/bin/ps -p ${list} -ww -o pid=,args= 2>/dev/null`).split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (match) commands.set(parseInt(match[1], 10), match[2].trim());
    }
  } catch {
    // ignore
  }

  return { cwds, commands };
}

function getActivePorts() {
  let output = "";
  try {
    output = sh("/usr/sbin/lsof -iTCP -sTCP:LISTEN -P -n -F pcLn");
  } catch {
    return [];
  }
  if (!output?.trim()) return [];

  const dockerPorts = getDockerPorts();
  const portMap = new Map();
  let currentPid = 0;
  let currentCommand = "";
  let currentUser = "";

  for (const line of output.split("\n")) {
    if (!line) continue;
    const type = line[0];
    const value = line.slice(1);

    switch (type) {
      case "p":
        currentPid = parseInt(value, 10);
        break;
      case "c":
        currentCommand = value;
        break;
      case "L":
        currentUser = value;
        break;
      case "n": {
        const portMatch = value.match(/:(\d+)$/);
        if (!portMatch) break;
        const port = parseInt(portMatch[1], 10);
        const key = String(port);
        if (portMap.has(key)) break;
        portMap.set(key, { port, pid: currentPid, command: currentCommand, user: currentUser });
        break;
      }
    }
  }

  const entries = Array.from(portMap.values());
  const { cwds, commands } = getProcessDetails([...new Set(entries.map((e) => e.pid))]);

  for (const entry of entries) {
    const cwd = cwds.get(entry.pid) || undefined;
    const fullCommand = commands.get(entry.pid) || entry.command;
    const flags = detectServiceType(fullCommand, cwd);
    const dockerInfo = dockerPorts.get(entry.port);
    const { name, project } = getDisplayName(fullCommand, cwd);

    Object.assign(entry, {
      command: fullCommand,
      displayName: name,
      projectPath: project || cwd,
      cwd,
      ...flags,
      dockerContainer: dockerInfo?.container,
      dockerImage: dockerInfo?.image,
    });
  }

  return entries.sort((a, b) => a.port - b.port);
}

// Stable identity used to remember a manual category for a service across
// restarts (PIDs change, the name usually doesn't).
function signatureFor(info) {
  return info.dockerContainer || info.displayName || String(info.port);
}

function tagsFor(info) {
  const tags = [];
  if (info.dockerContainer) tags.push("Docker");
  if (info.isVite) tags.push("Vite");
  if (info.isSvelteKit) tags.push("SvelteKit");
  if (info.isNextJS) tags.push("Next.js");
  if (info.isFastAPI) tags.push("FastAPI");
  if (info.isFlask) tags.push("Flask");
  return tags;
}

function decorate(info, config) {
  const signature = signatureFor(info);
  const auto = info.isDevServer ? "Development Servers" : "System & Apps";
  const category = config.overrides[signature] || auto;
  return {
    port: info.port,
    pid: info.pid,
    displayName: info.displayName,
    command: info.command,
    user: info.user,
    projectPath: info.projectPath
      ? info.projectPath.replace(/^\/Users\/[^/]+\//, "~/").replace(/\/node_modules\/.*/, "")
      : undefined,
    cwd: info.cwd,
    dockerContainer: info.dockerContainer,
    tags: tagsFor(info),
    isDevServer: info.isDevServer,
    signature,
    autoCategory: auto,
    category,
    hidden: config.hidden.includes(signature),
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// The client polls every 5s; a slow scan must not queue up behind itself.
// Kills invalidate the cache so the UI still reflects them immediately.
const SCAN_TTL_MS = 3000;
let scanCache = null;
let scanCacheAt = 0;

function getCachedPorts() {
  const now = Date.now();
  if (scanCache && now - scanCacheAt < SCAN_TTL_MS) return scanCache;
  scanCache = getActivePorts();
  scanCacheAt = now;
  return scanCache;
}

function invalidateScanCache() {
  scanCache = null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/health") {
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/ports" && req.method === "GET") {
    const config = loadConfig();
    const ports = getCachedPorts().map((p) => decorate(p, config));
    return json(res, 200, {
      ports,
      categories: config.categories,
      updatedAt: new Date().toISOString(),
    });
  }

  if (url.pathname === "/api/kill" && req.method === "POST") {
    const body = await readBody(req);
    const pids = Array.isArray(body.pids) ? body.pids : [];
    const results = pids.map((pid) => {
      const n = parseInt(pid, 10);
      if (!Number.isInteger(n) || n <= 1) return { pid, killed: false };
      try {
        sh(`/bin/kill -9 ${n} 2>/dev/null`);
        return { pid: n, killed: true };
      } catch {
        return { pid: n, killed: false };
      }
    });
    invalidateScanCache();
    return json(res, 200, { results });
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    const body = await readBody(req);
    const config = loadConfig();

    if (body.signature && typeof body.category === "string") {
      const category = body.category.trim();
      if (category && category !== body.autoCategory) {
        config.overrides[body.signature] = category;
      } else {
        delete config.overrides[body.signature];
      }
      if (category && !config.categories.includes(category)) {
        config.categories.push(category);
      }
    }

    if (typeof body.addCategory === "string" && body.addCategory.trim()) {
      const c = body.addCategory.trim();
      if (!config.categories.includes(c)) config.categories.push(c);
    }

    if (body.signature && typeof body.hidden === "boolean") {
      const set = new Set(config.hidden);
      if (body.hidden) set.add(body.signature);
      else set.delete(body.signature);
      config.hidden = [...set];
    }

    saveConfig(config);
    return json(res, 200, { categories: config.categories });
  }

  if (url.pathname === "/api/shutdown" && req.method === "POST") {
    json(res, 200, { ok: true });
    server.close();
    setTimeout(() => process.exit(0), 100);
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }

  json(res, 404, { error: "not found" });
});

server.on("error", (err) => {
  // Most likely EADDRINUSE — another instance already owns the port. Exit
  // quietly so the launching command can just open the existing dashboard.
  if (err.code === "EADDRINUSE") process.exit(0);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1");

// ---------------------------------------------------------------------------
// Dashboard page (self-contained, no build step)
// ---------------------------------------------------------------------------

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Active Ports</title>
<style>
  :root {
    --bg: #15171b; --panel: #1a1d23; --panel2: #20232a; --border: #272b33;
    --text: #dfe3ea; --muted: #838a97; --accent: #6ea8f2; --danger: #e2687a;
    --green: #3ddc84; --purple: #b18bff; --orange: #d99b5f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header {
    position: sticky; top: 0; z-index: 10; background: var(--bg);
    border-bottom: 1px solid var(--border); padding: 16px 22px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .1px; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); }
  .updated { font-size: 12px; color: var(--muted); }
  button {
    font: inherit; border: 1px solid var(--border); background: var(--panel2);
    color: var(--text); padding: 7px 12px; border-radius: 7px; cursor: pointer;
    transition: background-color .15s ease, border-color .15s ease, color .15s ease;
  }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
  button.danger:disabled { background: var(--panel2); color: var(--muted); border-color: var(--border); }
  button.ghost-danger {
    background: transparent; border-color: rgba(226,104,122,.35); color: var(--danger);
  }
  button.ghost-danger:hover { background: var(--danger); border-color: var(--danger); color: #fff; }
  main { padding: 18px 22px 64px; }
  .cat { margin-bottom: 30px; }
  .cat-head {
    display: flex; align-items: center; gap: 10px; margin: 0 0 10px;
    font-size: 12px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted);
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); font-weight: 600; }
  tr.row { cursor: pointer; user-select: none; }
  tr.row td { transition: background-color .15s ease; }
  tr.row:hover td { background: var(--panel); }
  tr.row.selected td { background: rgba(110,168,242,.12); }
  tr.row.selected:hover td { background: rgba(110,168,242,.18); }
  td.name { font-weight: 500; }
  td.path { color: var(--muted); font-size: 12px; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .port { font-variant-numeric: tabular-nums; }
  a.port-link { color: var(--accent); text-decoration: none; }
  a.port-link:hover { text-decoration: underline; }
  .tag {
    display: inline-block; font-size: 11px; padding: 2px 7px; border-radius: 999px;
    background: var(--panel2); border: 1px solid var(--border); margin-right: 4px; color: var(--muted);
  }
  select {
    font: inherit; background: var(--panel2); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px;
    transition: border-color .15s ease;
  }
  input[type=checkbox] { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  .quick-actions { display: flex; flex-direction: column; gap: 8px; margin-bottom: 26px; }
  .quick-action {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--orange);
    border-radius: 8px; padding: 10px 14px; font-size: 13px; color: var(--muted);
  }
  .quick-action strong { color: var(--text); font-weight: 500; }
  .selcount { font-variant-numeric: tabular-nums; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--panel2); border: 1px solid var(--border); }
</style>
</head>
<body>
<header>
  <h1>Active Ports</h1>
  <span class="pill selcount" id="count">0 ports</span>
  <div class="spacer"></div>
  <span class="updated" id="updated"></span>
  <label class="muted" style="display:flex;align-items:center;gap:6px;">
    <input type="checkbox" id="selectAll" /> select all
  </label>
  <label class="muted" style="display:flex;align-items:center;gap:6px;">
    <input type="checkbox" id="showHidden" /> show hidden
  </label>
  <button id="refresh">Refresh</button>
  <button id="killBtn" class="danger" disabled>Kill selected (<span id="selN">0</span>)</button>
</header>
<main id="main"><div class="empty">Loading…</div></main>

<script>
let state = { ports: [], categories: [] };
let selected = new Set();      // keyed by pid
let showHidden = false;
let orderedPids = [];          // visible pids in render order (for shift-range)
let anchorPid = null;          // last clicked row (shift-range anchor)

const $ = (id) => document.getElementById(id);

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

async function load() {
  const data = await api("/api/ports");
  state = data;
  $("updated").textContent = "updated " + new Date(data.updatedAt).toLocaleTimeString();
  // prune selection for ports that vanished
  const alive = new Set(data.ports.map((p) => p.pid));
  selected = new Set([...selected].filter((pid) => alive.has(pid)));
  render();
}

function render() {
  const visible = state.ports.filter((p) => showHidden || !p.hidden);
  $("count").textContent = visible.length + " port" + (visible.length === 1 ? "" : "s");

  const groups = new Map();
  for (const c of state.categories) groups.set(c, []);
  for (const p of visible) {
    if (!groups.has(p.category)) groups.set(p.category, []);
    groups.get(p.category).push(p);
  }

  orderedPids = [];
  const main = $("main");
  main.innerHTML = "";
  let any = false;

  const folderGroups = findFolderGroups(visible);
  if (folderGroups.length) main.appendChild(renderQuickActions(folderGroups));

  for (const [cat, rows] of groups) {
    if (!rows.length) continue;
    any = true;
    for (const p of rows) orderedPids.push(p.pid);
    main.appendChild(renderCategory(cat, rows));
  }
  if (anchorPid != null && !orderedPids.includes(anchorPid)) anchorPid = null;
  if (!any) main.innerHTML = '<div class="empty">No listening ports found.</div>';
  updateKillBtn();
  updateSelectAllToggle();
}

// Processes sharing a project folder — surfaced as a one-click "kill all" banner.
function findFolderGroups(visible) {
  const byFolder = new Map();
  for (const p of visible) {
    if (!p.projectPath) continue;
    if (!byFolder.has(p.projectPath)) byFolder.set(p.projectPath, []);
    byFolder.get(p.projectPath).push(p);
  }
  return [...byFolder.entries()].filter(([, rows]) => rows.length > 2);
}

function renderQuickActions(groups) {
  const wrap = document.createElement("div");
  wrap.className = "quick-actions";
  for (const [path, rows] of groups) {
    const bar = document.createElement("div");
    bar.className = "quick-action";
    bar.innerHTML =
      '<span>' + rows.length + ' processes in <strong>' + esc(path) + '</strong></span>';
    const btn = document.createElement("button");
    btn.className = "ghost-danger";
    btn.textContent = "Kill all " + rows.length;
    btn.onclick = () => killGroup(rows.map((r) => r.pid), path);
    bar.appendChild(btn);
    wrap.appendChild(bar);
  }
  return wrap;
}

function renderCategory(cat, rows) {
  const wrap = document.createElement("section");
  wrap.className = "cat";
  const head = document.createElement("div");
  head.className = "cat-head";
  head.innerHTML = '<span>' + esc(cat) + '</span><span class="muted">' + rows.length + '</span>';
  if (rows.length > 1) {
    const killAllBtn = document.createElement("button");
    killAllBtn.textContent = "Kill all " + rows.length;
    killAllBtn.className = "ghost-danger";
    killAllBtn.style.cssText = "margin-left:auto;font-size:12px;padding:3px 10px;";
    killAllBtn.onclick = () => killGroup(rows.map((r) => r.pid), cat);
    head.appendChild(killAllBtn);
  }
  wrap.appendChild(head);

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const thCb = document.createElement("th");
  thCb.style.width = "28px";
  const rowPids = rows.map((r) => r.pid);
  const catCb = document.createElement("input");
  catCb.type = "checkbox";
  const catSelCount = rowPids.filter((pid) => selected.has(pid)).length;
  catCb.checked = rowPids.length > 0 && catSelCount === rowPids.length;
  catCb.indeterminate = catSelCount > 0 && catSelCount < rowPids.length;
  catCb.onchange = () => {
    if (catCb.checked) rowPids.forEach((pid) => selected.add(pid));
    else rowPids.forEach((pid) => selected.delete(pid));
    render();
  };
  thCb.appendChild(catCb);
  headRow.appendChild(thCb);
  headRow.insertAdjacentHTML(
    "beforeend",
    "<th>Service</th><th>Port</th><th>PID</th><th>Path</th><th>Tags</th><th>Category</th><th></th>",
  );
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  for (const p of rows) {
    const tr = document.createElement("tr");
    tr.className = selected.has(p.pid) ? "row selected" : "row";
    tr.onclick = (e) => {
      // Let native controls (checkbox, links, select, buttons) handle their own clicks.
      if (e.target.closest("input, a, select, button")) return;
      handleRowClick(p.pid, e);
    };

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(p.pid);
    cb.onchange = () => {
      cb.checked ? selected.add(p.pid) : selected.delete(p.pid);
      anchorPid = p.pid;
      tr.classList.toggle("selected", cb.checked);
      updateKillBtn();
    };

    const tdCb = document.createElement("td"); tdCb.appendChild(cb);
    const tags = p.tags.map((t) => '<span class="tag">' + esc(t) + '</span>').join("");

    tr.appendChild(tdCb);
    tr.insertAdjacentHTML("beforeend",
      '<td class="name">' + esc(p.displayName) + '</td>' +
      '<td class="port"><a class="port-link" href="http://localhost:' + p.port + '" target="_blank">:' + p.port + '</a></td>' +
      '<td class="port muted">' + p.pid + '</td>' +
      '<td class="path" title="' + esc(p.cwd || "") + '">' + esc(p.projectPath || "") + '</td>' +
      '<td>' + tags + '</td>');

    const tdCat = document.createElement("td");
    tdCat.appendChild(renderCategorySelect(p));
    tr.appendChild(tdCat);

    const tdAct = document.createElement("td");
    const hideBtn = document.createElement("button");
    hideBtn.textContent = p.hidden ? "Unhide" : "Hide";
    hideBtn.style.fontSize = "12px";
    hideBtn.style.padding = "3px 8px";
    hideBtn.onclick = () => toggleHidden(p);
    tdAct.appendChild(hideBtn);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderCategorySelect(p) {
  const sel = document.createElement("select");
  const cats = [...new Set([...state.categories, p.category])];
  for (const c of cats) {
    const o = document.createElement("option");
    o.value = c; o.textContent = c; o.selected = c === p.category;
    sel.appendChild(o);
  }
  const o = document.createElement("option");
  o.value = "__new__"; o.textContent = "New category…";
  sel.appendChild(o);

  sel.onchange = async () => {
    let category = sel.value;
    if (category === "__new__") {
      category = prompt("New category name:", "");
      if (!category) { render(); return; }
    }
    await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: p.signature, category, autoCategory: p.autoCategory }),
    });
    await load();
  };
  return sel;
}

async function toggleHidden(p) {
  await api("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature: p.signature, hidden: !p.hidden }),
  });
  await load();
}

function handleRowClick(pid, e) {
  if (e.shiftKey && anchorPid != null) {
    // Range select from the anchor to the clicked row (additive).
    const a = orderedPids.indexOf(anchorPid);
    const b = orderedPids.indexOf(pid);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) selected.add(orderedPids[i]);
    }
  } else if (e.metaKey || e.ctrlKey) {
    // Toggle this row, keep the rest.
    selected.has(pid) ? selected.delete(pid) : selected.add(pid);
    anchorPid = pid;
  } else {
    // Plain click: select only this row (unless it's already the sole selection).
    const soleSelection = selected.size === 1 && selected.has(pid);
    selected.clear();
    if (!soleSelection) selected.add(pid);
    anchorPid = pid;
  }
  render();
}

function updateKillBtn() {
  $("selN").textContent = selected.size;
  $("killBtn").disabled = selected.size === 0;
}

function updateSelectAllToggle() {
  const cb = $("selectAll");
  const total = orderedPids.length;
  const selCount = orderedPids.filter((pid) => selected.has(pid)).length;
  cb.checked = total > 0 && selCount === total;
  cb.indeterminate = selCount > 0 && selCount < total;
}

async function killSelected() {
  await killGroup([...selected]);
}

async function killGroup(pids, label) {
  if (!pids.length) return;
  const scope = label ? " in " + label : "";
  if (!confirm("Kill " + pids.length + " process" + (pids.length === 1 ? "" : "es") + scope + "?")) return;
  await api("/api/kill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pids }),
  });
  selected = new Set([...selected].filter((pid) => !pids.includes(pid)));
  await load();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("refresh").onclick = load;
$("killBtn").onclick = killSelected;
$("showHidden").onchange = (e) => { showHidden = e.target.checked; render(); };
$("selectAll").onchange = (e) => {
  selected = e.target.checked ? new Set(orderedPids) : new Set();
  render();
};

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (e.key === "Escape") {
    if (!selected.size) return;
    selected.clear();
    anchorPid = null;
    render();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    selected = new Set(orderedPids);
    render();
  }
});

load();
setInterval(load, 5000);
</script>
</body>
</html>`;
