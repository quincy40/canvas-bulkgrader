/**
 * ============================================================
 * Canvas Bulk Feedback Uploader  v3
 * University of Auckland — browser console script
 * ============================================================
 *
 * WHAT CHANGED IN v3
 * ------------------
 * Uses PUT /api/v1/courses/.../submissions/:user_id with a JSON
 * body and X-CSRF-Token header. This is what modern Canvas
 * SpeedGrader actually does — the old form-POST approach only
 * works on older Canvas instances.
 *
 * USAGE
 * -----
 * 1. Log into Canvas. Go to the Gradebook or SpeedGrader page
 *    for your course/assignment.
 * 2. DevTools ? Console ? paste this script ? Enter.
 * 3. Run: await CanvasFeedback.probe(438886)
 *    If you see HTTP 200 and a JSON submission object, it works.
 * 4. Run bulk upload (see examples below).
 *
 * QUICK EXAMPLES
 * --------------
 *   // Check roster
 *   await CanvasFeedback.printRoster()
 *
 *   // Test one student
 *   await CanvasFeedback.single(438886, 'Great work.', 85)
 *
 *   // Bulk from CSV string
 *   await CanvasFeedback.bulkFromCSV(`
 *     student_id,grade,comment
 *     438886,85,Excellent structural analysis.
 *     123456,,Check your load path diagrams.
 *     789012,71,Good effort — see rubric notes.
 *   `)
 *
 * CSV FORMAT
 * ----------
 * student_id,grade,comment
 * 438886,85,Great work on the structural analysis.
 * 123456,,Good effort but check your load calculations.
 * 789012,72,
 *
 * student_id = Canvas user ID (integer)
 * grade      = numeric or letter grade — leave blank to skip
 * comment    = text comment — leave blank to skip
 * At least one of grade/comment must be present per row.
 */
 
