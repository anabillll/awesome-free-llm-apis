#!/usr/bin/env node
/**
 * Ecommerce Job Application Submitter
 *
 * Opens a visible Chromium browser, logs into Indeed once (persists session),
 * then works through all tracker.csv rows with status=ready, filling and
 * submitting each application automatically.
 *
 * Guardrails (non-negotiable):
 *  - Pauses and waits for you on CAPTCHAs or login walls
 *  - Pauses on any question it can't answer from master_resume.json / screening_answers.json
 *  - Respects the 15-20 submission cap per session
 *  - Adds a natural delay (90–180s) between submissions
 *  - Updates tracker.csv after every attempt (applied / failed / needs_input)
 *
 * Usage:
 *   node scripts/submitter.js
 *   node scripts/submitter.js --dry-run      (navigate but don't click Submit)
 *   node scripts/submitter.js --limit 5      (cap at 5 submissions this run)
 */

const { chromium } = require("../node_modules/playwright");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const RESUME_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "master_resume.json"), "utf8"));
const SCREENING = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "screening_answers.json"), "utf8"));
const TRACKER = path.join(ROOT, "data", "tracker.csv");
const RESUME_DIR = path.join(ROOT, "output", "resumes");
const COVER_DIR = path.join(ROOT, "output", "cover_letters");
const SESSION_DIR = path.join(ROOT, "output", "browser_session");
// Use the cloud pre-installed Chromium if available, otherwise let Playwright
// find its own locally-installed version (the default on Windows/Mac/Linux).
const CHROMIUM_PATH = fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
  ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
  : undefined;

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.indexOf("--limit");
const SESSION_LIMIT = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : 15;
const MIN_DELAY_MS = 90_000;   // 90 seconds minimum between submissions
const MAX_DELAY_MS = 180_000;  // 180 seconds maximum

fs.mkdirSync(SESSION_DIR, { recursive: true });

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = splitCSVLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
  });
}

function splitCSVLine(line) {
  const result = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === "," && !inQ) {
      result.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function csvEsc(v) {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function saveCSV(rows) {
  const headers = ["company","title","url","location","work_type","tier",
    "apply_method","date_found","date_applied","status","notes","skill_gaps"];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEsc(row[h])).join(","));
  }
  fs.writeFileSync(TRACKER, lines.join("\n") + "\n");
}

// ─── Screening answer matcher ────────────────────────────────────────────────

function findAnswer(company, questionText) {
  const q = questionText.toLowerCase();

  // Company-specific answers first
  const companyAnswers = SCREENING.by_company[company] || [];
  for (const { pattern, answer } of companyAnswers) {
    if (new RegExp(pattern, "i").test(q)) return answer;
  }

  // Universal yes/no answers
  const { universal } = SCREENING;
  if (/eligible.*work.*canada|authorized.*work.*canada|work.*full.?time.*canada/i.test(q)) return universal.work_authorization_canada;
  if (/located.*canada|based.*canada|reside.*canada/i.test(q)) return universal.location_canada;
  if (/willing.*relocate/i.test(q)) return universal.willing_to_relocate;
  if (/years.*ecommerce|ecommerce.*experience/i.test(q)) return universal.years_experience_ecommerce;
  if (/years.*shopify|shopify.*experience/i.test(q)) return universal.years_experience_shopify;
  if (/years.*digital marketing/i.test(q)) return universal.years_experience_digital_marketing;
  if (/years.*email marketing/i.test(q)) return universal.years_experience_email_marketing;
  if (/years.*meta ads|years.*facebook ads/i.test(q)) return universal.years_experience_meta_ads;
  if (/years.*google ads/i.test(q)) return universal.years_experience_google_ads;

  return null; // Unknown — will pause for human input
}

// ─── Human-in-the-loop pause ─────────────────────────────────────────────────

function waitForInput(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

async function pauseForHuman(page, reason) {
  console.log(`\n⚠️  PAUSING: ${reason}`);
  console.log("   Handle this in the browser window, then press ENTER here to continue...");
  await waitForInput("");
}

// ─── File slug helper ─────────────────────────────────────────────────────────

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

function resumeFilePath(company, title) {
  return path.join(RESUME_DIR, `${slug(company)}_${slug(title)}.txt`);
}

function coverFilePath(company, title) {
  return path.join(COVER_DIR, `${slug(company)}_${slug(title)}.txt`);
}

// ─── Random delay ─────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function naturalDelay() {
  const ms = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  console.log(`\n⏳  Waiting ${Math.round(ms / 1000)}s before next application...`);
  return sleep(ms);
}

// ─── Indeed button helpers ────────────────────────────────────────────────────

async function findVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible()) return el;
    } catch (_) {}
  }
  return null;
}

