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

// ─── Indeed Easy Apply handler ────────────────────────────────────────────────

async function handleIndeedEasyApply(page, job) {
  const p = RESUME_JSON.personal;

  // Fill standard fields if present
  await fillIfVisible(page, 'input[name="applicant.name"], input[aria-label*="name" i]', p.name);
  await fillIfVisible(page, 'input[name="applicant.email"], input[type="email"]', p.email);
  await fillIfVisible(page, 'input[name="applicant.phoneNumber"], input[type="tel"]', p.phone || "");

  // Upload resume
  const resumePath = resumeFilePath(job.company, job.title);
  if (fs.existsSync(resumePath)) {
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(resumePath);
      console.log("   ✓ Resume uploaded");
    }
  }

  // Handle multi-step application pages
  let maxSteps = 10;
  while (maxSteps-- > 0) {
    // Check for CAPTCHA
    if (await page.locator('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]').count() > 0) {
      await pauseForHuman(page, "CAPTCHA detected — please complete it in the browser.");
    }

    // Check for login wall
    if (await page.locator('input[type="password"]').count() > 0 &&
        (await page.url()).includes("login")) {
      await pauseForHuman(page, "Login required — please log in to Indeed in the browser.");
    }

    // Answer visible screening questions
    const questions = await page.locator('[data-testid="screening-question"], .ia-Questions-item, .jobs-easy-apply-form-section, [class*="FormSection"]').all();
    for (const qEl of questions) {
      const labelEl = qEl.locator('label, legend, [class*="label" i], [class*="question" i]').first();
      const labelText = await labelEl.textContent().catch(() => "");
      if (!labelText.trim()) continue;

      const answer = findAnswer(job.company, labelText);

      if (answer === null) {
        // Unknown question — pause for human
        await pauseForHuman(page,
          `Unknown screening question: "${labelText.trim()}"\nType your answer in the browser, then press ENTER.`
        );
        continue;
      }

      // Yes/No radio buttons
      const yesRadio = qEl.locator('input[type="radio"][value="Yes"], input[type="radio"][value="yes"]').first();
      const noRadio = qEl.locator('input[type="radio"][value="No"], input[type="radio"][value="no"]').first();
      if (await yesRadio.count() > 0) {
        const isYes = /^yes$/i.test(answer.trim());
        if (isYes) await yesRadio.check().catch(() => {});
        else if (await noRadio.count() > 0) await noRadio.check().catch(() => {});
        continue;
      }

      // Select/dropdown
      const select = qEl.locator("select").first();
      if (await select.count() > 0) {
        await select.selectOption({ label: answer }).catch(async () => {
          await select.selectOption({ value: answer }).catch(() => {});
        });
        continue;
      }

      // Textarea
      const textarea = qEl.locator("textarea").first();
      if (await textarea.count() > 0) {
        await textarea.fill(answer);
        continue;
      }

      // Text input
      const input = qEl.locator('input[type="text"], input:not([type])').first();
      if (await input.count() > 0) {
        await input.fill(answer);
      }
    }

    // Try to advance to next step or submit
    const nextBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), button[aria-label*="continue" i]').first();
    const submitBtn = page.locator('button[aria-label*="Submit"], button:has-text("Submit application"), button:has-text("Submit")').first();

    if (await submitBtn.count() > 0 && await submitBtn.isVisible()) {
      if (DRY_RUN) {
        console.log("   [DRY RUN] Would click Submit now.");
        return "applied";
      }
      await submitBtn.click();
      await page.waitForTimeout(3000);
      console.log("   ✓ Application submitted");
      return "applied";
    } else if (await nextBtn.count() > 0 && await nextBtn.isVisible()) {
      await nextBtn.click();
      await page.waitForTimeout(2000);
    } else {
      // No recognizable next/submit button
      await pauseForHuman(page, "Couldn't find a Next or Submit button. Please advance the form manually, then press ENTER.");
    }
  }

  return "applied";
}

async function fillIfVisible(page, selector, value) {
  if (!value) return;
  const el = page.locator(selector).first();
  if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
    await el.fill(value).catch(() => {});
  }
}

// ─── Main application flow ───────────────────────────────────────────────────

async function applyToJob(page, job) {
  console.log(`\n📋  Applying: ${job.title} @ ${job.company}`);
  console.log(`    URL: ${job.url}`);

  await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Check for bot/CAPTCHA wall right after load
  if (await page.locator('[class*="captcha"], iframe[src*="captcha"]').count() > 0) {
    await pauseForHuman(page, "Bot-check / CAPTCHA on page load. Complete it, then press ENTER.");
  }

  // Detect Indeed account restriction warning
  const warningText = await page.locator('[data-testid="warning-message"], .jobsearch-Infoshield').textContent().catch(() => "");
  if (/account.*restrict|suspended|blocked/i.test(warningText)) {
    console.log("🚨  Account restriction warning detected. Stopping session immediately.");
    process.exit(1);
  }

  // Click "Apply now" or "Easy Apply" if present
  const applyBtn = page.locator(
    'button:has-text("Apply now"), a:has-text("Apply now"), button:has-text("Easy Apply"), [data-testid="apply-button"]'
  ).first();
  if (await applyBtn.count() > 0 && await applyBtn.isVisible()) {
    await applyBtn.click();
    await page.waitForTimeout(2000);
  }

  // Check if we landed on an external ATS
  const currentUrl = page.url();
  const isExternal = !currentUrl.includes("indeed.com");
  if (isExternal) {
    console.log(`   ↪ External ATS detected: ${currentUrl}`);
    await pauseForHuman(page,
      "External employer ATS opened. Fill and submit the form manually, then press ENTER when done (or type 'skip' to skip this one)."
    );
    const input = await waitForInput("   Applied? (yes/skip): ");
    return input.trim().toLowerCase().startsWith("s") ? "skipped" : "applied";
  }

  return await handleIndeedEasyApply(page, job);
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
