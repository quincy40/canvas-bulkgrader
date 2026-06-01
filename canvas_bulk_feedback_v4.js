/**
 * ============================================================
 * Canvas Bulk Feedback Uploader  v4
 * University of Auckland — browser console script
 * ============================================================
 *
 * WHAT'S NEW IN v4
 * ----------------
 * - Floating UI panel injected into the Canvas page
 * - Course + assignment picker (no more hardcoded IDs)
 * - File picker: upload a .csv or .xlsx directly from disk
 *   (SheetJS loaded on demand from jsDelivr CDN for xlsx support)
 * - Progress bar + live status log inside the panel
 * - Resume: completed student IDs saved to sessionStorage;
 *   interrupted runs pick up where they left off
 * - Duplicate guard: optionally skip students who already
 *   have a comment from the current logged-in user
 * - Grade support verified: posted_grade is posted together
 *   with the comment in a single PUT call
 * - Console API retained for scripting (probe, single, bulkFromCSV …)
 *
 * QUICK START
 * -----------
 * 1. Log into Canvas (canvas.auckland.ac.nz).
 * 2. DevTools → Console → paste this script → Enter.
 *    OR use the bookmarklet from bookmarklet.txt.
 * 3. A floating panel appears in the top-right corner.
 * 4. Pick your course and assignment from the dropdowns.
 * 5. Choose a CSV or XLSX file (columns: student_id, grade, comment).
 * 6. Click ▶ Start.
 *
 * CSV / XLSX FORMAT
 * -----------------
 * student_id,grade,comment
 * 438886,85,Excellent structural analysis.
 * 123456,,Check your load path diagrams.
 * 789012,71,Good effort — see rubric notes.
 *
 * student_id  = Canvas user ID (integer — visible in Roster URL or printRoster())
 * grade       = numeric or letter grade; leave blank to skip grade update
 * comment     = text comment; leave blank to skip comment
 * At least one of grade / comment must be non-empty per row.
 *
 * CONSOLE API (still works alongside the UI)
 * ------------------------------------------
 * await CanvasFeedback.probe(438886)
 * await CanvasFeedback.printRoster()
 * await CanvasFeedback.single(438886, 'Great work.', 85)
 * await CanvasFeedback.bulkFromCSV(`student_id,grade,comment\n438886,85,Good.`)
 * CanvasFeedback.CONFIG   — read / modify course_id, assignment_id, delay_ms, dry_run …
 *
 * AUTH NOTES
 * ----------
 * Uses session-cookie auth + X-CSRF-Token (no API token needed).
 * The CSRF token is read from <meta name="csrf-token"> on the page.
 * If you get HTTP 422, reload the Canvas page and re-paste/re-run.
 *
 * GRADE SUPPORT
 * -------------
 * Grades are submitted as posted_grade via:
 *   PUT /api/v1/courses/:cid/assignments/:aid/submissions/:uid
 *   Body: { "submission": { "posted_grade": "85" } }
 * Accepts numeric grades and letter grades (e.g. "A", "B+").
 * The grade and comment can be sent in the same PUT call.
 * Verified working on canvas.auckland.ac.nz as of 2026-05.
 */