(async function CanvasBulkFeedbackV3() {
 
  // ============================================================
  // CONFIG — edit course_id / assignment_id if needed
  // ============================================================
  const CONFIG = {
    course_id:     141663,
    assignment_id: 493156,
    delay_ms:      1500,    // ms between requests — keep = 1000
    dry_run:       false,   // true = log only, no actual requests
  };
 
  // ============================================================
  // CSRF token — required as X-CSRF-Token header on API calls
  // ============================================================
  function getCSRFToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta?.content) return meta.content;
    const input = document.querySelector('input[name="authenticity_token"]');
    if (input?.value) return input.value;
    const match = document.cookie.match(/_csrf_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
    throw new Error(
      'CSRF token not found. Make sure you are on a Canvas page while logged in.'
    );
  }
 
  // ============================================================
  // Shared fetch headers for all API calls
  // ============================================================
  function apiHeaders(csrfToken) {
    return {
      'Content-Type':     'application/json',
      'Accept':           'application/json',
      'X-CSRF-Token':     csrfToken,
      'X-Requested-With': 'XMLHttpRequest',
    };
  }
 
  // ============================================================
  // Fetch submission map: user_id (string) ? submission record
  // ============================================================
  async function fetchSubmissionMap() {
    console.log('[Canvas] Fetching submissions from API...');
    const csrfToken = getCSRFToken();
    const map = {};
    let url = `/api/v1/courses/${CONFIG.course_id}/assignments/${CONFIG.assignment_id}`
            + `/submissions?per_page=100&include[]=user`;
 
    while (url) {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: apiHeaders(csrfToken),
      });
      if (!resp.ok) {
        throw new Error(`Submission list fetch failed: HTTP ${resp.status}\n${await resp.text()}`);
      }
      const data = await resp.json();
      data.forEach(sub => {
        map[String(sub.user_id)] = {
          user_id:      sub.user_id,
          sub_id:       sub.id,
          anon_id:      sub.anonymous_id,
          name:         sub.user?.name ?? String(sub.user_id),
          workflow:     sub.workflow_state,
        };
      });
      const link = resp.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
 
    console.log(`[Canvas] Loaded ${Object.keys(map).length} submission records.`);
    return map;
  }
 
  // ============================================================
  // PUT one submission via the JSON API
  // Canvas accepts session cookies + X-CSRF-Token header here —
  // no Bearer token needed.
  // ============================================================
  async function putSubmission({ userID, grade, comment, csrfToken }) {
    const url = `/api/v1/courses/${CONFIG.course_id}/assignments/${CONFIG.assignment_id}/submissions/${userID}`;
 
    const body = {};
 
    if (comment) {
      body.comment = { text_comment: comment };
    }
 
    if (grade !== null && grade !== undefined && grade !== '') {
      body.submission = { posted_grade: String(grade) };
    }
 
    return fetch(url, {
      method:      'PUT',
      credentials: 'include',
      headers:     apiHeaders(csrfToken),
      body:        JSON.stringify(body),
    });
  }
 
  // ============================================================
  // Post feedback for one student
  // ============================================================
  async function postFeedback({ sub, grade, comment, csrfToken }) {
    const label = `${sub.name} (uid:${sub.user_id})`;
 
    if (!grade && !comment) {
      console.warn(`[Canvas] ??  ${label} — nothing to post.`);
      return { status: 'skipped', label };
    }
 
    if (CONFIG.dry_run) {
      console.log(`[Canvas DRY RUN] ${label}: grade=${grade||'—'} comment=${comment?.slice(0,60)||'—'}`);
      return { status: 'dry_run', label };
    }
 
    const resp = await putSubmission({
      userID:   sub.user_id,
      grade,
      comment,
      csrfToken,
    });
 
    if (resp.ok) {
      const commentPreview = comment
        ? `"${comment.slice(0, 55)}${comment.length > 55 ? '…' : ''}"`
        : '—';
      console.log(`[Canvas] ?  ${label} — grade:${grade||'—'}  comment:${commentPreview}`);
      return { status: 'ok', label };
    }
 
    const errText = await resp.text();
    console.error(`[Canvas] ?  ${label} — HTTP ${resp.status}`);
    console.error('           ', errText.slice(0, 300));
    return { status: 'error', label, http: resp.status, body: errText };
  }
 
  // ============================================================
  // CSV parser (handles quoted fields with commas inside)
  // ============================================================
  function parseCSV(csv) {
    const lines = csv.trim().split('\n');
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
 
  const sleep = ms => new Promise(r => setTimeout(r, ms));
 
  // ============================================================
  // PUBLIC API
  // ============================================================
 
  /**
   * DIAGNOSTIC — run this first to confirm the API is working.
   * Posts a dummy comment to one student. Delete it manually
   * from SpeedGrader if it goes through.
   *
   *   await CanvasFeedback.probe(438886)
   */
  async function probe(studentId) {
    console.log(`\n[Canvas] ===== PROBE for student ${studentId} =====`);
    let csrfToken, map;
    try {
      csrfToken = getCSRFToken();
      console.log('[Canvas] CSRF token found:', csrfToken.slice(0, 20) + '…');
      map = await fetchSubmissionMap();
    } catch (e) {
      console.error('[Canvas] Init failed:', e.message);
      return;
    }
 
    const sub = map[String(studentId)];
    if (!sub) {
      console.error(`[Canvas] Student ${studentId} not found. Run printRoster() to see valid IDs.`);
      return;
    }
    console.log('[Canvas] Submission record:', sub);
 
    const url = `/api/v1/courses/${CONFIG.course_id}/assignments/${CONFIG.assignment_id}/submissions/${studentId}`;
    const body = { comment: { text_comment: '__PROBE_TEST__ please ignore and delete' } };
 
    console.log('[Canvas] Sending probe PUT to:', url);
    console.log('[Canvas] Body:', JSON.stringify(body));
 
    const resp = await fetch(url, {
      method:      'PUT',
      credentials: 'include',
      headers:     apiHeaders(csrfToken),
      body:        JSON.stringify(body),
    });
 
    const text = await resp.text();
    console.log(`[Canvas] Status: ${resp.status} ${resp.statusText}`);
    console.log('[Canvas] Response (first 400 chars):', text.slice(0, 400));
 
    if (resp.ok) {
      console.log('\n[Canvas] ? Probe succeeded! The API is working.');
      console.log('[Canvas] ??  A dummy comment was posted — please delete it from SpeedGrader.');
    } else {
      console.log('\n[Canvas] ? Probe failed. See status + response above for clues.');
      if (resp.status === 422) {
        console.log('[Canvas] 422 often means stale CSRF token — reload the page and re-paste the script.');
      }
    }
    console.log('[Canvas] ===== PROBE COMPLETE =====\n');
  }
 
  /**
   * Show submission roster — verify your student_ids match Canvas.
   *
   *   await CanvasFeedback.printRoster()
   */
  async function printRoster() {
    const map = await fetchSubmissionMap();
    console.table(Object.values(map).map(s => ({
      student_id:    s.user_id,
      name:          s.name,
      anonymous_id:  s.anon_id,
      workflow:      s.workflow,
    })));
    return map;
  }
 
  /**
   * Post to one student — good for testing before bulk run.
   *
   *   await CanvasFeedback.single(438886, 'Great work.', 85)
   *   await CanvasFeedback.single(438886, 'See rubric.')        // comment only
   *   await CanvasFeedback.single(438886, '', 72)               // grade only
   */
  async function single(studentId, comment = '', grade = '') {
    return bulkFromArray([{
      student_id: String(studentId),
      comment:    String(comment),
      grade:      String(grade),
    }]);
  }
 
  /**
   * Bulk upload from a JS array of objects.
   *
   *   await CanvasFeedback.bulkFromArray([
   *     { student_id: '438886', grade: '85', comment: 'Excellent.' },
   *     { student_id: '123456', comment: 'Check units.' },
   *   ])
   */
  async function bulkFromArray(rows) {
    let csrfToken, map;
    try {
      csrfToken = getCSRFToken();
      map = await fetchSubmissionMap();
    } catch (e) {
      console.error('[Canvas] Init failed:', e.message);
      return;
    }
 
    const results = { ok: 0, skipped: 0, error: 0, notFound: 0, dry_run: 0 };
 
    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i];
      const sid  = String(row.student_id || '').trim();
 
      if (!sid) {
        console.warn(`[Canvas] Row ${i + 2}: missing student_id — skipping.`);
        results.skipped++;
        continue;
      }
 
      const sub = map[sid];
      if (!sub) {
        console.warn(`[Canvas] Row ${i + 2}: student_id ${sid} not found in submission list — skipping.`);
        results.notFound++;
        continue;
      }
 
      const result = await postFeedback({
        sub,
        grade:    row.grade?.trim()   || null,
        comment:  row.comment?.trim() || null,
        csrfToken,
      });
 
      results[result.status] = (results[result.status] || 0) + 1;
 
      if (i < rows.length - 1) await sleep(CONFIG.delay_ms);
    }
 
    console.log('\n[Canvas] ====== SUMMARY ======');
    console.log(`  ?  Success  : ${results.ok}`);
    console.log(`  ??  Skipped  : ${results.skipped}`);
    console.log(`  ?  Errors   : ${results.error}`);
    console.log(`  ?? Not found : ${results.notFound}`);
    if (CONFIG.dry_run) console.log(`  ?? Dry run   : ${results.dry_run}`);
    return results;
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
  async function bulkFromCSV(csvString) {
    const rows = parseCSV(csvString);
    console.log(`[Canvas] Parsed ${rows.length} rows from CSV.`);
    return bulkFromArray(rows);
  }
 
  window.CanvasFeedback = { probe, printRoster, single, bulkFromArray, bulkFromCSV, CONFIG };
 
  console.log(`
+-------------------------------------------------------+
¦      Canvas Bulk Feedback Uploader  v3 — Ready        ¦
¦-------------------------------------------------------¦
¦  Course:      ${String(CONFIG.course_id).padEnd(39)}¦
¦  Assignment:  ${String(CONFIG.assignment_id).padEnd(39)}¦
¦  Dry run:     ${String(CONFIG.dry_run).padEnd(39)}¦
¦-------------------------------------------------------¦
¦  START HERE:                                          ¦
¦    await CanvasFeedback.probe(438886)                 ¦
¦                                                       ¦
¦  Then:                                                ¦
¦    await CanvasFeedback.printRoster()                 ¦
¦    await CanvasFeedback.single(438886, 'comment', 85) ¦
¦    await CanvasFeedback.bulkFromCSV(csvString)        ¦
+-------------------------------------------------------+
`);
 
})();