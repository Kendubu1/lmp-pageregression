# LMP Page Regression

A visual regression testing tool that captures screenshots of web pages across multiple locales, compares them pixel-by-pixel against stored baselines, and reports on visual drift over time. Results and images are stored locally on the filesystem (JSON files + PNG images). A web dashboard provides schedule management, test results, and trend visualisation.

**This branch runs fully locally -- no Azure, no SQL Server, no cloud credentials required.**

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [How It Works](#how-it-works)
3. [Local Development Setup](#local-development-setup)
4. [Running the Application](#running-the-application)
5. [Types of Testing & What They Cover](#types-of-testing--what-they-cover)
6. [Challenges Encountered](#challenges-encountered)
7. [Known Code Issues](#known-code-issues)
8. [Refactoring Guide -- Isolating the Test Script](#refactoring-guide----isolating-the-test-script)
9. [Project Structure](#project-structure)
10. [API Reference](#api-reference)
11. [Database Schema](#database-schema)

---

## Architecture Overview

```
+------------------+       +---------------+       +--------------------+
|  Browser (UI)    | <---> |  Express API  | <---> |  Local filesystem  |
|  index.html      |       |  server.js    |       |  data/             |
|  app.js          |       |               |       |    schedules.json  |
|  Bootstrap 5     |       |  node-cron    |       |    results.json    |
|  Chart.js        |       |  (scheduler)  |       +--------------------+
+------------------+       +-------+-------+
                                   |               +--------------------+
                                   |  spawns       |  images/           |
                                   v               |    baseline_images/|
                           +---------------+       |    current_images/ |
                           | pixletest.js  | <---> |    diff_images/    |
                           | (Playwright + |       +--------------------+
                           |  pixelmatch)  |
                           +---------------+
```

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Server** | Express.js 4.x | REST API, static file serving, cron scheduling |
| **Test Engine** | Playwright (Chromium) + pixelmatch + sharp | Screenshot capture, pixel-level comparison, image resize |
| **Data Storage** | Local JSON files (`data/`) | Stores test results and schedule configuration |
| **Image Storage** | Local filesystem (`images/`) | Stores baseline, current, and diff PNG images |
| **Frontend** | Bootstrap 5, Chart.js, vanilla JS | Dashboard for managing schedules and viewing results |
| **Scheduler** | node-cron | Triggers test runs on configurable cron schedules |
| **CI/CD** | GitHub Actions | Build, test, and deploy to Azure App Service |

---

## How It Works

### Test Execution Flow

1. A test is triggered either by a cron schedule or a manual API call.
2. `server.js` spawns `pixletest.js` as a child process, passing the test configuration (base URL + locales) as a JSON command-line argument.
3. `pixletest.js` launches a headless Chromium browser via Playwright.
4. For each locale in the configuration:
   - The `{locale}` placeholder in the base URL is replaced with the actual locale code.
   - The page is loaded with `waitUntil: 'networkidle'`.
   - Fonts are waited on (`document.fonts.ready`).
   - Any carousels matching `button.carousel-control-autoplay` are paused.
   - The page is auto-scrolled top-to-bottom to trigger lazy-loaded content.
   - A full-page screenshot is captured at 1920x1080 viewport.
5. The screenshot is compared against the stored baseline:
   - **No baseline exists**: The screenshot becomes the baseline; result is `Null`.
   - **Baseline exists**: Images are resized to matching dimensions, then compared with `pixelmatch` (threshold: `0.1`). A diff percentage is computed. Differences above 15% are marked `Fail`; at or below 15% are `Pass`.
   - A diff image is generated highlighting changed pixels in red.
6. All images (baseline, current, diff) are saved to the local `images/` directory.
7. Results are appended to `data/results.json`.
8. If the baseline was last modified on a previous day, it is automatically overwritten with the current screenshot ("rolling baseline").

### Dashboard Features

- **Schedule management**: Create, edit, pause, resume, and delete test schedules with cron expressions.
- **Manual test trigger**: Run a test on-demand for any configured schedule.
- **Results table**: View every test run with date, URL, pass/fail/null status, diff percentage, and a button to view the three-panel image comparison (baseline, current, diff).
- **Trend charts**: Chart.js line graphs showing pass rate and average diff percentage over 7/30/90 days.

---

## Local Development Setup

### Prerequisites

- **Node.js** 20.x (matches CI/CD pipeline)
- **npm** (comes with Node.js)

That's it. No Azure, no SQL Server, no Docker, no cloud credentials.

### Step-by-Step

```bash
# 1. Clone the repository and switch to the local-testing branch
git clone <repo-url>
cd lmp-pageregression
git checkout claude/setup-local-testing-docs-Z3iG6

# 2. Install dependencies
npm install

# 3. Install Playwright browsers (Chromium)
npx playwright install --with-deps chromium

# 4. (Optional) Create your environment file to customise the port
cp .env.example .env

# 5. Start the server
npm start

# 6. Open http://localhost:3000 in your browser
```

The `data/` and `images/` directories are created automatically on first run. Schedules are persisted to `data/schedules.json` and test results to `data/results.json`. Screenshots are saved under `images/`.

---

## Running the Application

| Command | What it does |
|---------|-------------|
| `npm start` | Starts the Express server on the configured PORT (default 3000) |
| `npm test` | Currently a no-op (`exit 0`). No automated tests are implemented. |
| `node pixletest.js '<json_config>'` | Runs the visual test engine directly. Expects a JSON string argument. |

### Running pixletest.js Directly

```bash
node pixletest.js '{"tests":[{"baseUrl":"https://example.com/{locale}/page","locales":["en-us","fr-fr"]}]}'
```

Or create a `config.json` in the project root:
```json
{
  "tests": [
    {
      "baseUrl": "https://example.com/{locale}/page",
      "locales": ["en-us", "fr-fr", "de-de"]
    }
  ]
}
```
Then run without arguments:
```bash
node pixletest.js
```

---

## Types of Testing & What They Cover

### 1. Visual Regression Testing (Primary)

**What it is**: Pixel-level comparison of full-page screenshots captured at different points in time.

**How it works in this project**:
- Playwright captures a full-page screenshot of each URL+locale combination.
- `pixelmatch` compares every pixel of the current screenshot against the stored baseline.
- Differences are quantified as a percentage of total pixels.
- A threshold of **15%** determines pass/fail.
- A diff image is generated overlaying red highlights on changed regions.

**What it catches**:
- CSS regressions (broken layouts, missing styles, wrong colours)
- Content changes (unexpected text or image changes)
- Rendering differences across deployments
- Locale-specific layout problems (text overflow in longer translations)
- Missing assets (broken images, icon regressions)

**What it does NOT catch**:
- Functional regressions (broken forms, dead links, JS errors)
- Performance regressions
- Accessibility regressions
- API or backend logic bugs

### 2. Cross-Locale Consistency Testing

**What it is**: Running the same visual regression test across multiple locale variants of a URL.

**What it catches**:
- Locale-specific rendering problems
- Translation-related layout breaks (e.g., German text overflowing containers)
- Missing or untranslated content
- RTL layout issues (if tested with RTL locales)

### 3. Scheduled Monitoring (Continuous Visual Testing)

**What it is**: Cron-based automated runs that repeatedly test the same URLs on a schedule.

**What it catches**:
- Drift over time via trend data (pass rate, avg diff %)
- Unexpected deployments or content changes on live sites
- Intermittent rendering issues that only appear at certain times

### Testing NOT Implemented (Gaps)

| Type | Status | Impact |
|------|--------|--------|
| **Unit tests** | Not implemented | No verification of `compareImages()`, `autoScroll()`, or any utility function |
| **Integration tests** | Not implemented | No testing of API endpoints |
| **End-to-end (functional) tests** | Not implemented | Dashboard UI is untested |
| **CI pipeline tests** | No-op | `npm test` exits 0; `master_pwtesting.yml` references `npx playwright test` but no test files exist |
| **Performance testing** | Not implemented | No metrics on page load speed or server response time |
| **Accessibility testing** | Not implemented | Could be added with `@axe-core/playwright` |

---

## Challenges Encountered

### 1. Dynamic Content & Flaky Comparisons

Pages with carousels, animations, ads, or A/B tests produce different screenshots on each run, causing false positives. The project addresses carousels specifically by pausing them (looking for `button.carousel-control-autoplay`), but other dynamic content (ads, live timestamps, cookie banners) is not handled.

**Impact**: High false-fail rate on pages with uncontrolled dynamic elements.

### 2. Baseline Management & Drift

The "rolling baseline" logic automatically updates the baseline image if the current run happens on a new calendar day. This means:
- Genuine regressions introduced overnight get baked into the new baseline the next day.
- A page that gradually degrades will have each day's degradation accepted as the new baseline.
- There is no manual approval step for baseline updates.

**Impact**: Slow regressions go undetected; baseline integrity erodes over time.

### 3. Threshold Tuning

The 15% diff threshold is hardcoded. Different pages have different levels of acceptable variance (e.g., a page with a live stock ticker vs. a static "About Us" page). A single global threshold leads to either too many false positives or missed regressions depending on the page.

### 4. Image Dimension Mismatches

When the baseline and current screenshots have different dimensions (which happens when page content changes height), images are resized with white padding to the larger dimensions. This white padding itself introduces diff pixels, inflating the diff percentage even when the actual content differences are minor.

### 5. Azure Dependency for Local Development (Resolved)

The original project had a hard dependency on Azure Blob Storage and Azure SQL Database. **This branch removes all Azure dependencies** -- images are stored on the local filesystem and data is persisted to JSON files. No cloud credentials or network access are required.

### 6. Child Process Execution Model

`pixletest.js` is spawned as a subprocess via `exec()` with the test config passed as a stringified JSON command-line argument. This introduces:
- Shell escaping risks (URLs with special characters can break parsing)
- No timeout on the subprocess (a hanging browser will block indefinitely)
- Difficulty capturing structured results (only stdout/stderr are available)
- No concurrent test isolation (multiple browser instances can interfere)

### 7. In-Memory Schedule State

Cron schedules are loaded from the database at startup and held in a `schedules` object in memory. If the server process restarts (which Azure App Service does routinely), schedules are re-loaded. However, any in-flight test run is lost, and there is no mechanism to detect or recover from incomplete runs.

### 8. No Authentication

The dashboard and all API endpoints are completely open. Anyone with the URL can view test results, create/delete schedules, and trigger test runs. This is a significant concern for production deployments.

---

## Known Code Issues

### Critical

1. **No `.gitignore`** (fixed in this branch) -- Previously, `node_modules/`, `.env`, and `test_log.txt` could be committed accidentally.

2. ~~**No environment variable validation**~~ (resolved) -- Azure dependencies have been removed. The app now starts with no environment variables at all.

3. **`server.js` -- Shell injection via `exec()`** -- The test config JSON is interpolated directly into a shell command. If `baseUrl` contains a single quote, the command breaks. Should use `execFile()` or `spawn()` with argument arrays instead.

4. ~~**Crash on startup without Azure Storage**~~ (resolved) -- Azure SDK calls have been removed; the server starts cleanly.

5. **`pixletest.js` -- `saveTestResult()` was async but called without `await`** (resolved) -- The local version uses synchronous `fs.writeFileSync()`, so results are always persisted before the function returns.

### High

6. **`pixletest.js:240` -- Hardcoded 15% threshold** -- Not configurable per schedule or per URL. Different pages need different thresholds.

7. **`pixletest.js:191` -- Unexplained 6-second wait** -- `await page.waitForTimeout(6000)` occurs BEFORE navigation. This delays every locale test by 6 seconds for no documented reason (the wait should be after navigation, not before).

8. **`server.js:37-41` -- Wide-open CORS** -- `origin: '*'` allows any domain to call the API, including creating/deleting schedules.

9. **`pixletest.js:249-254` -- Baseline auto-update logic** -- Updates the baseline whenever the blob's `lastModified` date differs from the current date. This means every first run of the day overwrites the baseline regardless of whether the current screenshot is correct.

10. ~~**Database connection model**~~ (resolved) -- Azure SQL has been replaced with local JSON files. No connection pooling issues.

11. **`pixletest.js:134-140` -- Diff image red highlight logic** -- The `redHighlight` buffer is allocated with `Buffer.alloc()` (all zeros). Non-diff pixels remain at RGBA `(0, 0, 0, 0)` (transparent black). Only diff pixels get `(255, 0, 0, 128)`. This works for the composite overlay, but the check `diff.data[i] === 255 && diff.data[i+1] === 0 && diff.data[i+2] === 0` is fragile -- `pixelmatch` can output diff colours that are not exactly `(255, 0, 0)` depending on anti-aliasing settings.

12. **No `package-lock.json`** -- Without a lockfile, `npm install` can produce different dependency trees on different machines, leading to "works on my machine" issues.

### Medium

13. ~~**Server startup blocks on database**~~ (resolved) -- Schedules are now loaded from a local JSON file synchronously. The server always starts.

14. **`pixletest.js:10` -- Log file in working directory** -- `test_log.txt` is written to `./` which depends on the CWD at runtime. In Azure App Service this may not be the project directory.

15. **`app.js:157` -- XSS via image paths** -- Image paths from the database are interpolated directly into HTML (`onclick="showLargeImage('/images/${baseline}')"`). If an image path contained crafted content, it could inject script. Low risk since paths are internally generated, but still a code hygiene issue.

16. **`pixletest.js:294` -- Fallback to `config.json` that doesn't exist** -- If no command-line argument is provided, the code tries `require('./config.json')` which will crash if the file doesn't exist.

17. **Both workflows trigger on push to master** -- Two separate deployments (`lmp-pageregression` and `pwtesting`) deploy on every push, but `master_pwtesting.yml` runs `npx playwright test` with no test files, meaning it will either fail or skip.

18. ~~**Dual database connections**~~ (resolved) -- Both server and test engine now read/write the same local JSON files. No connection coordination needed.

---

## Refactoring Guide -- Isolating the Test Script

If you want to extract `pixletest.js` into a standalone, reusable test runner (separate from the dashboard/server), here is what would be needed:

### Current Coupling Points

In this branch, Azure dependencies have been removed from `pixletest.js`. The test engine now uses local filesystem functions directly. However, the storage functions are still inline rather than abstracted behind an interface, so the coupling is now to `fs` calls rather than Azure SDK calls.

### Refactoring Steps

#### Step 1: Extract a Storage Interface

Create an abstraction layer so the test engine doesn't directly depend on Azure:

```
storage/
  storage-interface.js    # defines upload(), download(), exists() contract
  azure-blob-storage.js   # Azure Blob implementation
  local-file-storage.js   # Local filesystem implementation (for dev/testing)
```

This lets you run tests locally storing screenshots in a `./screenshots/` directory, no Azure needed.

#### Step 2: Extract a Results Interface

```
results/
  results-interface.js    # defines saveResult(), getResults() contract
  azure-sql-results.js    # Azure SQL implementation
  local-json-results.js   # Write results to a local JSON file
  sqlite-results.js       # SQLite for lightweight local persistence
```

#### Step 3: Make the Test Engine a Pure Function

Refactor `pixletest.js` so that `runVisualTest()` accepts injected dependencies:

```js
async function runVisualTest(browser, config, { storage, results, logger }) {
  // Use storage.upload(), storage.download() instead of direct Azure calls
  // Use results.save() instead of direct SQL calls
  // Use logger.log() instead of console.log + logToFile
}
```

#### Step 4: Extract Configuration

Move hardcoded values into a configuration object:

```js
const defaults = {
  viewport: { width: 1920, height: 1080 },
  diffThreshold: 0.1,         // pixelmatch sensitivity
  passThreshold: 15,           // max diff % to pass
  navigationTimeout: 30000,
  waitAfterScroll: 2000,
  scrollDistance: 100,
  scrollInterval: 100,
  carouselSelector: 'button.carousel-control-autoplay',
};
```

#### Step 5: Decouple from Server

Currently `server.js` spawns `pixletest.js` via `exec()`. After refactoring:

```
project/
  packages/
    test-engine/           # Standalone npm package
      src/
        runner.js          # Core test logic (pure, no Azure deps)
        compare.js         # Image comparison (pixelmatch wrapper)
        scroll.js          # Auto-scroll helper
      index.js             # Public API
      package.json
    dashboard/             # Web UI + API
      server.js
      app.js
      index.html
      package.json
    storage-adapters/      # Pluggable storage backends
      azure-blob.js
      local-fs.js
    results-adapters/      # Pluggable results backends
      azure-sql.js
      sqlite.js
      json-file.js
```

The dashboard would import the test engine as a dependency rather than spawning it as a subprocess:

```js
const { runVisualTest } = require('test-engine');
const storage = require('storage-adapters/local-fs');
const results = require('results-adapters/sqlite');

// Direct function call instead of exec()
await runVisualTest(config, { storage, results });
```

#### Step 6: Add Proper CLI Support

Replace the raw `process.argv[2]` JSON parsing with a proper CLI (e.g., `commander` or `yargs`):

```bash
npx visual-test --config ./tests/homepage.json --storage local --results json --output ./reports/
```

### Minimum Viable Isolation

If you want the quickest path to running the test engine locally without Azure:

1. Add `dotenv` support.
2. Create a `local-storage.js` that reads/writes images to a local `./screenshots/` directory.
3. Create a `local-results.js` that appends results to a `./results.json` file.
4. Add a `--local` flag to `pixletest.js` that uses these local adapters instead of Azure.
5. This can be done without restructuring the entire project.

---

## Project Structure

```
lmp-pageregression/
├── .github/
│   └── workflows/
│       ├── master_lmp-pageregression.yml   # CI/CD: build + deploy to Azure App Service
│       └── master_pwtesting.yml            # CI/CD: build + Playwright tests + deploy (broken)
├── data/                                   # Created at runtime (gitignored)
│   ├── schedules.json                      # Persisted schedule configuration
│   └── results.json                        # Persisted test results
├── images/                                 # Created at runtime (gitignored)
│   ├── baseline_images/                    # Reference screenshots
│   ├── current_images/                     # Latest screenshots
│   └── diff_images/                        # Red-highlighted diff overlays
├── .env.example                            # Template for environment variables
├── .gitignore                              # Git ignore rules
├── app.js                                  # Frontend JavaScript (dashboard logic)
├── index.html                              # Frontend HTML (Bootstrap 5 dashboard)
├── package.json                            # Node.js dependencies and scripts
├── pixletest.js                            # Core test engine (Playwright + pixelmatch)
├── README.md                               # This file
└── server.js                               # Express API server + cron scheduler
```

---

## API Reference

| Method | Endpoint | Description |
|--------|---------|-------------|
| `GET` | `/` | Serves the dashboard (`index.html`) |
| `GET` | `/api/test-results` | Returns all test results, ordered by date descending |
| `GET` | `/api/schedules` | Returns all configured schedules with status |
| `GET` | `/api/visualization-data?days=N` | Returns daily pass rate and avg diff % for the last N days (7, 30, or 90) |
| `GET` | `/images/:path` | Serves a PNG image from the local `images/` directory |
| `POST` | `/api/set-schedule` | Creates a new test schedule. Body: `{ cronExpression, testConfig: { baseUrl, locales } }` |
| `POST` | `/api/run-test` | Triggers an immediate test run. Body: `{ baseUrl }` |
| `POST` | `/api/pause-schedule/:id` | Pauses a schedule |
| `POST` | `/api/resume-schedule/:id` | Resumes a paused schedule |
| `PUT` | `/api/update-schedule/:id` | Updates schedule config. Body: `{ cronExpression, testConfig: { baseUrl, locales } }` |
| `DELETE` | `/api/schedule/:id` | Deletes a schedule |

---

## Data Storage (Local JSON)

This branch stores all data as local JSON files. No database setup is required.

### `data/schedules.json`

```json
[
  {
    "id": 1,
    "base_url": "https://example.com/{locale}/page",
    "locales": "[\"en-us\",\"fr-fr\"]",
    "cron_expression": "0 */6 * * *",
    "run_count": 5,
    "created_at": "2025-01-15T10:00:00.000Z",
    "last_run": "2025-01-15T18:00:00.000Z",
    "is_paused": false
  }
]
```

### `data/results.json`

```json
[
  {
    "id": 1,
    "test_date": "2025-01-15T10:05:00.000Z",
    "url": "https://example.com/en-us/page",
    "result": "Pass",
    "status": "Acceptable differences: 2.31% different.",
    "baseline_image_path": "baseline_images/..._baseline.png",
    "current_image_path": "current_images/..._current.png",
    "image_path": "diff_images/..._diff.png",
    "diff_percentage": 2.31
  }
]
```

### `images/` Directory

```
images/
├── baseline_images/    # Reference screenshots (one per URL+date)
├── current_images/     # Screenshots from each test run
└── diff_images/        # Red-highlighted diff overlays
```