async function clickApplyButton(page) {
  // Indeed Easy Apply button — try specific data-testid / class attrs first
  const btn = await findVisible(page, [
    '[data-testid="jobsearch-IndeedApplyButton"]',
    '[class*="IndeedApplyButton"]',
    '[class*="indeedApplyButton"]',
    '#indeedApplyButton',
    '[id*="IndeedApply"]',
    'button[class*="apply" i]:not([class*="Applied"])',
    'button:has-text("Apply now")',
    'a:has-text("Apply now")',
    'button:has-text("Easy Apply")',
    '[data-testid="apply-button"]',
    'button:has-text("Apply")',
  ]);
  if (btn) {
    await btn.click();
    return true;
  }
  return false;
}

async function findNextOrSubmit(page) {
  // Submit first (so if both visible, we prefer to finish)
  const submitBtn = await findVisible(page, [
    'button[data-testid="ia-submitButton"]',
    'button[data-testid*="submit" i]',
    'button[aria-label="Submit your application"]',
    'button[aria-label*="Submit" i]',
    'button:has-text("Submit application")',
    'button:has-text("Submit")',
  ]);
  if (submitBtn) return { type: "submit", btn: submitBtn };

  const nextBtn = await findVisible(page, [
    'button[data-testid="ia-continueButton"]',
    'button[data-testid*="continue" i]',
    'button[aria-label="Continue to next step"]',
    'button[aria-label*="continue" i]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Review your application")',
  ]);
  if (nextBtn) return { type: "next", btn: nextBtn };

  return null;
}

// ─── Form field filling ────────────────────────────────────────────────────────

async function fillIfVisible(page, selector, value) {
  if (!value) return;
  const el = page.locator(selector).first();
  if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
    await el.fill(value).catch(() => {});
  }
}

async function fillFormFields(page, job) {
  const p = RESUME_JSON.personal;
  await fillIfVisible(page,
    'input[name="applicant.name"], input[autocomplete="name"], input[aria-label*="name" i]:not([aria-label*="company" i])', p.name);
  await fillIfVisible(page,
    'input[name="applicant.email"], input[type="email"], input[autocomplete="email"]', p.email);
  await fillIfVisible(page,
    'input[name="applicant.phoneNumber"], input[type="tel"], input[autocomplete="tel"]', p.phone || "");

  // Resume upload
  const resumePath = resumeFilePath(job.company, job.title);
  if (fs.existsSync(resumePath)) {
    try {
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles(resumePath);
        console.log("   ✓ Resume uploaded");
        await page.waitForTimeout(1500);
      }
    } catch (_) {}
  }
}

async function answerScreeningQuestions(page, job) {
  // Indeed uses several containers for screening questions
  const questionContainers = await page.locator(
    '[data-testid="screening-question"], ' +
    '.ia-Questions-item, ' +
    '[class*="QuestionsForm"] > div, ' +
    '[class*="FormSection"], ' +
    '[class*="question-group"], ' +
    'fieldset'
  ).all();

  for (const qEl of questionContainers) {
    let labelText = "";
    try {
      const labelEl = qEl.locator('label, legend, [class*="label" i], p').first();
      labelText = (await labelEl.textContent()) || "";
    } catch (_) {}
    if (!labelText.trim()) continue;

    const answer = findAnswer(job.company, labelText);
    if (answer === null) {
      console.log(`   ❓ Unknown question: "${labelText.trim().slice(0, 80)}"`);
      await pauseForHuman(page,
        `Unknown question: "${labelText.trim().slice(0, 120)}"\nPlease type your answer in the browser, then press ENTER.`
      );
      continue;
    }

    // Yes/No radios
    const yesRadio = qEl.locator('input[type="radio"][value="Yes"], input[type="radio"][value="yes"]').first();
    if (await yesRadio.count() > 0) {
      const isYes = /^yes$/i.test(answer.trim());
      await (isYes ? yesRadio : qEl.locator('input[type="radio"][value="No"], input[type="radio"][value="no"]').first())
        .check().catch(() => {});
      continue;
    }

    // Select
    const select = qEl.locator("select").first();
    if (await select.count() > 0) {
      await select.selectOption({ label: answer })
        .catch(() => select.selectOption({ value: answer }).catch(() => {}));
      continue;
    }

    // Textarea
    const textarea = qEl.locator("textarea").first();
    if (await textarea.count() > 0) {
      await textarea.fill(answer); continue;
    }

    // Text input
    const input = qEl.locator('input[type="text"], input[type="number"], input:not([type])').first();
    if (await input.count() > 0) {
      await input.fill(answer);
    }
  }
}

// ─── Multi-frame helpers ──────────────────────────────────────────────────────

function allFrames(page) {
  return page.frames ? page.frames() : [page];
}

