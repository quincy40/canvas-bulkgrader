# Canvas Bulk Feedback Uploader

Browser console script for bulk-uploading grades and comments to Canvas LMS — University of Auckland (`canvas.auckland.ac.nz`).

> **Auth model:** session-cookie + `X-CSRF-Token` header. No API token required.  
> **Tested on:** canvas.auckland.ac.nz · Canvas LMS 2024–2026

---

## Quick start

### Option A — Bookmarklet (recommended)

1. Open `bookmarklet.txt` and copy the `javascript:` line.
2. Create a new browser bookmark, paste it as the URL. Name it *Canvas Bulk Feedback*.
3. Log into Canvas, then click the bookmark.
4. A floating panel appears. Pick your course + assignment, load a file, click **▶ Start**.

### Option B — Paste into console

1. Log into Canvas. Open DevTools → Console.
2. Copy `canvas_bulk_feedback_v4.js` and paste it into the console → Enter.
3. The floating panel appears automatically.

---

## File format

The input must be a **CSV** or **XLSX** file. The first row must be a header.  
Required columns: `student_id`, `grade`, `comment`

```
student_id,grade,comment
438886,85,Excellent structural analysis.
123456,,Check your load path diagrams.
789012,71,Good effort — see rubric notes.
```

| Column | Required | Notes |
|--------|----------|-------|
| `student_id` | ✓ | Canvas user ID (integer). Find it via the **Roster →** button in the panel, or `printRoster()` in the console. |
| `grade` | one of the two | Numeric or letter grade (e.g. `85`, `A`, `B+`). Leave blank to skip grade update. |
| `comment` | one of the two | Plain text. Leave blank to skip comment. |

At least one of `grade` / `comment` must be non-empty per row.

---

## UI panel features

| Feature | Detail |
|---------|--------|
| **Course + assignment picker** | Fetches your active teacher courses via `/api/v1/courses`; populates assignments on selection |
| **File picker** | CSV or XLSX accepted; SheetJS loaded from CDN on demand for `.xlsx` files |
| **Progress bar** | Updates after every student; turns red on errors |
| **Live log** | Colour-coded (green = ok, amber = skipped, red = error) |
| **Dry run** | Logs everything, makes no API calls |
| **Skip duplicate comments** | Before posting, checks if the current logged-in user already left a comment — skips if found |
| **Resume** | Completed student IDs are saved to `sessionStorage`; interrupted runs pick up where they left off |
| **Clear resume** | Button resets the saved progress for the selected assignment |
| **Roster →** | Prints the full submission roster to the browser console (`console.table`) |
| **Draggable** | Drag by the header; minimise with `–`; close with `✕` |

---

## Grade support

Grades are submitted as `posted_grade` in the same PUT call as the comment:

```http
PUT /api/v1/courses/:cid/assignments/:aid/submissions/:uid
Content-Type: application/json
X-CSRF-Token: <token>

{
  "submission": { "posted_grade": "85" },
  "comment":    { "text_comment": "Great work." }
}
```

Accepts numeric grades and letter grades (where the assignment uses a letter-grade scheme).  
Verified working on canvas.auckland.ac.nz as of 2026-05.

---

## Console API

The `window.CanvasFeedback` object is available after the script loads:

```js
// Diagnostic: POST a dummy comment to one student (delete it from SpeedGrader after)
await CanvasFeedback.probe(438886)
await CanvasFeedback.probe(438886, 141663, 493156)  // explicit courseId, assignmentId

// Print submission roster
await CanvasFeedback.printRoster()
await CanvasFeedback.printRoster(141663, 493156)

// Post to one student
await CanvasFeedback.single(438886, 'Great work.', 85)
await CanvasFeedback.single(438886, 'See rubric.')   // comment only
await CanvasFeedback.single(438886, '', 72)          // grade only

// Bulk from JS array
await CanvasFeedback.bulkFromArray([
  { student_id: '438886', grade: '85', comment: 'Excellent.' },
  { student_id: '123456', comment: 'Check units.' },
])

// Bulk from CSV string
await CanvasFeedback.bulkFromCSV(`
  student_id,grade,comment
  438886,85,Excellent structural analysis.
  123456,,Check your load path diagrams.
`)

// CONFIG — read or override before a bulk run
CanvasFeedback.CONFIG.course_id    = 141663
CanvasFeedback.CONFIG.assignment_id = 493156
CanvasFeedback.CONFIG.delay_ms     = 1500   // ms between requests (keep ≥ 1000)
CanvasFeedback.CONFIG.dry_run      = true
CanvasFeedback.CONFIG.skip_duplicates = true
CanvasFeedback.CONFIG.resume       = false
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| **HTTP 422** | Stale CSRF token | Reload the Canvas page, then re-run the script |
| **HTTP 401** | Not logged in | Log into Canvas first |
| **Student not found** | Wrong student_id | Use `printRoster()` to find correct IDs |
| **No courses in picker** | No teacher enrolments | Confirm you are enrolled as a teacher in at least one active course |
| **SheetJS fails to load** | CDN blocked | Use a CSV file instead, or load SheetJS manually |

---

## Auth notes

Canvas at Auckland disables personal access tokens for most accounts.  
This script uses only:
- **Browser session cookie** (`credentials: 'include'`)
- **CSRF token** from `<meta name="csrf-token">` on the page

This is identical to what SpeedGrader does internally.

---

## Version history

| Version | Notes |
|---------|-------|
| **v4** | Floating UI panel, course/assignment picker, file picker (CSV+XLSX), progress bar, resume, duplicate guard, grade support verified |
| **v3** | PUT `/api/v1/…/submissions/:user_id` with JSON + CSRF header; bulk from CSV string; pagination |
| **v2** | Form-POST approach — broken on newer Canvas instances |
| **v1** | Initial proof of concept |
