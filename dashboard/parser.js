// parser.js
// Simple CMDB parser for POC
// Edit these if you used different user/branch/file locations:
const GITHUB_USER = "john007984";
const CMDB_REPO = "111-cmdb";
const CMDB_REPO_BRANCH = "main";
const CMDB_SOURCES_PATH = `repos/mongodb_sources.json`;

// Build raw URL to fetch the sources JSON
const CMDB_SOURCES_RAW = `https://raw.githubusercontent.com/${GITHUB_USER}/${CMDB_REPO}/${CMDB_REPO_BRANCH}/${CMDB_SOURCES_PATH}`;

// Local DNS helper (optional) - the dashboard will call this if "Use Local" is checked
const LOCAL_DNS_HELPER = "http://localhost:9000/resolve?name=";

// Public DoH endpoint (Cloudflare) used as fallback
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query?name=";

// UI elements
const statusEl = () => document.getElementById("statText");
const tbody = () => document.getElementById("tbody");
const reloadBtn = document.getElementById("reloadBtn");
const useLocalCheckbox = document.getElementById("useLocal");

reloadBtn.addEventListener("click", () => loadAll());

async function loadAll() {
  setStatus("Loading sources JSON...", "warn");
  clearTable();

  try {
    const r = await fetch(CMDB_SOURCES_RAW);
    if (!r.ok) throw new Error(`Failed to fetch sources JSON: ${r.status}`);
    const sources = await r.json();

    // sources is { "repo-name": "https://raw.githubusercontent.com/..." }
    const entries = Object.entries(sources);
    setStatus(`Found ${entries.length} repo(s). Fetching hosts...`, "warn");

    // iterate sequentially to avoid burst
    for (const [repoName, baseUrl] of entries) {
      const hostsUrl = `${baseUrl}/terraform/hostsfile/hosts`;
      await fetchAndParseHosts(repoName, hostsUrl);
    }

    setStatus("Done. Table updated.", "ok");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "err");
  }
}

function setStatus(text, cls = "") {
  const el = statusEl();
  el.textContent = text;
  el.className = cls;
}

function clearTable() {
  tbody().innerHTML = "";
}

// fetch hosts file, parse groups and host lines
async function fetchAndParseHosts(repoName, hostsUrl) {
  setStatus(`Fetching hosts from ${repoName}...`);
  try {
    const r = await fetch(hostsUrl);
    if (!r.ok) {
      console.warn("hosts fetch failed:", hostsUrl, r.status);
      setStatus(`Warning: could not fetch hosts from ${repoName} (HTTP ${r.status})`, "warn");
      return;
    }
    const text = await r.text();
    parseHostsText(repoName, text);
  } catch (err) {
    console.error(err);
    setStatus(`Error fetching ${repoName}: ${err.message}`, "err");
  }
}

function parseHostsText(repoName, text) {
  // repoName like "111-ch2-g-pr" -> platform is first segment (111)
  const platform = repoName.split("-")[0] || "";

  const lines = text.split(/\r?\n/).map(l => l.trim());
  let currentGroup = null;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#")) continue;
    // group header [pr-sipmdb-ch2-g]
    if (line.startsWith("[") && line.endsWith("]")) {
      currentGroup = line.slice(1, -1).trim();
      continue;
    }
    // otherwise this line should be an FQDN
    const fqdn = line;
    const parsed = parseFqdn(fqdn);
    // if parsing fails, still show fqdn with minimal info
    const row = {
      fqdn,
      db: parsed.db || (currentGroup ? currentGroup.split("-")[1] : ""),
      env: parsed.env || (currentGroup ? currentGroup.split("-")[0] : ""),
      platform,
      dc: parsed.dc || "",
      zone: parsed.zone || "",
      node: parsed.node || "",
      ip: "resolving..."
    };
    insertRow(row);
    // resolve IP async and update row when available
    resolveIpForFqdn(fqdn).then(ip => {
      updateRowIp(fqdn, ip || "N/A");
    }).catch(e => {
      console.warn("resolve error", e);
      updateRowIp(fqdn, "N/A");
    });
  }
}

// parse hostname like: pr-sipmdb-ch2-g-001.111.cc.com
function parseFqdn(fqdn) {
  try {
    // split at first dot to separate left and domain
    const firstDot = fqdn.indexOf(".");
    const left = firstDot === -1 ? fqdn : fqdn.slice(0, firstDot);
    // left parts: env, dbname, dc, zone, node
    const parts = left.split("-");
    const [env, db, dc, zone, node] = parts;
    return { env, db, dc, zone, node };
  } catch (e) {
    return {};
  }
}

// insert row in the table with temporary IP text
function insertRow(row) {
  const tr = document.createElement("tr");
  tr.setAttribute("data-fqdn", row.fqdn);
  tr.innerHTML = `
    <td><code>${row.fqdn}</code></td>
    <td>${row.db || ""}</td>
    <td>${row.env || ""}</td>
    <td>${row.platform || ""}</td>
    <td>${row.dc || ""}</td>
    <td>${row.zone || ""}</td>
    <td class="center">${row.node || ""}</td>
    <td class="center small ip-cell">${row.ip}</td>
  `;
  tbody().appendChild(tr);
}

// update IP cell by fqdn
function updateRowIp(fqdn, ip) {
  const tr = document.querySelector(`tr[data-fqdn="${CSS.escape(fqdn)}"]`);
  if (!tr) return;
  const cell = tr.querySelector(".ip-cell");
  if (!cell) return;
  cell.textContent = ip;
}

// resolve IP: try local helper if checkbox on, else DoH to Cloudflare
async function resolveIpForFqdn(fqdn) {
  if (useLocalCheckbox.checked) {
    try {
      const r = await fetch(LOCAL_DNS_HELPER + encodeURIComponent(fqdn));
      if (r.ok) {
        const j = await r.json();
        if (j && j.ip) return j.ip;
      }
    } catch (e) {
      // continue to fallback
      console.warn("Local DNS helper failed:", e);
    }
  }

  // fallback: cloudflare DNS-over-HTTPS (A record)
  try {
    const dohUrl = DOH_ENDPOINT + encodeURIComponent(fqdn) + "&type=A";
    const r = await fetch(dohUrl, { headers: { Accept: "application/dns-json" } });
    if (!r.ok) return null;
    const j = await r.json();
    if (j && Array.isArray(j.Answer) && j.Answer.length) {
      // first A record
      const answer = j.Answer.find(a => a.type === 1) || j.Answer[0];
      if (answer && answer.data) return answer.data;
    }
  } catch (e) {
    console.warn("DoH lookup failed", e);
  }
  return null;
}

// initial load
loadAll();
