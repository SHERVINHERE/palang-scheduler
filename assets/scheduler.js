// Palang Scheduler — shared calendar + companions tool (public and admin pages)
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getFirestore, doc, collection, query, orderBy, onSnapshot,
  runTransaction, serverTimestamp, deleteField, setDoc
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// 15 distinct colors (Trubetskoy "20 Simple, Distinct Colors", pale tints removed for use on white)
export const COLORS = [
  { name: "Red", hex: "#e6194B" }, { name: "Green", hex: "#3cb44b" }, { name: "Blue", hex: "#4363d8" },
  { name: "Orange", hex: "#f58231" }, { name: "Purple", hex: "#911eb4" }, { name: "Cyan", hex: "#42d4f4" },
  { name: "Magenta", hex: "#f032e6" }, { name: "Yellow", hex: "#ffe119" }, { name: "Lime", hex: "#bfef45" },
  { name: "Teal", hex: "#469990" }, { name: "Brown", hex: "#9A6324" }, { name: "Maroon", hex: "#800000" },
  { name: "Olive", hex: "#808000" }, { name: "Navy", hex: "#000075" }, { name: "Grey", hex: "#a9a9a9" }
];

const BAR_H = 6, BAR_GAP = 2, BAR_BASE = 6;

// ---------- date helpers (all dates are 'YYYY-MM-DD', handled in UTC) ----------
const toDate = (iso) => new Date(iso + "T12:00:00Z");
const toISO = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return toISO(d); };
const dayDiff = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
const fmt = (iso, opts) => toDate(iso).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
const fmtShort = (iso) => fmt(iso, { weekday: "short", month: "short", day: "numeric" });
const fmtRange = (a, b) => `${fmtShort(a)} – ${fmtShort(b)}`;
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export function initScheduler(cfg) {
  const db = getFirestore(initializeApp(firebaseConfig));
  const metaRef = doc(db, "events", cfg.eventId);
  const compCol = collection(db, "events", cfg.eventId, "companions");
  const histCol = collection(db, "events", cfg.eventId, "history");
  const $ = (id) => document.getElementById(id);

  const state = {
    companions: [], meta: { frozen: false, active: {} }, history: [],
    selStart: null, selEnd: null, hover: null,
    checked: [], mode: null, submitted: false, busy: false, loaded: false
  };

  // ---------- static calendar grid ----------
  const grid = $("grid");
  const gridStart = addDays(cfg.start, -toDate(cfg.start).getUTCDay());
  const gridEnd = addDays(cfg.end, 6 - toDate(cfg.end).getUTCDay());
  const cells = {};
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d) => grid.appendChild(el("div", "dow", d)));
  for (let iso = gridStart; iso <= gridEnd; iso = addDays(iso, 1)) {
    const inRange = iso >= cfg.start && iso <= cfg.end;
    const cell = el("div", inRange ? "cell" : "cell empty");
    if (inRange) {
      cell.dataset.date = iso;
      cell.tabIndex = 0;
      cell.setAttribute("role", "button");
      cell.setAttribute("aria-label", fmt(iso, { weekday: "long", month: "long", day: "numeric", year: "numeric" }));
      const tint = el("div", "tint");
      const bars = el("div", "bars");
      const num = el("span", "num");
      const d = toDate(iso).getUTCDate();
      if (iso === cfg.start || d === 1) num.appendChild(el("small", "mon", fmt(iso, { month: "short" })));
      num.appendChild(document.createTextNode(String(d)));
      cell.append(tint, bars, num);
      cell.addEventListener("click", () => pickDate(iso));
      cell.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickDate(iso); } });
      cell.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") { state.hover = iso; renderCalendar(); } });
      cell.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { state.hover = null; renderCalendar(); } });
      cells[iso] = { cell, tint, bars };
    }
    grid.appendChild(cell);
  }

  // ---------- derived data ----------
  const visible = () => state.companions.filter((c) => cfg.admin || !c.removed);
  const activeCount = () => Object.keys(state.meta.active || {}).length;
  const locked = () => !cfg.admin && (state.meta.frozen || activeCount() >= cfg.maxCompanions);
  const colorOf = (c) => COLORS[(c.color ?? 0) % COLORS.length].hex;

  // ---------- date selection ----------
  function pickDate(iso) {
    if (locked()) return;
    const hint = $("rangeHint");
    hint.classList.remove("warn");
    if (!state.selStart || state.selEnd || iso < state.selStart) {
      state.selStart = iso; state.selEnd = null;
    } else {
      const days = dayDiff(state.selStart, iso) + 1;
      if (days < cfg.minDays) {
        hint.textContent = `Please choose a range of at least ${cfg.minDays} days.`;
        hint.classList.add("warn");
        renderCalendar();
        return;
      }
      state.selEnd = iso;
    }
    resetSubmitted();
    renderAll();
  }

  function renderRangeHint() {
    const hint = $("rangeHint");
    if (hint.classList.contains("warn") && state.selStart && !state.selEnd) return;
    hint.classList.remove("warn");
    if (locked()) hint.textContent = "";
    else if (!state.selStart) hint.textContent = "Select your first day, then your last day.";
    else if (!state.selEnd) hint.textContent = `From ${fmtShort(state.selStart)} — now select your last day (minimum ${cfg.minDays} days).`;
    else hint.textContent = `Selected: ${fmtRange(state.selStart, state.selEnd)} (${dayDiff(state.selStart, state.selEnd) + 1} days)`;
  }

  // ---------- calendar render ----------
  function renderCalendar() {
    const list = visible();
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    const checked = state.checked.filter((id) => byId[id]);
    const n = list.length;
    const showLines = !state.mode;
    const lineCount = showLines ? checked.length : 0;
    grid.style.setProperty("--cell-h", Math.max(64, 40 + lineCount * (BAR_H + BAR_GAP)) + "px");

    const previewEnd = state.selStart && !state.selEnd && state.hover && state.hover > state.selStart ? state.hover : null;
    const rangeEnd = state.selEnd || previewEnd;

    for (const iso in cells) {
      const { cell, tint, bars } = cells[iso];
      // selection band
      cell.classList.toggle("sel-start", iso === state.selStart && !!rangeEnd);
      cell.classList.toggle("sel-end", !!rangeEnd && iso === rangeEnd);
      cell.classList.toggle("sel-mid", !!rangeEnd && iso > state.selStart && iso < rangeEnd);
      cell.classList.toggle("sel-ring", iso === state.selStart || iso === state.selEnd);
      cell.classList.toggle("preview", !state.selEnd && !!previewEnd);
      cell.classList.toggle("locked", locked());
      // majority / minority tint
      let tintOn = false;
      if (state.mode && n > 0) {
        const count = list.filter((c) => iso >= c.start && iso <= c.end).length;
        tintOn = state.mode === "majority" ? count > n / 2 : count >= 1;
      }
      tint.className = "tint" + (tintOn ? " " + state.mode : "");
      // companion lines
      bars.replaceChildren();
      if (showLines) {
        checked.forEach((id, i) => {
          const c = byId[id];
          if (iso < c.start || iso > c.end) return;
          const b = el("div", "bar");
          if (iso === c.start) b.classList.add("cap-start");
          if (iso === c.end) b.classList.add("cap-end");
          b.style.bottom = BAR_BASE + i * (BAR_H + BAR_GAP) + "px";
          b.style.background = colorOf(c);
          bars.appendChild(b);
        });
      }
    }
    renderRangeHint();
  }

  // ---------- companions list ----------
  function toggleChecked(id) {
    state.mode = null;
    const i = state.checked.indexOf(id);
    if (i >= 0) state.checked.splice(i, 1); else state.checked.push(id);
    renderAll();
  }

  function renderPeople() {
    const ul = $("people");
    ul.replaceChildren();
    const list = visible();
    if (!list.length) {
      ul.appendChild(el("li", "empty-note", state.loaded ? "No companions yet — be the first." : "Loading…"));
    }
    list.forEach((c) => {
      const li = el("li");
      const btn = el("button", "row" + (c.removed ? " removed" : ""));
      btn.type = "button";
      btn.setAttribute("role", "checkbox");
      const on = state.checked.includes(c.id) && !state.mode;
      btn.setAttribute("aria-checked", String(on));
      const dot = el("span", "dot" + (on ? " on" : ""));
      dot.style.setProperty("--c", colorOf(c));
      const text = el("span", "who");
      text.appendChild(el("span", "name", c.name));
      text.appendChild(el("span", "dates", fmtRange(c.start, c.end) + (c.removed ? " · removed" : "")));
      btn.append(dot, text);
      btn.addEventListener("click", () => toggleChecked(c.id));
      li.appendChild(btn);
      ul.appendChild(li);
    });

    const ids = list.map((c) => c.id);
    const allOn = !state.mode && ids.length > 0 && ids.every((id) => state.checked.includes(id));
    const noneOn = !state.mode && !ids.some((id) => state.checked.includes(id));
    setMgmt("selAll", allOn);
    setMgmt("selNone", noneOn);
    setMgmt("majority", state.mode === "majority");
    setMgmt("minority", state.mode === "minority");

    const anyChecked = !state.mode && ids.some((id) => state.checked.includes(id));
    const delBtn = $("deleteBtn");
    const deletable = list.filter((c) => !c.removed && state.checked.includes(c.id));
    delBtn.disabled = locked() || state.busy || !anyChecked || deletable.length === 0;
  }

  function setMgmt(id, on) {
    const b = $(id);
    b.setAttribute("aria-checked", String(on));
    b.querySelector(".dot").classList.toggle("on", on);
  }

  $("selAll").addEventListener("click", () => { state.mode = null; state.checked = visible().map((c) => c.id); renderAll(); });
  $("selNone").addEventListener("click", () => { state.mode = null; state.checked = []; renderAll(); });
  $("majority").addEventListener("click", () => { state.mode = state.mode === "majority" ? null : "majority"; state.checked = []; renderAll(); });
  $("minority").addEventListener("click", () => { state.mode = state.mode === "minority" ? null : "minority"; state.checked = []; renderAll(); });

  // ---------- form ----------
  const nameIn = $("name"), emailIn = $("email"), submitBtn = $("submitBtn"), feedback = $("feedback");

  function resetSubmitted() {
    if (!state.submitted) return;
    state.submitted = false;
    submitBtn.classList.remove("done");
    submitBtn.textContent = "Submit";
  }
  [nameIn, emailIn].forEach((i) => i.addEventListener("input", () => { resetSubmitted(); feedback.textContent = ""; feedback.className = "feedback"; }));

  function renderForm() {
    const lock = locked();
    nameIn.disabled = emailIn.disabled = lock || state.busy;
    submitBtn.disabled = lock || state.busy;
    const note = $("lockNote");
    if (!cfg.admin && state.meta.frozen) note.textContent = "This event is maxed out.";
    else if (!cfg.admin && activeCount() >= cfg.maxCompanions) note.textContent = `The companion list is full (${cfg.maxCompanions} of ${cfg.maxCompanions}). New submissions are closed.`;
    else if (cfg.admin && state.meta.frozen) note.textContent = "Frozen: the public page is view-only.";
    else note.textContent = "";
    const freeze = $("freeze");
    if (freeze) freeze.checked = !!state.meta.frozen;
    document.body.classList.toggle("is-locked", lock);
  }

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (locked() || state.busy) return;
    const name = nameIn.value.trim().replace(/\s+/g, " ").slice(0, 60);
    const email = emailIn.value.trim().toLowerCase();
    const missing = [];
    if (!state.selStart || !state.selEnd) missing.push(`a date range (minimum ${cfg.minDays} days)`);
    if (!name) missing.push("your name");
    if (!email) missing.push("your email address");
    else if (!isEmail(email)) missing.push("a valid email address");
    if (missing.length) {
      feedback.className = "feedback error";
      feedback.textContent = "Please complete the following before submitting: " + joinList(missing) + ".";
      return;
    }
    state.busy = true; renderAll();
    feedback.className = "feedback"; feedback.textContent = "Submitting…";
    const start = state.selStart, end = state.selEnd;
    try {
      const id = (await sha256(email)).slice(0, 24);
      const result = await runTransaction(db, async (tx) => {
        const metaSnap = await tx.get(metaRef);
        const compRef = doc(compCol, id);
        const compSnap = await tx.get(compRef);
        const meta = metaSnap.exists() ? metaSnap.data() : {};
        const active = meta.active || {};
        if (meta.frozen && !cfg.admin) throw new Error("frozen");
        const isActive = Object.prototype.hasOwnProperty.call(active, id);
        if (!isActive && Object.keys(active).length >= cfg.maxCompanions) throw new Error("full");
        let color = active[id];
        if (!isActive) {
          const used = new Set(Object.values(active));
          color = 0;
          while (used.has(color)) color++;
        }
        const now = serverTimestamp();
        if (isActive && compSnap.exists()) {
          tx.update(compRef, { name, start, end, updatedAt: now });
        } else {
          tx.set(compRef, { name, start, end, color, createdAt: now, updatedAt: now, removed: false, removedAt: null });
        }
        tx.set(metaRef, { active: { [id]: color } }, { merge: true });
        tx.set(doc(histCol), { type: isActive ? "update" : (compSnap.exists() ? "rejoin" : "submit"), name, start, end, at: now });
        return { id, updated: isActive };
      });
      relay({ action: "submit", id: result.id, name, email, start, end, event: cfg.eventId, eventTitle: `${cfg.eventId} (${cfg.subtitle})` });
      state.submitted = true;
      state.selStart = null; state.selEnd = null; state.hover = null;
      submitBtn.classList.add("done");
      submitBtn.textContent = "Submitted!";
      feedback.className = "feedback ok";
      feedback.textContent = result.updated
        ? "Your dates have been updated. A confirmation email is on its way."
        : "You're on the list. A confirmation email is on its way.";
    } catch (err) {
      feedback.className = "feedback error";
      if (err.message === "frozen") feedback.textContent = "This event is maxed out. Submissions are closed.";
      else if (err.message === "full") feedback.textContent = `The companion list is full (${cfg.maxCompanions} of ${cfg.maxCompanions}). New submissions are closed.`;
      else { console.error(err); feedback.textContent = "Something went wrong while saving. Please try again."; }
    } finally {
      state.busy = false; renderAll();
    }
  });

  function joinList(a) {
    if (a.length <= 1) return a.join("");
    return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
  }

  // ---------- delete ----------
  const modal = $("modal");
  $("deleteBtn").addEventListener("click", () => {
    const targets = visible().filter((c) => !c.removed && state.checked.includes(c.id));
    if (!targets.length) return;
    const names = joinList(targets.map((c) => c.name));
    $("modalTitle").textContent = targets.length === 1 ? `Remove ${targets[0].name}?` : `Remove ${targets.length} companions?`;
    $("modalBody").textContent =
      `This will remove ${names} from the ${cfg.eventId} calendar. This can't be undone — not even a Christmas miracle can bring ${targets.length === 1 ? "them" : "them all"} back. ` +
      `(They're welcome to submit their dates again.) A notice will be emailed to ${targets.length === 1 ? "them" : "each of them"}.`;
    modal.hidden = false;
    $("modalCancel").focus();
    modal.dataset.ids = JSON.stringify(targets.map((c) => c.id));
  });
  $("modalCancel").addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") modal.hidden = true; });
  $("modalDelete").addEventListener("click", async () => {
    const ids = JSON.parse(modal.dataset.ids || "[]");
    modal.hidden = true;
    if (!ids.length) return;
    state.busy = true; renderAll();
    try {
      await runTransaction(db, async (tx) => {
        const metaSnap = await tx.get(metaRef);
        const snaps = [];
        for (const id of ids) snaps.push(await tx.get(doc(compCol, id)));
        const meta = metaSnap.exists() ? metaSnap.data() : {};
        if (meta.frozen && !cfg.admin) throw new Error("frozen");
        const now = serverTimestamp();
        const metaUpdate = {};
        snaps.forEach((s) => {
          if (!s.exists() || s.data().removed) return;
          tx.update(s.ref, { removed: true, removedAt: now });
          metaUpdate["active." + s.id] = deleteField();
          const d = s.data();
          tx.set(doc(histCol), { type: "remove", name: d.name, start: d.start, end: d.end, at: now });
        });
        if (Object.keys(metaUpdate).length) {
          if (metaSnap.exists()) tx.update(metaRef, metaUpdate);
        }
      });
      relay({ action: "delete", ids });
      state.checked = state.checked.filter((id) => !ids.includes(id));
    } catch (err) {
      console.error(err);
      alert(err.message === "frozen" ? "This event is maxed out. Changes are closed." : "Something went wrong while removing. Please try again.");
    } finally {
      state.busy = false; renderAll();
    }
  });

  // ---------- email relay (Google Apps Script) ----------
  async function relay(payload) {
    if (!cfg.emailRelay) return;
    try {
      await fetch(cfg.emailRelay, {
        method: "POST", mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
    } catch (e) { console.warn("Email relay failed", e); }
  }

  // ---------- admin extras ----------
  if (cfg.admin) {
    $("freeze").addEventListener("change", async (e) => {
      const frozen = e.target.checked;
      try {
        await setDoc(metaRef, { frozen }, { merge: true });
        await setDoc(doc(histCol), { type: frozen ? "freeze" : "unfreeze", at: serverTimestamp() });
      } catch (err) { console.error(err); alert("Could not change FREEZE. Please try again."); e.target.checked = !frozen; }
    });
    $("exportBtn").addEventListener("click", () => {
      const rows = [["Name", "First day", "Last day", "Days", "Status", "Added", "Removed"]];
      state.companions.forEach((c) => rows.push([
        c.name, c.start, c.end, dayDiff(c.start, c.end) + 1, c.removed ? "Removed" : "Active",
        c.createdAt ? c.createdAt.toISOString() : "", c.removedAt ? c.removedAt.toISOString() : ""
      ]));
      const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `${cfg.eventId}_companions.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    onSnapshot(query(histCol, orderBy("at", "desc")), (snap) => {
      state.history = snap.docs.map((d) => {
        const x = d.data({ serverTimestamps: "estimate" });
        return { ...x, at: x.at ? x.at.toDate() : null };
      });
      renderHistory();
    });
  }

  function renderHistory() {
    const ul = $("history");
    if (!ul) return;
    ul.replaceChildren();
    if (!state.history.length) { ul.appendChild(el("li", "muted", "No activity yet.")); return; }
    const label = { submit: "Added", rejoin: "Re-added", update: "Updated", remove: "Removed", freeze: "FREEZE on", unfreeze: "FREEZE off" };
    state.history.forEach((h) => {
      const li = el("li");
      const when = h.at ? h.at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      li.appendChild(el("span", "h-when", when));
      li.appendChild(el("span", "h-type t-" + h.type, label[h.type] || h.type));
      li.appendChild(el("span", "h-what", h.name ? `${h.name} · ${fmtRange(h.start, h.end)}` : ""));
      ul.appendChild(li);
    });
  }

  // ---------- live data ----------
  const status = $("status");
  onSnapshot(metaRef, (snap) => {
    state.meta = snap.exists() ? { frozen: false, active: {}, ...snap.data() } : { frozen: false, active: {} };
    renderAll();
  }, (err) => { status.textContent = "Connection problem: " + err.code; });

  onSnapshot(query(compCol, orderBy("createdAt", "asc")), (snap) => {
    state.companions = snap.docs.map((d) => {
      const x = d.data({ serverTimestamps: "estimate" });
      return {
        id: d.id, name: x.name, start: x.start, end: x.end, color: x.color, removed: !!x.removed,
        createdAt: x.createdAt ? x.createdAt.toDate() : null, removedAt: x.removedAt ? x.removedAt.toDate() : null
      };
    });
    state.loaded = true;
    status.textContent = "";
    renderAll();
  }, (err) => { status.textContent = "Connection problem: " + err.code; });

  function renderAll() {
    renderCalendar();
    renderPeople();
    renderForm();
  }
  renderAll();
}