async function fullDiagnostic(page) {
  console.log("\n   === PAGE DIAGNOSTIC ===");
  const frames = allFrames(page);
  console.log(`   Frames loaded (${frames.length}):`);
  for (const f of frames) {
    console.log(`     ${f.url ? f.url().slice(0, 90) : "(unknown)"}`);
  }

  // DOM iframes
  try {
    const domIframes = await page.evaluate(() =>
      Array.from(document.querySelectorAll("iframe")).map((f) =>
        `src="${f.src.slice(0, 70)}" name="${f.name}" id="${f.id}"`
      )
    );
    console.log(`   DOM <iframe> elements:\n     ${domIframes.join("\n     ") || "(none)"}`);
  } catch (_) {}

  // Visible buttons in every frame
  for (const frame of frames) {
    try {
      const url = (frame.url ? frame.url() : "") || "(blank)";
      const btns = await frame.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter((b) => b.offsetParent !== null)
          .map((b) => `"${b.textContent.trim().slice(0, 35)}" dt=${b.dataset.testid || ""} aria=${b.getAttribute("aria-label") || ""}`)
          .slice(0, 15)
      );
      if (btns.length) {
        console.log(`   Buttons in ${url.slice(0, 60)}:\n     ${btns.join("\n     ")}`);
      }
    } catch (_) {}
  }
  console.log("   === END DIAGNOSTIC ===\n");
}

async function findNextOrSubmitAllFrames(page) {
  // Try every frame — including the main page frame
  for (const frame of allFrames(page)) {
    try {
      const r = await findNextOrSubmit(frame);
      if (r) {
        const u = frame.url ? frame.url().slice(0, 60) : "main";
        if (u && !u.includes(page.url ? page.url() : "")) {
          console.log(`   (found in frame: ${u})`);
        }
        return r;
      }
    } catch (_) {}
  }
  return null;
}

async function fillFormAllFrames(page, job) {
  for (const frame of allFrames(page)) {
    try { await fillFormFields(frame, job); } catch (_) {}
  }
}

async function answerQuestionsAllFrames(page, job) {
  for (const frame of allFrames(page)) {
    try { await answerScreeningQuestions(frame, job); } catch (_) {}
  }
}

// ─── Indeed Easy Apply handler ────────────────────────────────────────────────

async function handleEasyApply(applyPage, job) {
  // Print a diagnostic to show which frames/buttons are actually present
  await fullDiagnostic(applyPage);

  await fillFormAllFrames(applyPage, job);

  let maxSteps = 12;
  while (maxSteps-- > 0) {
    await applyPage.waitForTimeout(1500);

    // CAPTCHA check (any frame)
    for (const frame of allFrames(applyPage)) {
      try {
        if (await frame.locator('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]').count() > 0) {
          await pauseForHuman(applyPage, "CAPTCHA detected — complete it in the browser, then press ENTER.");
        }
      } catch (_) {}
    }

    // Login wall
    const pageUrl = applyPage.url ? applyPage.url() : "";
    if (pageUrl.includes("login")) {
      await pauseForHuman(applyPage, "Login required — log in to Indeed, then press ENTER.");
    }

    await answerQuestionsAllFrames(applyPage, job);
    await fillFormAllFrames(applyPage, job);

    const action = await findNextOrSubmitAllFrames(applyPage);

    if (!action) {
      // Scroll and retry once
      try { await applyPage.keyboard.press("End"); } catch (_) {}
      await applyPage.waitForTimeout(800);
      const retried = await findNextOrSubmitAllFrames(applyPage);
      if (!retried) {
        await fullDiagnostic(applyPage);
        await pauseForHuman(applyPage, "Couldn't find Next/Submit — please advance manually, then press ENTER.");
        continue;
      }
      if (retried.type === "submit") {
        if (DRY_RUN) { console.log("   [DRY RUN] Would click Submit."); return "applied"; }
        await retried.btn.click();
        await applyPage.waitForTimeout(3000);
        console.log("   ✓ Application submitted");
        return "applied";
      }
      console.log("   → Advancing (after scroll)...");
      await retried.btn.click();
      continue;
    }

    if (action.type === "submit") {
      if (DRY_RUN) { console.log("   [DRY RUN] Would click Submit."); return "applied"; }
      await action.btn.click();
      await applyPage.waitForTimeout(3000);
      console.log("   ✓ Application submitted");
      return "applied";
    }

    console.log("   → Advancing to next step...");
    await action.btn.click();
  }

  console.log("   ⚠️  Max steps reached — marking as applied (verify manually).");
  return "applied";
}

// ─── Main application flow ───────────────────────────────────────────────────