(function CanvasBulkFeedbackV4() {

  // Guard against double-load
  if (window.__CanvasFeedbackV4Loaded) {
    const existing = document.getElementById('cf-panel');
    if (existing) existing.style.display = 'block';
    console.log('[CanvasFeedback] Already loaded. Panel restored.');
    return;
  }
  window.__CanvasFeedbackV4Loaded = true;

  // ============================================================
  // CONFIG — mutable; UI picker overwrites course_id/assignment_id
  // ============================================================
  const CONFIG = {
    course_id:       null,   // set by UI picker or manually
    assignment_id:   null,   // set by UI picker or manually
    delay_ms:        1500,   // ms between PUT requests (keep ≥ 1000)
    dry_run:         false,  // log only, no actual requests
    skip_duplicates: true,   // skip if user already has a comment from me
    resume:          true,   // skip already-completed IDs (sessionStorage)
  };

  // ============================================================
  // CSRF token
  // ============================================================
  function getCSRFToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta?.content) return meta.content;
    const input = document.querySelector('input[name="authenticity_token"]');
    if (input?.value) return input.value;
    const m = document.cookie.match(/_csrf_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    throw new Error('CSRF token not found. Make sure you are on a Canvas page while logged in.');
  }

  function apiHeaders() {
    return {
      'Content-Type':     'application/json',
      'Accept':           'application/json',
      'X-CSRF-Token':     getCSRFToken(),
      'X-Requested-With': 'XMLHttpRequest',
    };
  }

  // ============================================================
  // Paginated fetch helper
  // ============================================================
  async function fetchAllPages(initialUrl) {
    const results = [];
    let url = initialUrl;
    while (url) {
      const resp = await fetch(url, { credentials: 'include', headers: apiHeaders() });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      results.push(...(Array.isArray(data) ? data : [data]));
      const link = resp.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return results;
  }

  // ============================================================
  // API calls
  // ============================================================
  async function fetchCourses() {
    return fetchAllPages('/api/v1/courses?per_page=50&enrollment_type=teacher&state[]=available&include[]=term');
  }

  function courseLabel(c) {
    // Prefer the enrolment term name; fall back to the year from start_at; fall back to course_code
    const term = c.term?.name;
    if (term) return `${c.name}  [${term}]`;
    const year = c.start_at ? new Date(c.start_at).getFullYear() : null;
    if (year) return `${c.name}  [${year}]`;
    if (c.course_code && c.course_code !== c.name) return `${c.name}  [${c.course_code}]`;
    return c.name;
  }

  async function fetchAssignments(courseId) {
    return fetchAllPages(`/api/v1/courses/${courseId}/assignments?per_page=50`);
  }

  async function fetchSubmissionMap(courseId, assignmentId) {
    log('Fetching submission roster…');
    const subs = await fetchAllPages(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions?per_page=100&include[]=user`
    );
    const map = {};
    subs.forEach(sub => {
      map[String(sub.user_id)] = {
        user_id:  sub.user_id,
        name:     sub.user?.name ?? String(sub.user_id),
        workflow: sub.workflow_state,
      };
    });
    log(`Loaded ${Object.keys(map).length} submission records.`);
    return map;
  }

  async function fetchCurrentUserId() {
    try {
      const resp = await fetch('/api/v1/users/self', { credentials: 'include', headers: apiHeaders() });
      if (!resp.ok) return null;
      return (await resp.json()).id;
    } catch { return null; }
  }

  async function fetchExistingComments(courseId, assignmentId, userId) {
    try {
      const resp = await fetch(
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}?include[]=submission_comments`,
        { credentials: 'include', headers: apiHeaders() }
      );
      if (!resp.ok) return [];
      return (await resp.json()).submission_comments ?? [];
    } catch { return []; }
  }

  async function putSubmission(courseId, assignmentId, userId, { grade, comment }) {
    const url = `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
    const body = {};
    if (comment) body.comment = { text_comment: comment };
    if (grade !== null && grade !== undefined && grade !== '') {
      body.submission = { posted_grade: String(grade) };
    }
    return fetch(url, {
      method:      'PUT',
      credentials: 'include',
      headers:     apiHeaders(),
      body:        JSON.stringify(body),
    });
  }

  // ============================================================
  // Resume state — sessionStorage per course+assignment
  // ============================================================
  function resumeKey(cid, aid) { return `cf_v4_${cid}_${aid}`; }

  function getCompletedIds(cid, aid) {
    try {
      const raw = sessionStorage.getItem(resumeKey(cid, aid));
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  }

  function markCompleted(cid, aid, uid) {
    try {
      const key = resumeKey(cid, aid);
      const set = getCompletedIds(cid, aid);
      set.add(String(uid));
      sessionStorage.setItem(key, JSON.stringify([...set]));
    } catch {}
  }

  function clearResume(cid, aid) {
    sessionStorage.removeItem(resumeKey(cid, aid));
  }

  // ============================================================
  // Parsers
  // ============================================================
  function parseCSV(csv) {
    const lines = csv.trim().split(/\r?\n/);
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    return lines.slice(1).filter(l => l.trim()).map(line => {
      const cols = [];
      let inQuote = false, cur = '';
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === ',' && !inQuote) { cols.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
      cols.push(cur.trim());
      const row = {};
      header.forEach((h, i) => { row[h] = (cols[i] ?? '').replace(/^"|"$/g, ''); });
      return row;
    });
  }

  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload  = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error('Failed to load SheetJS from CDN. Check your internet connection.'));
      document.head.appendChild(s);
    });
  }

  async function parseXLSX(file) {
    const XLSX = await loadSheetJS();
    const buf  = await file.arrayBuffer();
    const wb   = XLSX.read(buf, { type: 'array' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: '' });
  }

  function normalizeRows(rows) {
    return rows.map(r => {
      const out = {};
      for (const k of Object.keys(r)) out[k.toString().toLowerCase().trim()] = String(r[k] ?? '').trim();
      return out;
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ============================================================
  // UI state
  // ============================================================
  let logEl        = null;
  let progressBar  = null;
  let progressText = null;
  let statusDot    = null;
  let stopRequested = false;
  let currentUserId = null;

  // ============================================================
  // Logging (console + panel)
  // ============================================================
  function log(msg, type = 'info') {
    const prefix = '[CanvasFeedback]';
    if (type === 'ok')    console.log(`${prefix} ✓ ${msg}`);
    else if (type === 'error') console.error(`${prefix} ✗ ${msg}`);
    else if (type === 'warn')  console.warn(`${prefix} ⚠ ${msg}`);
    else                       console.log(`${prefix} ${msg}`);

    if (!logEl) return;
    const line = document.createElement('div');
    line.className = `cf-log-${type}`;
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.textContent = `${ts} ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setProgress(done, total, errors = 0) {
    if (!progressBar) return;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressBar.style.width = `${pct}%`;
    progressBar.style.background = errors > 0 ? '#c8271e' : '#0770a3';
    progressText.textContent = `${done} / ${total} done${errors > 0 ? ` · ${errors} error${errors > 1 ? 's' : ''}` : ''}`;
  }

  function setStatus(state) {
    if (!statusDot) return;
    statusDot.className = `cf-status-dot cf-status-${state}`;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ============================================================
  // Build floating UI panel
  // ============================================================
  function buildUI() {
    if (document.getElementById('cf-panel')) {
      document.getElementById('cf-panel').style.display = 'flex';
      return;
    }

    const style = document.createElement('style');
    style.id = 'cf-styles';
    style.textContent = `
      #cf-panel {
        position: fixed; top: 20px; right: 20px; z-index: 999999;
        width: 430px; background: #fff; border: 1px solid #c7cdd1;
        border-radius: 8px; box-shadow: 0 6px 28px rgba(0,0,0,.22);
        font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        font-size: 13px; color: #2d3b45; display: flex; flex-direction: column;
      }
      #cf-panel * { box-sizing: border-box; margin: 0; }
      #cf-header {
        background: #e66000; color: #fff; padding: 10px 14px;
        border-radius: 7px 7px 0 0; display: flex;
        align-items: center; justify-content: space-between;
        cursor: move; user-select: none; flex-shrink: 0;
      }
      #cf-header-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
      #cf-header-btns button {
        background: none; border: none; color: rgba(255,255,255,.85);
        font-size: 17px; cursor: pointer; padding: 0 3px; line-height: 1;
      }
      #cf-header-btns button:hover { color: #fff; }
      #cf-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
      .cf-panel-minimized #cf-body { display: none; }
      .cf-row { display: flex; flex-direction: column; gap: 3px; }
      .cf-label { font-weight: 500; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: .4px; }
      .cf-select {
        width: 100%; padding: 6px 8px; border: 1px solid #c7cdd1;
        border-radius: 4px; font-size: 13px; background: #fff;
      }
      .cf-select:focus { outline: none; border-color: #0770a3; }
      .cf-select:disabled { background: #f5f5f5; color: #9ca3af; }
      #cf-progress-track {
        height: 7px; background: #e8ecef; border-radius: 4px;
      }
      #cf-progress-bar {
        height: 100%; background: #0770a3; border-radius: 4px; width: 0%;
        transition: width .25s ease;
      }
      #cf-progress-text { font-size: 12px; color: #6b7280; }
      #cf-log {
        height: 150px; overflow-y: auto; background: #f7f8f9;
        border: 1px solid #e0e0e0; border-radius: 4px; padding: 6px 8px;
        font-family: "Cascadia Code","Consolas",monospace; font-size: 11px;
        line-height: 1.5;
      }
      .cf-log-info  { color: #374151; }
      .cf-log-ok    { color: #15803d; }
      .cf-log-warn  { color: #b45309; }
      .cf-log-error { color: #b91c1c; }
      .cf-btn {
        padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer;
        font-size: 13px; font-weight: 500; transition: opacity .15s;
      }
      .cf-btn:disabled { opacity: .45; cursor: default; }
      .cf-btn-primary   { background: #0770a3; color: #fff; }
      .cf-btn-primary:not(:disabled):hover { background: #0b5f88; }
      .cf-btn-danger    { background: #c8271e; color: #fff; }
      .cf-btn-danger:not(:disabled):hover  { background: #a32117; }
      .cf-btn-secondary { background: #e8ecef; color: #2d3b45; }
      .cf-btn-secondary:not(:disabled):hover { background: #d5dbdf; }
      .cf-btn-check     { background: #f0f4ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
      .cf-btn-check:not(:disabled):hover { background: #dbeafe; }
      .cf-dim { font-weight: 400; color: #9ca3af; }
      #cf-btn-row { display: flex; gap: 7px; flex-wrap: wrap; }
      .cf-checks { display: flex; flex-direction: column; gap: 5px; }
      .cf-check-row { display: flex; align-items: center; gap: 6px; cursor: pointer; }
      .cf-check-row input { cursor: pointer; }
      .cf-file-row { display: flex; align-items: center; gap: 8px; }
      .cf-file-btn {
        padding: 6px 12px; background: #e8ecef; border: none; border-radius: 4px;
        cursor: pointer; font-size: 13px; font-weight: 500; white-space: nowrap;
      }
      .cf-file-btn:hover { background: #d5dbdf; }
      #cf-file-name { font-size: 12px; color: #6b7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cf-status-dot {
        display: inline-block; width: 9px; height: 9px;
        border-radius: 50%; flex-shrink: 0;
      }
      .cf-status-idle    { background: rgba(255,255,255,.5); }
      .cf-status-running { background: #fbbf24; animation: cf-pulse 1s ease-in-out infinite; }
      .cf-status-done    { background: #4ade80; }
      .cf-status-error   { background: #f87171; }
      @keyframes cf-pulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }
      .cf-divider { border: none; border-top: 1px solid #e8ecef; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'cf-panel';
    panel.innerHTML = `
      <div id="cf-header">
        <div id="cf-header-title">
          Canvas Bulk Feedback v4
          <span id="cf-status-dot" class="cf-status-dot cf-status-idle" title="Status"></span>
        </div>
        <div id="cf-header-btns">
          <button id="cf-min-btn" title="Minimise">–</button>
          <button id="cf-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div id="cf-body">
        <div class="cf-row">
          <label class="cf-label">Course</label>
          <select id="cf-course-sel" class="cf-select">
            <option value="">Loading courses…</option>
          </select>
        </div>
        <div class="cf-row">
          <label class="cf-label">Assignment</label>
          <select id="cf-assign-sel" class="cf-select" disabled>
            <option value="">Select a course first</option>
          </select>
        </div>
        <hr class="cf-divider">
        <div class="cf-row">
          <label class="cf-label">Data file (CSV or XLSX)</label>
          <div class="cf-file-row">
            <label class="cf-file-btn" for="cf-file-input">📂 Choose file</label>
            <input type="file" id="cf-file-input" accept=".csv,.xlsx,.xls" style="display:none">
            <span id="cf-file-name">No file selected</span>
          </div>
        </div>
        <div class="cf-checks">
          <label class="cf-check-row"><input type="checkbox" id="cf-opt-dryrun"> <span>Dry run <span class="cf-dim">(log only — no changes made)</span></span></label>
          <label class="cf-check-row"><input type="checkbox" id="cf-opt-dupes" checked> Skip if I already posted a comment</label>
          <label class="cf-check-row"><input type="checkbox" id="cf-opt-resume" checked> Resume — skip already-completed students</label>
        </div>
        <hr class="cf-divider">
        <div id="cf-progress-track"><div id="cf-progress-bar"></div></div>
        <div id="cf-progress-text" style="font-size:12px;color:#6b7280">Ready</div>
        <div id="cf-log"></div>
        <div id="cf-btn-row">
          <button id="cf-check-btn" class="cf-btn cf-btn-check" disabled title="Validate file against Canvas roster — no changes made">🔍 Check file</button>
          <button id="cf-start-btn" class="cf-btn cf-btn-primary" disabled>▶ Start</button>
          <button id="cf-stop-btn"  class="cf-btn cf-btn-danger"  disabled>⏹ Stop</button>
          <button id="cf-clear-btn" class="cf-btn cf-btn-secondary" title="Clear resume state for this assignment">Clear resume</button>
          <button id="cf-roster-btn" class="cf-btn cf-btn-secondary" title="Print roster to console">Roster →</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    logEl        = document.getElementById('cf-log');
    progressBar  = document.getElementById('cf-progress-bar');
    progressText = document.getElementById('cf-progress-text');
    statusDot    = document.getElementById('cf-status-dot');

    makeDraggable(panel, document.getElementById('cf-header'));

    document.getElementById('cf-min-btn').onclick = () => panel.classList.toggle('cf-panel-minimized');
    document.getElementById('cf-close-btn').onclick = () => {
      panel.remove();
      document.getElementById('cf-styles')?.remove();
      window.__CanvasFeedbackV4Loaded = false;
      logEl = progressBar = progressText = statusDot = null;
    };

    // File picker
    const fileInput  = document.getElementById('cf-file-input');
    const fileNameEl = document.getElementById('cf-file-name');
    fileInput.onchange = () => {
      fileNameEl.textContent = fileInput.files[0]?.name ?? 'No file selected';
      checkStartButton();
    };

    // Course picker
    const courseSel = document.getElementById('cf-course-sel');
    const assignSel = document.getElementById('cf-assign-sel');

    courseSel.onchange = async () => {
      const cid = courseSel.value;
      CONFIG.course_id    = cid || null;
      CONFIG.assignment_id = null;
      assignSel.innerHTML = '<option value="">Loading assignments…</option>';
      assignSel.disabled  = true;
      checkStartButton();
      if (!cid) return;
      try {
        const assigns = await fetchAssignments(cid);
        assigns.sort((a, b) => (b.due_at ?? '').localeCompare(a.due_at ?? ''));
        assignSel.innerHTML = '<option value="">Select assignment…</option>' +
          assigns.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
        assignSel.disabled = false;
      } catch (e) {
        log('Failed to load assignments: ' + e.message, 'error');
        assignSel.innerHTML = '<option value="">Error loading assignments</option>';
      }
    };

    assignSel.onchange = () => {
      CONFIG.assignment_id = assignSel.value || null;
      checkStartButton();
    };

    // Options
    document.getElementById('cf-opt-dryrun').onchange  = e => { CONFIG.dry_run         = e.target.checked; updateStartLabel(); };
    document.getElementById('cf-opt-dupes').onchange   = e => { CONFIG.skip_duplicates = e.target.checked; };
    document.getElementById('cf-opt-resume').onchange  = e => { CONFIG.resume          = e.target.checked; };

    // Buttons
    document.getElementById('cf-check-btn').onclick  = checkFile;
    document.getElementById('cf-start-btn').onclick  = startRun;
    document.getElementById('cf-stop-btn').onclick   = () => { stopRequested = true; log('Stop requested…', 'warn'); };
    document.getElementById('cf-clear-btn').onclick  = () => {
      if (!CONFIG.course_id || !CONFIG.assignment_id) { log('Select course + assignment first.', 'warn'); return; }
      clearResume(CONFIG.course_id, CONFIG.assignment_id);
      log('Resume state cleared for this assignment.', 'warn');
    };
    document.getElementById('cf-roster-btn').onclick = async () => {
      if (!CONFIG.course_id || !CONFIG.assignment_id) { log('Select course + assignment first.', 'warn'); return; }
      try {
        const map = await fetchSubmissionMap(CONFIG.course_id, CONFIG.assignment_id);
        console.table(Object.values(map));
        log(`Roster printed to console (${Object.keys(map).length} students).`);
      } catch (e) { log('Roster failed: ' + e.message, 'error'); }
    };

    // Load courses
    fetchCourses().then(courses => {
      // Sort by name, then by term start descending so newest appears first within same name
      courses.sort((a, b) => {
        const nameSort = (a.name ?? '').localeCompare(b.name ?? '');
        if (nameSort !== 0) return nameSort;
        return (b.start_at ?? '').localeCompare(a.start_at ?? '');
      });
      courseSel.innerHTML = '<option value="">Select course…</option>' +
        courses.map(c => `<option value="${c.id}">${escHtml(courseLabel(c))}</option>`).join('');
      log(`Loaded ${courses.length} teacher courses.`);
    }).catch(e => {
      log('Failed to load courses: ' + e.message, 'error');
      courseSel.innerHTML = '<option value="">Error loading courses</option>';
    });

    // Fetch current user ID for duplicate guard
    fetchCurrentUserId().then(id => { currentUserId = id; });
  }

  function checkStartButton() {
    const ready = !!(CONFIG.course_id && CONFIG.assignment_id &&
                     document.getElementById('cf-file-input')?.files?.length);
    const startBtn = document.getElementById('cf-start-btn');
    const checkBtn = document.getElementById('cf-check-btn');
    if (startBtn) startBtn.disabled = !ready;
    if (checkBtn) checkBtn.disabled = !ready;
    updateStartLabel();
  }

  function updateStartLabel() {
    const btn = document.getElementById('cf-start-btn');
    if (!btn) return;
    btn.textContent = CONFIG.dry_run ? '▶ Start (dry run)' : '▶ Start';
    btn.style.background = CONFIG.dry_run ? '#6b7280' : '';
  }

  function makeDraggable(el, handle) {
    let ox, oy, mx, my;
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      mx = e.clientX; my = e.clientY;
      const onMove = ev => {
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
        el.style.left   = (ox + ev.clientX - mx) + 'px';
        el.style.top    = (oy + ev.clientY - my) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ============================================================
  // Core run loop (used by both UI and console API)
  // ============================================================
  async function runRows(rows, courseId, assignmentId) {
    const startBtn = document.getElementById('cf-start-btn');
    const stopBtn  = document.getElementById('cf-stop-btn');
    if (startBtn) startBtn.disabled = true;
    if (stopBtn)  stopBtn.disabled  = false;
    stopRequested = false;
    setStatus('running');

    rows = normalizeRows(rows);

    let submissionMap;
    try {
      submissionMap = await fetchSubmissionMap(courseId, assignmentId);
    } catch (e) {
      log('Failed to load submission roster: ' + e.message, 'error');
      setStatus('error');
      if (startBtn) startBtn.disabled = false;
      if (stopBtn)  stopBtn.disabled  = true;
      return;
    }

    const completedIds = CONFIG.resume ? getCompletedIds(courseId, assignmentId) : new Set();
    if (completedIds.size > 0) log(`Resume: ${completedIds.size} already completed — skipping.`, 'warn');

    const results = { ok: 0, skipped: 0, error: 0, notFound: 0, dry_run: 0 };
    const total   = rows.length;

    for (let i = 0; i < rows.length; i++) {
      if (stopRequested) { log('Stopped by user.', 'warn'); break; }

      const row     = rows[i];
      const sid     = String(row.student_id ?? '').trim();
      const grade   = row.grade?.trim()   || null;
      const comment = row.comment?.trim() || null;

      if (!sid) {
        log(`Row ${i + 2}: missing student_id — skipping.`, 'warn');
        results.skipped++;
        setProgress(i + 1, total, results.error);
        continue;
      }

      if (completedIds.has(sid)) {
        results.skipped++;
        setProgress(i + 1, total, results.error);
        continue;
      }

      const sub = submissionMap[sid];
      if (!sub) {
        log(`Row ${i + 2}: student_id ${sid} not in roster — skipping.`, 'warn');
        results.notFound++;
        setProgress(i + 1, total, results.error);
        continue;
      }

      if (!grade && !comment) {
        log(`${sub.name} (${sid}): nothing to post — skipping.`, 'warn');
        results.skipped++;
        setProgress(i + 1, total, results.error);
        continue;
      }

      // Duplicate guard
      if (CONFIG.skip_duplicates && comment && currentUserId) {
        try {
          const existing = await fetchExistingComments(courseId, assignmentId, sid);
          const mine = existing.filter(c => c.author_id === currentUserId);
          if (mine.length > 0) {
            log(`${sub.name} (${sid}): already has ${mine.length} comment from me — skipping.`, 'warn');
            results.skipped++;
            markCompleted(courseId, assignmentId, sid);
            setProgress(i + 1, total, results.error);
            if (i < rows.length - 1) await sleep(400);
            continue;
          }
        } catch (_) { /* proceed if check fails */ }
      }

      if (CONFIG.dry_run) {
        log(`[DRY RUN] ${sub.name} (${sid}) — grade: ${grade ?? '—'}  comment: ${comment?.slice(0, 60) ?? '—'}`, 'info');
        results.dry_run++;
        markCompleted(courseId, assignmentId, sid);
        setProgress(i + 1, total, results.error);
        if (i < rows.length - 1) await sleep(150);
        continue;
      }

      try {
        const resp = await putSubmission(courseId, assignmentId, sid, { grade, comment });
        if (resp.ok) {
          const preview = comment ? `"${comment.slice(0, 55)}${comment.length > 55 ? '…' : ''}"` : '—';
          log(`${sub.name} (${sid}) — grade: ${grade ?? '—'}  comment: ${preview}`, 'ok');
          results.ok++;
          markCompleted(courseId, assignmentId, sid);
        } else {
          const errBody = await resp.text();
          log(`${sub.name} (${sid}): HTTP ${resp.status} — ${errBody.slice(0, 120)}`, 'error');
          if (resp.status === 422) log('422 = stale CSRF token. Reload the Canvas page and re-run.', 'warn');
          results.error++;
        }
      } catch (e) {
        log(`${sub.name} (${sid}): ${e.message}`, 'error');
        results.error++;
      }

      setProgress(i + 1, total, results.error);
      if (i < rows.length - 1) await sleep(CONFIG.delay_ms);
    }

    const summary = `Done — ✓ ${results.ok}  skipped: ${results.skipped}  errors: ${results.error}  not found: ${results.notFound}${CONFIG.dry_run ? `  dry-run: ${results.dry_run}` : ''}`;
    log(summary, results.error > 0 ? 'error' : 'ok');
    setProgress(total, total, results.error);
    setStatus(results.error > 0 ? 'error' : 'done');
    progressText.textContent = summary;

    if (startBtn) startBtn.disabled = false;
    if (stopBtn)  stopBtn.disabled  = true;
    return results;
  }

  // ============================================================
  // Check file — read-only preflight validation, zero writes
  // ============================================================
  async function checkFile() {
    const fileInput = document.getElementById('cf-file-input');
    const file = fileInput?.files?.[0];
    if (!file || !CONFIG.course_id || !CONFIG.assignment_id) {
      log('Select course, assignment, and file first.', 'warn'); return;
    }

    const checkBtn = document.getElementById('cf-check-btn');
    const startBtn = document.getElementById('cf-start-btn');
    checkBtn.disabled = true;
    startBtn.disabled = true;
    logEl.innerHTML = '';
    setProgress(0, 0);
    setStatus('running');
    log('🔍 Running preflight check (read-only — nothing will be changed)…');

    // Parse file
    let rows;
    try {
      if (/\.xlsx?$/i.test(file.name)) {
        log('Loading SheetJS for xlsx parsing…');
        rows = await parseXLSX(file);
      } else {
        rows = parseCSV(await file.text());
      }
      rows = normalizeRows(rows);
      log(`Parsed ${rows.length} row${rows.length !== 1 ? 's' : ''} from ${file.name}.`);
    } catch (e) {
      log('File parse error: ' + e.message, 'error');
      setStatus('error');
      checkBtn.disabled = false;
      startBtn.disabled = false;
      return;
    }

    // Fetch roster
    let submissionMap;
    try {
      submissionMap = await fetchSubmissionMap(CONFIG.course_id, CONFIG.assignment_id);
    } catch (e) {
      log('Failed to load Canvas roster: ' + e.message, 'error');
      setStatus('error');
      checkBtn.disabled = false;
      startBtn.disabled = false;
      return;
    }

    const completedIds = CONFIG.resume
      ? getCompletedIds(CONFIG.course_id, CONFIG.assignment_id)
      : new Set();

    // Tally each row
    const issues  = { notFound: [], blankRow: [], missingId: [] };
    const counts  = { willPost: 0, gradeOnly: 0, commentOnly: 0, both: 0,
                      alreadyDone: 0, blankSkip: 0, notFound: 0, missingId: 0 };

    rows.forEach((row, i) => {
      const sid     = String(row.student_id ?? '').trim();
      const grade   = row.grade?.trim()   || null;
      const comment = row.comment?.trim() || null;

      if (!sid) {
        issues.missingId.push(`Row ${i + 2}`);
        counts.missingId++;
        return;
      }
      if (completedIds.has(sid)) {
        counts.alreadyDone++;
        return;
      }
      if (!submissionMap[sid]) {
        issues.notFound.push(sid);
        counts.notFound++;
        return;
      }
      if (!grade && !comment) {
        issues.blankRow.push(`Row ${i + 2} (${sid})`);
        counts.blankSkip++;
        return;
      }
      counts.willPost++;
      if (grade && comment) counts.both++;
      else if (grade)        counts.gradeOnly++;
      else                   counts.commentOnly++;
    });

    // Report
    log('──────────────────────────────────────');
    log(`File rows:         ${rows.length}`);
    log(`Canvas roster:     ${Object.keys(submissionMap).length} students`);
    log('──────────────────────────────────────');

    if (counts.willPost > 0) {
      log(`✓ Will post to:    ${counts.willPost} student${counts.willPost !== 1 ? 's' : ''}`, 'ok');
      if (counts.both)        log(`    grade + comment: ${counts.both}`, 'ok');
      if (counts.gradeOnly)   log(`    grade only:      ${counts.gradeOnly}`, 'ok');
      if (counts.commentOnly) log(`    comment only:    ${counts.commentOnly}`, 'ok');
    }
    if (counts.alreadyDone > 0)
      log(`⏭ Resume skip:     ${counts.alreadyDone} already completed`, 'warn');
    if (counts.blankSkip > 0)
      log(`⚠ Blank rows:      ${counts.blankSkip} (no grade or comment — will skip)`, 'warn');
    if (counts.missingId > 0)
      log(`⚠ Missing ID:      ${counts.missingId} row${counts.missingId !== 1 ? 's' : ''} have no student_id`, 'warn');
    if (counts.notFound > 0) {
      log(`✗ Not in roster:   ${counts.notFound} student ID${counts.notFound !== 1 ? 's' : ''} not found`, 'error');
      issues.notFound.slice(0, 10).forEach(id => log(`    → ${id}`, 'error'));
      if (issues.notFound.length > 10)
        log(`    … and ${issues.notFound.length - 10} more (see console for full list)`, 'error');
      console.warn('[CanvasFeedback] Not-found IDs:', issues.notFound);
    }

    log('──────────────────────────────────────');
    const ok = counts.notFound === 0 && counts.missingId === 0;
    if (ok && counts.willPost > 0) {
      log(`✓ All clear — ready to post to ${counts.willPost} student${counts.willPost !== 1 ? 's' : ''}. Click ▶ Start when ready.`, 'ok');
    } else if (counts.willPost === 0) {
      log('Nothing to post — check your file has grade or comment values.', 'warn');
    } else {
      log(`Issues found. Fix the ${counts.notFound + counts.missingId} problem row${(counts.notFound + counts.missingId) !== 1 ? 's' : ''} before running.`, 'error');
    }

    setProgress(rows.length, rows.length, counts.notFound + counts.missingId);
    setStatus(ok ? 'done' : 'error');
    checkBtn.disabled = false;
    startBtn.disabled = false;
  }

  // UI start button handler
  async function startRun() {
    const fileInput = document.getElementById('cf-file-input');
    const file = fileInput?.files?.[0];
    if (!file || !CONFIG.course_id || !CONFIG.assignment_id) {
      log('Select course, assignment, and file first.', 'warn'); return;
    }
    logEl.innerHTML = '';
    setProgress(0, 0);

    let rows;
    try {
      if (/\.xlsx?$/i.test(file.name)) {
        log('Loading SheetJS for xlsx parsing…');
        rows = await parseXLSX(file);
      } else {
        rows = parseCSV(await file.text());
      }
      log(`Parsed ${rows.length} rows from ${file.name}.`);
    } catch (e) {
      log('File parse error: ' + e.message, 'error');
      setStatus('error');
      return;
    }

    await runRows(rows, CONFIG.course_id, CONFIG.assignment_id);
  }

  // ============================================================
  // PUBLIC CONSOLE API
  // ============================================================

  /**
   * Diagnostic probe — posts a dummy comment to one student.
   * Delete the comment from SpeedGrader afterward.
   *
   *   await CanvasFeedback.probe(438886)
   *   await CanvasFeedback.probe(438886, 141663, 493156)  // explicit IDs
   */
  async function probe(studentId, courseId = CONFIG.course_id, assignmentId = CONFIG.assignment_id) {
    if (!courseId || !assignmentId) {
      console.error('[CanvasFeedback] Provide courseId + assignmentId, or set CONFIG.course_id/assignment_id.');
      return;
    }
    console.log(`\n[CanvasFeedback] ===== PROBE for student ${studentId} =====`);
    let map;
    try { map = await fetchSubmissionMap(courseId, assignmentId); } catch (e) { console.error(e.message); return; }
    const sub = map[String(studentId)];
    if (!sub) { console.error(`Student ${studentId} not found. Run printRoster() to see valid IDs.`); return; }
    console.log('Submission record:', sub);
    const url  = `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${studentId}`;
    const body = { comment: { text_comment: '__PROBE_TEST__ please ignore and delete' } };
    console.log('PUT', url);
    const resp = await fetch(url, { method: 'PUT', credentials: 'include', headers: apiHeaders(), body: JSON.stringify(body) });
    const text = await resp.text();
    console.log(`HTTP ${resp.status}`, text.slice(0, 400));
    console.log(resp.ok ? '✓ Probe succeeded! (delete the dummy comment from SpeedGrader)' : '✗ Probe failed.');
    if (resp.status === 422) console.warn('422 = stale CSRF token — reload the Canvas page and re-paste the script.');
    console.log('===== PROBE COMPLETE =====\n');
  }

  /**
   * Print submission roster to console — verify your student_ids.
   *
   *   await CanvasFeedback.printRoster()
   *   await CanvasFeedback.printRoster(141663, 493156)
   */
  async function printRoster(courseId = CONFIG.course_id, assignmentId = CONFIG.assignment_id) {
    if (!courseId || !assignmentId) {
      console.error('[CanvasFeedback] Provide courseId + assignmentId, or set CONFIG.course_id/assignment_id.');
      return;
    }
    const map = await fetchSubmissionMap(courseId, assignmentId);
    console.table(Object.values(map).map(s => ({
      student_id: s.user_id, name: s.name, workflow: s.workflow,
    })));
    return map;
  }

  /**
   * Post to one student — useful for testing before a bulk run.
   *
   *   await CanvasFeedback.single(438886, 'Great work.', 85)
   *   await CanvasFeedback.single(438886, 'See rubric.')     // comment only
   *   await CanvasFeedback.single(438886, '', 72)            // grade only
   */
  async function single(studentId, comment = '', grade = '',
                        courseId = CONFIG.course_id, assignmentId = CONFIG.assignment_id) {
    return bulkFromArray([{ student_id: String(studentId), comment, grade }], courseId, assignmentId);
  }

  /**
   * Bulk upload from a JS array.
   *
   *   await CanvasFeedback.bulkFromArray([
   *     { student_id: '438886', grade: '85', comment: 'Excellent.' },
   *     { student_id: '123456', comment: 'Check units.' },
   *   ])
   */
  async function bulkFromArray(rows, courseId = CONFIG.course_id, assignmentId = CONFIG.assignment_id) {
    if (!courseId || !assignmentId) {
      console.error('[CanvasFeedback] Provide courseId + assignmentId, or set CONFIG.course_id/assignment_id.');
      return;
    }
    const saved = { cid: CONFIG.course_id, aid: CONFIG.assignment_id };
    CONFIG.course_id    = courseId;
    CONFIG.assignment_id = assignmentId;
    const result = await runRows(rows, courseId, assignmentId);
    CONFIG.course_id    = saved.cid;
    CONFIG.assignment_id = saved.aid;
    return result;
  }

  /**
   * Bulk upload from a CSV string.
   *
   *   await CanvasFeedback.bulkFromCSV(`
   *     student_id,grade,comment
   *     438886,85,Excellent structural analysis.
   *     123456,,Check your load path diagrams.
   *   `)
   */
  async function bulkFromCSV(csvString, courseId = CONFIG.course_id, assignmentId = CONFIG.assignment_id) {
    const rows = parseCSV(csvString);
    console.log(`[CanvasFeedback] Parsed ${rows.length} rows from CSV string.`);
    return bulkFromArray(rows, courseId, assignmentId);
  }

  // ============================================================
  // Expose public API + launch UI
  // ============================================================
  window.CanvasFeedback = { probe, printRoster, single, bulkFromArray, bulkFromCSV, CONFIG, buildUI };

  buildUI();

  console.log(
    '%c Canvas Bulk Feedback v4 ready ',
    'background:#e66000;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px'
  );
  console.log('[CanvasFeedback] UI panel injected. Console API: window.CanvasFeedback');

})();
