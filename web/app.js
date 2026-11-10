"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  let scan = null;
  let ai = false;
  let filter = "all";

  async function api(path, body) {
    const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  function setBusy(busy, text) {
    $("scan-btn").disabled = busy;
    $("demo-btn").disabled = busy;
    $("status").hidden = !text;
    $("status").textContent = text || "";
  }

  function showError(msg) {
    $("form-error").hidden = !msg;
    $("form-error").textContent = msg || "";
  }

  function codeBlock(lines) {
    const pre = el("pre");
    for (const l of lines) pre.appendChild(el("span", l.cls || "", l.text === "" ? " " : l.text));
    return pre;
  }

  function renderFix(box, fix) {
    box.textContent = "";
    if (fix.status === "verified") {
      const head = el("div", "card-head");
      head.appendChild(el("span", "badge ok", "Verified fix"));
      head.appendChild(el("span", "loc", (fix.model || "Gemini") + ", attempt " + fix.attempts));
      box.appendChild(head);
      box.appendChild(el("p", "", fix.explanation));
      box.appendChild(el("p", "", "If left unfixed: " + fix.impact));
      box.appendChild(
        codeBlock(
          fix.diff.split("\n").map((t) => ({
            text: t,
            cls: t.startsWith("+++") || t.startsWith("---") || t.startsWith("@@") ? "meta" : t.startsWith("+") ? "add" : t.startsWith("-") ? "del" : ""
          }))
        )
      );
      box.appendChild(el("p", "proof", "Proof: the patch was applied to a scratch copy and re-scanned. This finding is gone and no new finding appeared. Review it before you merge."));
    } else {
      const label = fix.status === "skipped" ? "No automatic fix" : fix.status === "rejected" ? "No verified fix" : "Could not get a fix";
      box.appendChild(el("p", "", label + ": " + (fix.reason || "")));
      if (fix.status === "rejected") box.appendChild(el("p", "proof", "Gemini's patches did not pass the re-scan after " + fix.attempts + " attempts, so none is shown."));
    }
  }

  function card(f) {
    const li = el("li", "card");
    const head = el("div", "card-head");
    head.appendChild(el("span", "badge " + f.severity, f.severity));
    head.appendChild(el("strong", "", f.ruleId));
    head.appendChild(el("span", "loc", f.file + ":" + f.line));
    li.appendChild(head);
    li.appendChild(el("p", "msg", f.message));
    if (f.snippet && f.snippet.length) {
      li.appendChild(codeBlock(f.snippet.map((s) => ({ text: String(s.line).padStart(4) + "  " + s.text, cls: s.line === f.line ? "hit" : "" }))));
    }
    li.appendChild(el("p", "hint", "Manual fix: " + f.fix));

    const actions = el("div", "actions");
    const box = el("div", "fix");
    box.hidden = true;
    if (!f.fixable) {
      actions.appendChild(el("span", "note", "Needs a human decision, so no automatic patch is offered."));
    } else if (!ai) {
      actions.appendChild(el("span", "note", "Gemini is not configured on this server."));
    } else {
      const btn = el("button", "", "Fix with Gemini");
      btn.type = "button";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        box.hidden = false;
        box.textContent = "Gemini is writing a patch, then safegate re-scans it. This usually takes 10 to 40 seconds.";
        try {
          const fix = await api("/api/fix", { scanId: scan.scanId, index: f.index });
          renderFix(box, fix);
          btn.hidden = fix.status !== "error";
          btn.disabled = false;
          btn.textContent = "Try again";
          loadStats();
        } catch (e) {
          box.textContent = e.message;
          btn.disabled = false;
        }
      });
      actions.appendChild(btn);
    }
    li.appendChild(actions);
    li.appendChild(box);
    return li;
  }

  function render() {
    const list = $("findings");
    list.textContent = "";
    const shown = scan.findings.filter((f) => filter === "all" || (filter === "auth" ? f.ruleId.startsWith("AUTH") : !f.ruleId.startsWith("AUTH")));
    for (const f of shown) list.appendChild(card(f));

    const filters = $("filters");
    filters.textContent = "";
    const counts = { all: scan.findings.length, auth: scan.findings.filter((f) => f.ruleId.startsWith("AUTH")).length };
    counts.migrations = counts.all - counts.auth;
    for (const [key, label] of [["all", "All"], ["auth", "Access control"], ["migrations", "Migrations"]]) {
      const b = el("button", "", label + " " + counts[key]);
      b.type = "button";
      b.setAttribute("aria-pressed", String(filter === key));
      b.addEventListener("click", () => {
        filter = key;
        render();
      });
      filters.appendChild(b);
    }
    filters.hidden = !scan.findings.length;
  }

  async function runScan(body, label) {
    showError("");
    $("results").hidden = true;
    setBusy(true, "Scanning " + label + "…");
    try {
      scan = await api("/api/scan", body);
      filter = "all";
      const high = scan.findings.filter((f) => f.severity === "high").length;
      $("summary-title").textContent = scan.findings.length ? scan.findings.length + " findings in " + scan.repo + " (" + high + " high)" : "No findings in " + scan.repo;
      let sub = "Checked " + scan.entriesChecked + " endpoints and " + scan.migrationsChecked + " migrations.";
      if (!scan.schemaFound) sub += " No schema.prisma was found, so this may not be a Prisma project.";
      else if (!scan.entriesChecked && !scan.migrationsChecked) sub += " No supported routes or migrations were found.";
      $("summary-sub").textContent = sub;
      render();
      $("results").hidden = false;
      setBusy(false, "");
      loadStats();
    } catch (e) {
      setBusy(false, "");
      showError(e.message);
    }
  }

  async function loadStats() {
    try {
      const s = await api("/api/stats");
      $("stats").textContent = s.scans + " scans, " + s.findings + " findings, " + s.fixesVerified + " verified fixes so far.";
    } catch (e) {
      $("stats").textContent = "";
    }
  }

  $("scan-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const repo = $("repo").value.trim();
    if (!repo) return showError("Enter a public GitHub repository URL first.");
    runScan({ repo }, repo);
  });
  $("repo").addEventListener("input", () => showError(""));
  $("demo-btn").addEventListener("click", () => runScan({ demo: true }, "the demo app"));

  api("/api/config")
    .then((c) => {
      ai = c.ai;
      $("version").textContent = "safegate " + c.version + (c.ai ? ", fixes by " + c.model + (c.aiMode === "vertex" ? " on Vertex AI" : "") : "");
    })
    .catch(() => {});
  loadStats();
})();