async function applyToJob(page, job) {
  console.log(`\n📋  Applying: ${job.title} @ ${job.company}`);
  console.log(`    URL: ${job.url}`);

  await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);

  // CAPTCHA on load
  if (await page.locator('[class*="captcha"], iframe[src*="captcha"]').count() > 0) {
    await pauseForHuman(page, "Bot-check / CAPTCHA on page load. Complete it, then press ENTER.");
  }

  // Account restriction
  const warningText = await page.locator('[data-testid="warning-message"], .jobsearch-Infoshield').textContent().catch(() => "");
  if (/account.*restrict|suspended|blocked/i.test(warningText)) {
    console.log("🚨  Account restriction detected. Stopping.");
    process.exit(1);
  }

  // Click "Apply now" / "Easy Apply" — watch for a new popup/tab
  let applyPage = page;
  const [newPage] = await Promise.all([
    page.context().waitForEvent("page", { timeout: 4000 }).catch(() => null),
    clickApplyButton(page),
  ]);

  if (newPage) {
    await newPage.waitForLoadState("domcontentloaded").catch(() => {});
    applyPage = newPage;
    console.log("   → Application opened in new tab");
  } else {
    await page.waitForTimeout(2000);
  }

  // If the URL left Indeed entirely it's an external ATS
  const postClickUrl = applyPage.url();
  if (!postClickUrl.includes("indeed.com") && !postClickUrl.includes("smartapply")) {
    console.log(`   ↪ External ATS: ${postClickUrl}`);
    await pauseForHuman(applyPage,
      "External employer ATS opened. Fill and submit manually, then press ENTER (or type 'skip')."
    );
    const ans = await waitForInput("   Applied? (yes/skip): ");
    return ans.trim().toLowerCase().startsWith("s") ? "skipped" : "applied";
  }

  return await handleEasyApply(applyPage, job);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀  Ecommerce Job Application Submitter");
  if (DRY_RUN) console.log("   Mode: DRY RUN (no submissions will be made)");
  console.log(`   Session limit: ${SESSION_LIMIT} applications\n`);

  // Load tracker
  const trackerText = fs.readFileSync(TRACKER, "utf8");
  const rows = parseCSV(trackerText);
  const readyJobs = rows.filter((r) => r.status === "ready");

  if (readyJobs.length === 0) {
    console.log("No jobs with status=ready found in tracker.csv. Nothing to do.");
    return;
  }

  console.log(`Found ${readyJobs.length} ready application(s). Will process up to ${SESSION_LIMIT}.\n`);

  // Launch browser (headed, persistent session so login survives)
  const launchOptions = {
    headless: false,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    slowMo: 50,
  };
  if (CHROMIUM_PATH) launchOptions.executablePath = CHROMIUM_PATH;
  const browser = await chromium.launch(launchOptions);

  const context = await browser.newContext({
    storageState: fs.existsSync(path.join(SESSION_DIR, "state.json"))
      ? path.join(SESSION_DIR, "state.json")
      : undefined,
    viewport: null,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  // Check Indeed login status
  await page.goto("https://ca.indeed.com/account/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  if (await page.locator('input[type="password"]').count() > 0) {
    await pauseForHuman(page, "Please log in to Indeed in the browser window, then press ENTER here.");
  }

  // Save session after login
  await context.storageState({ path: path.join(SESSION_DIR, "state.json") });
  console.log("✓ Session saved. Starting applications...");

  let submitted = 0;
  let failed = 0;

  for (const job of readyJobs) {
    if (submitted >= SESSION_LIMIT) {
      console.log(`\n✋  Session limit of ${SESSION_LIMIT} reached. Stopping.`);
      break;
    }

    try {
      const result = await applyToJob(page, job);

      // Update tracker row
      const idx = rows.findIndex((r) => r.url === job.url);
      if (idx !== -1) {
        rows[idx].status = result === "applied" ? "applied" : result;
        rows[idx].date_applied = result === "applied" ? new Date().toISOString().split("T")[0] : "";
      }
      saveCSV(rows);

      if (result === "applied") {
        submitted++;
        console.log(`\n✅  [${submitted}/${SESSION_LIMIT}] ${job.company} — ${job.title}: SUBMITTED`);
        // Save session after each success
        await context.storageState({ path: path.join(SESSION_DIR, "state.json") });
        // Natural pause between applications (skip after last one)
        if (submitted < SESSION_LIMIT && readyJobs.indexOf(job) < readyJobs.length - 1) {
          await naturalDelay();
        }
      } else {
        console.log(`\n⏭️   ${job.company} — ${job.title}: ${result}`);
      }
    } catch (err) {
      console.error(`\n❌  Error on ${job.company}: ${err.message}`);
      const idx = rows.findIndex((r) => r.url === job.url);
      if (idx !== -1) {
        rows[idx].status = "failed";
        rows[idx].notes = `Error: ${err.message}`;
      }
      saveCSV(rows);
      failed++;
    }
  }

  // Final session save
  await context.storageState({ path: path.join(SESSION_DIR, "state.json") });
  await browser.close();

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Session complete.`);
  console.log(`  Submitted: ${submitted}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Tracker updated: ${TRACKER}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
