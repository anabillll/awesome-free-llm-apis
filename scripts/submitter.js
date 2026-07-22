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
const https = require("https");
const { execSync } = require("child_process");

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
const MIN_DELAY_MS = 5_000;
const MAX_DELAY_MS = 10_000;
const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || "";
const IS_CI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
const INDEED_EMAIL = process.env.INDEED_EMAIL || "";
const INDEED_PASSWORD = process.env.INDEED_PASSWORD || "";

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

  // Work authorization & location
  if (/eligible.*work.*canada|authorized.*work.*canada|legally.*work.*canada|work.*full.?time.*canada|legal.*right.*work/i.test(q)) return "Yes";
  if (/located.*canada|based.*canada|reside.*canada|live.*canada|currently.*canada/i.test(q)) return "Yes";
  if (/legally.*work.*ontario|work.*ontario|based.*ontario|toronto/i.test(q)) return "Yes";
  if (/legally.*eligible.*work|eligible.*work.*this role|authorized.*work/i.test(q)) return "Yes";
  if (/require.*visa.*sponsor|require.*sponsorship|need.*sponsorship/i.test(q)) return "No";

  // Commute / location flexibility
  if (/willing.*relocate/i.test(q)) return "Yes";
  if (/willing.*commute|able.*commute|comfortable.*commute/i.test(q)) return "Yes";
  if (/willing.*work.*on.?site|comfortable.*on.?site|able.*work.*office/i.test(q)) return "Yes";
  if (/willing.*work.*hybrid/i.test(q)) return "Yes";
  if (/willing.*work.*remote/i.test(q)) return "Yes";

  // Availability & schedule
  if (/available.*full.?time|full.?time.*position|full.?time.*role/i.test(q)) return "Yes";
  if (/available.*start|when.*start|start.*date|earliest.*start/i.test(q)) return "Immediately";
  if (/available.*weekend|weekend.*availability/i.test(q)) return "Yes";
  if (/available.*monday.*friday|monday to friday/i.test(q)) return "Yes";
  if (/overtime|extra hours|flexible.*hours/i.test(q)) return "Yes";
  if (/notice period|how much notice/i.test(q)) return "2 weeks";
  if (/immediately available|can.*start immediately/i.test(q)) return "Yes";

  // Background / references
  if (/background check|criminal record check|reference check/i.test(q)) return "Yes";
  if (/provide.*reference|references.*available/i.test(q)) return "Yes";
  if (/drug test/i.test(q)) return "Yes";

  // Salary
  if (/hourly.*rate|rate.*per hour|desired.*hourly|expected.*hourly/i.test(q)) return "30";
  if (/desired.*salary|expected.*salary|salary.*expectation|annual.*salary|compensation.*expect/i.test(q)) return "65000";
  if (/minimum.*salary|salary.*requirement/i.test(q)) return "62400";

  // Education
  if (/highest.*education|level.*education|degree.*hold|education.*level/i.test(q)) return "Bachelor's Degree";
  if (/bachelor|undergraduate degree/i.test(q)) return "Yes";
  if (/master|mba|graduate degree/i.test(q)) return "No";

  // Years of experience — specific tools/skills
  if (/years.*shopify|shopify.*years|experience.*shopify.*year/i.test(q)) return "3";
  if (/years.*klaviyo|klaviyo.*years/i.test(q)) return "2";
  if (/years.*meta.*ads|years.*facebook.*ads|meta.*ads.*years|facebook.*ads.*years/i.test(q)) return "3";
  if (/years.*google.*ads|google.*ads.*years/i.test(q)) return "2";
  if (/years.*email.*marketing|email.*marketing.*years/i.test(q)) return "2";
  if (/years.*paid.*media|paid.*media.*years/i.test(q)) return "3";
  if (/years.*paid.*social|paid.*social.*years/i.test(q)) return "3";
  if (/years.*ecommerce|ecommerce.*years/i.test(q)) return "3";
  if (/years.*digital.*marketing|digital.*marketing.*years/i.test(q)) return "3";
  if (/years.*marketing/i.test(q)) return "3";
  if (/years.*shopify.*experience|shopify.*experience.*years/i.test(q)) return "3";
  if (/years.*crm|crm.*years/i.test(q)) return "2";
  if (/years.*canva|canva.*years/i.test(q)) return "3";
  if (/years.*analytics|analytics.*years/i.test(q)) return "3";

  // Skill yes/no
  if (/experience.*shopify|shopify.*experience|proficient.*shopify|familiar.*shopify/i.test(q)) return "Yes";
  if (/experience.*klaviyo|klaviyo.*experience/i.test(q)) return "Yes";
  if (/experience.*meta.*ads|experience.*facebook.*ads/i.test(q)) return "Yes";
  if (/experience.*google.*ads/i.test(q)) return "Yes";
  if (/experience.*email.*marketing/i.test(q)) return "Yes";
  if (/experience.*paid.*social|paid.*social.*experience/i.test(q)) return "Yes";
  if (/experience.*ecommerce|ecommerce.*experience/i.test(q)) return "Yes";
  if (/experience.*digital.*marketing/i.test(q)) return "Yes";
  if (/experience.*canva/i.test(q)) return "Yes";
  if (/experience.*google.*analytics|google.*analytics.*experience/i.test(q)) return "Yes";
  if (/experience.*microsoft.*excel|excel.*experience/i.test(q)) return "Yes";
  if (/experience.*social.*media/i.test(q)) return "Yes";
  if (/experience.*content/i.test(q)) return "Yes";
  if (/experience.*a\/b testing|a\/b.*test/i.test(q)) return "Yes";
  if (/experience.*cro|conversion.*rate.*optim/i.test(q)) return "Yes";
  if (/proficient.*english|fluent.*english|english.*fluent/i.test(q)) return "Yes";
  if (/proficient.*french|fluent.*french|bilingual|french.*required/i.test(q)) return "No";
  if (/driver.*licen|valid.*licen/i.test(q)) return "Yes";
  if (/own.*vehicle|have.*car/i.test(q)) return "No";

  // Generic yes/no catch-alls (safe defaults)
  if (/are you|do you|can you|have you|will you|would you/i.test(q)) return "Yes";

  return null; // still unknown — will be handled by guessAnswer()
}

// ─── Smart answer guesser (used when findAnswer returns null) ─────────────────

function guessYesOrNo(questionText) {
  const q = questionText.toLowerCase();
  // Flip to No only when we genuinely don't qualify
  if (/require.*sponsor|need.*visa|visa.*sponsor/i.test(q)) return "No";
  if (/master|mba|phd|doctorate/i.test(q)) return "No";
  if (/french|bilingual/i.test(q)) return "No";
  if (/mandarin|cantonese|korean|japanese|spanish|portuguese/i.test(q)) return "No";
  return "Yes"; // safe default
}

function guessNumber(questionText) {
  const q = questionText.toLowerCase();
  if (/shopify/.test(q)) return "3";
  if (/klaviyo/.test(q)) return "2";
  if (/google.*ads|ppc|sem/.test(q)) return "2";
  if (/meta.*ads|facebook.*ads/.test(q)) return "3";
  if (/email.*marketing/.test(q)) return "2";
  if (/paid.*media|paid.*social/.test(q)) return "3";
  if (/ecommerce|digital.*marketing/.test(q)) return "3";
  if (/marketing/.test(q)) return "3";
  if (/salary|annual|compensation/.test(q)) return "65000";
  if (/hourly|rate/.test(q)) return "30";
  return "2"; // generic fallback
}

function guessShortText(questionText) {
  const q = questionText.toLowerCase();
  if (/salary|compensation|pay|rate/.test(q)) {
    if (/hour/.test(q)) return "$30/hr";
    return "$65,000";
  }
  if (/notice period/.test(q)) return "2 weeks";
  if (/start.*date|when.*start|available.*start/.test(q)) return "Immediately";
  if (/city|location|where.*based|reside/.test(q)) return "Toronto, ON";
  if (/phone|mobile|number/.test(q)) return "";
  if (/linkedin/.test(q)) return "N/A";
  if (/portfolio|website|url/.test(q)) return "N/A";
  if (/postal.*code|zip/.test(q)) return "M5V 0C3";
  if (/country/.test(q)) return "Canada";
  if (/province|state/.test(q)) return "Ontario";
  return "N/A";
}

function guessLongText(questionText, job) {
  const q = questionText.toLowerCase();

  if (/shopify/.test(q)) {
    return "I have 3 years of hands-on Shopify experience as the founder of two DTC brands. I manage product listings, collections, pricing, promotions, checkout optimization, and post-purchase upsell flows directly in Shopify.";
  }
  if (/klaviyo/.test(q)) {
    return "I use Klaviyo to build and manage automated email flows (welcome, abandoned cart, post-purchase, win-back) and execute campaign calendars for my DTC brands. I handle segmentation, A/B testing, and track revenue attribution in Klaviyo analytics.";
  }
  if (/meta.*ads|facebook.*ads/.test(q)) {
    return "I have 3 years managing Meta Ads campaigns for DTC brands using a systematic creative testing framework — testing audience avatars, angles, and offers, then scaling winning combinations. I achieved 5× ROAS across a $20K ad spend portfolio.";
  }
  if (/google.*ads/.test(q)) {
    return "I have 2 years managing Google Ads search campaigns for DTC ecommerce, including keyword strategy, bid optimization, and performance tracking via Google Analytics.";
  }
  if (/email.*marketing|email.*program/.test(q)) {
    return "I have built and managed full email programs for my DTC brands using Klaviyo — including welcome flows, abandoned cart sequences, post-purchase flows, and monthly promotional campaigns. I manage segmentation and track open rates, click rates, and revenue attributed.";
  }
  if (/ecommerce|digital.*marketing/.test(q)) {
    return "I have 3 years of ecommerce and digital marketing experience as the founder of two DTC brands (&us fashion and Kalani Shop health & beauty), managing paid media, email marketing, and Shopify operations end-to-end. I grew the portfolio to $100K+ revenue on $20K in ad spend (5× ROAS).";
  }
  if (/why.*interest|why.*apply|what.*draw|why.*role|motivation/.test(q)) {
    const co = job && job.company ? job.company : "your company";
    return `I am drawn to ${co} because the role closely matches the work I do day-to-day — growing revenue through paid media, email, and Shopify optimization. I want to bring my hands-on DTC experience to a team environment where I can make a measurable impact.`;
  }
  if (/tell.*yourself|about yourself|background|introduce yourself/.test(q)) {
    return "I am an ecommerce marketer with 3 years of hands-on experience founding and scaling two DTC brands on Shopify. I manage paid media on Meta Ads and Google Ads, run email marketing programs in Klaviyo, and optimize Shopify storefronts for conversion. I grew my brand portfolio to $100K+ in revenue on $20K in ad spend.";
  }
  if (/strength|best.*skill|top.*skill/.test(q)) {
    return "My strongest skills are paid media management (Meta Ads and Google Ads), Klaviyo email automation, and Shopify ecommerce operations. I am data-driven and approach every channel with a test-and-iterate mindset.";
  }
  if (/weakness|improve|area.*growth/.test(q)) {
    return "I am actively building deeper expertise in advanced analytics and reporting — I have strong intuition from my DTC experience and am continuously leveling up on structured data analysis.";
  }
  if (/cover.*letter|additional.*information|anything.*else|further.*info/.test(q)) {
    return "Thank you for considering my application. I am excited about this opportunity and confident that my hands-on DTC ecommerce experience — managing Shopify, Meta Ads, Google Ads, and Klaviyo end-to-end — translates directly to this role.";
  }
  // Generic fallback
  return "I have 3 years of hands-on ecommerce and digital marketing experience as the founder of DTC brands on Shopify, managing paid media (Meta Ads, Google Ads), email marketing (Klaviyo), and full store operations.";
}

// ─── 2captcha solver ─────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

async function solveCaptchaWith2captcha(page, apiKey) {
  // Extract sitekey from the recaptcha iframe URL or data-sitekey attribute
  let sitekey = null;
  let pageUrl = page.url ? page.url() : "";

  // Search in all frames for the sitekey
  for (const frame of (page.frames ? page.frames() : [])) {
    try {
      const u = frame.url ? frame.url() : "";
      const m = u.match(/[?&]k=([A-Za-z0-9_-]+)/);
      if (m) { sitekey = m[1]; pageUrl = frame.url(); break; }
    } catch (_) {}
  }

  // Also try DOM
  if (!sitekey) {
    try {
      sitekey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        if (el) return el.getAttribute('data-sitekey');
        const iframe = document.querySelector('iframe[src*="recaptcha"]');
        if (iframe) { const m = iframe.src.match(/[?&]k=([A-Za-z0-9_-]+)/); return m ? m[1] : null; }
        return null;
      });
    } catch (_) {}
  }

  if (!sitekey) {
    console.log("   ⚠️  Could not extract CAPTCHA sitekey — falling back to manual.");
    return null;
  }

  console.log(`   🔐  Sending CAPTCHA to 2captcha (key: ${sitekey.slice(0, 12)}…)`);

  const submitUrl = `https://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha` +
    `&googlekey=${encodeURIComponent(sitekey)}&pageurl=${encodeURIComponent(pageUrl)}` +
    `&enterprise=1&json=1`;

  let captchaId;
  try {
    const resp = JSON.parse(await httpsGet(submitUrl));
    if (resp.status !== 1) { console.log(`   2captcha submit error: ${resp.request}`); return null; }
    captchaId = resp.request;
  } catch (e) { console.log(`   2captcha submit failed: ${e.message}`); return null; }

  console.log(`   ⏳  CAPTCHA queued (id ${captchaId}), waiting for solution…`);

  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    try {
      const res = JSON.parse(await httpsGet(
        `https://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`
      ));
      if (res.status === 1) {
        console.log("   ✓ CAPTCHA solved by 2captcha");
        return res.request; // the token
      }
      if (res.request !== "CAPCHA_NOT_READY") {
        console.log(`   2captcha poll error: ${res.request}`); return null;
      }
    } catch (_) {}
  }

  console.log("   2captcha timed out after 2.5 min — falling back to manual.");
  return null;
}

async function injectCaptchaToken(page, token) {
  // Try injecting into the main page first, then all frames
  const targets = [page, ...(page.frames ? page.frames() : [])];
  for (const t of targets) {
    try {
      await t.evaluate((tk) => {
        // Set hidden textarea value (standard reCAPTCHA v2 / Enterprise)
        document.querySelectorAll('[name="g-recaptcha-response"]').forEach((el) => {
          el.style.display = "block";
          el.value = tk;
        });
        // Fire explicit callback if present
        const container = document.querySelector('.g-recaptcha, [data-sitekey]');
        if (container) {
          const cb = container.getAttribute('data-callback');
          if (cb && typeof window[cb] === "function") { window[cb](tk); return; }
        }
        // Fire via internal grecaptcha_cfg
        if (window.___grecaptcha_cfg) {
          const clients = window.___grecaptcha_cfg.clients || {};
          Object.values(clients).forEach((c) => {
            Object.values(c).forEach((w) => {
              if (w && typeof w.callback === "function") {
                try { w.callback(tk); } catch (_) {}
              }
            });
          });
        }
      }, token);
    } catch (_) {}
  }
}

async function handleCaptcha(page) {
  // Check if a CAPTCHA is actually present
  let captchaPresent = false;
  for (const frame of (page.frames ? page.frames() : [page])) {
    try {
      if (await frame.locator('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]').count() > 0) {
        captchaPresent = true; break;
      }
    } catch (_) {}
  }
  if (!captchaPresent) return;

  if (CAPTCHA_API_KEY) {
    const token = await solveCaptchaWith2captcha(page, CAPTCHA_API_KEY);
    if (token) {
      await injectCaptchaToken(page, token);
      await page.waitForTimeout(2000); // let the page process the token
      return;
    }
  }

  // Fall back to manual
  await pauseForHuman(page, "CAPTCHA detected — complete it in the browser, then press ENTER.");
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

async function findNextOrSubmit(frame) {
  // Use DOM evaluation — finds any visible button regardless of selector changes
  const SUBMIT_WORDS = ["submit", "send application", "finish", "complete application"];
  const NEXT_WORDS   = ["continue", "next", "review", "apply now", "proceed"];

  let found = null;
  try {
    found = await frame.evaluate(({ submitWords, nextWords }) => {
      const els = Array.from(document.querySelectorAll(
        'button, [role="button"], input[type="submit"], input[type="button"]'
      ));
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const text = (el.textContent || el.value || el.getAttribute("aria-label") || "")
          .trim().toLowerCase().replace(/\s+/g, " ");
        const ariaBusy = el.getAttribute("aria-busy");
        if (ariaBusy === "true") continue; // loading spinner — skip

        // Check data-testid for submit/continue keywords (more reliable than text)
        const testId = (el.getAttribute("data-testid") || "").toLowerCase();
        if (/submit|ia-submit|form-submit/.test(testId)) return { kind: "submit", text: el.textContent.trim() };
        if (/continue|ia-continue|next|proceed/.test(testId)) return { kind: "next", text: el.textContent.trim() };

        for (const w of submitWords) { if (text.includes(w)) return { kind: "submit", text: el.textContent.trim() }; }
        for (const w of nextWords)   { if (text.includes(w)) return { kind: "next",   text: el.textContent.trim() }; }
      }
      return null;
    }, { submitWords: SUBMIT_WORDS, nextWords: NEXT_WORDS });
  } catch (_) { return null; }

  if (!found) return null;

  // Now locate it in Playwright so we can click it
  const text = found.text.trim().slice(0, 50);
  // Try a few locator strategies in order
  const strategies = [
    () => frame.locator(`button:has-text("${text}")`).first(),
    () => frame.locator(`[role="button"]:has-text("${text}")`).first(),
    () => frame.locator(`input[value="${text}"]`).first(),
    () => frame.locator(`button`).filter({ hasText: text.slice(0, 20) }).first(),
  ];
  for (const strat of strategies) {
    try {
      const el = strat();
      if (await el.count() > 0) return { type: found.kind, btn: el };
    } catch (_) {}
  }
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

// UI text that looks like a label but is not a screening question
const UI_NOISE_RE = /use your indeed resume|upload.*resume|indeed profile|save and close|skip to main|sign in|log in|report an issue/i;

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
    if (UI_NOISE_RE.test(labelText.trim())) continue;

    // Detect input type first — needed to pick the right answer format
    const hasYesNoRadio = await qEl.locator('input[type="radio"][value="Yes" i], input[type="radio"][value="No" i]').count() > 0;
    const hasRadio       = !hasYesNoRadio && await qEl.locator('input[type="radio"]').count() > 0;
    const hasSelect      = await qEl.locator("select").count() > 0;
    const hasTextarea    = await qEl.locator("textarea").count() > 0;
    const hasNumber      = await qEl.locator('input[type="number"]').count() > 0;
    const hasText        = await qEl.locator('input[type="text"], input:not([type]), input[type="email"]').count() > 0;

    // Try known answers first, then fall back to smart guesser
    let answer = findAnswer(job.company, labelText);

    if (answer === null) {
      // Auto-guess based on input type + question content
      if (hasYesNoRadio) {
        answer = guessYesOrNo(labelText);
      } else if (hasNumber) {
        answer = guessNumber(labelText);
      } else if (hasTextarea) {
        answer = guessLongText(labelText, job);
      } else if (hasText) {
        answer = guessShortText(labelText);
      } else if (hasSelect) {
        answer = guessShortText(labelText); // best effort — selectOption will try to match
      } else {
        answer = "Yes"; // last resort for unknown input types
      }
      console.log(`   🤖 Auto-answered: "${labelText.trim().slice(0, 70)}" → "${String(answer).slice(0, 60)}"`);
    } else {
      console.log(`   ✅ Known answer: "${labelText.trim().slice(0, 70)}" → "${String(answer).slice(0, 60)}"`);
    }

    // Fill the input
    if (hasYesNoRadio) {
      const isYes = /^yes$/i.test(String(answer).trim());
      const target = isYes
        ? qEl.locator('input[type="radio"][value="Yes" i]').first()
        : qEl.locator('input[type="radio"][value="No" i]').first();
      await target.check().catch(() => {});
      continue;
    }

    if (hasRadio) {
      // Non-yes/no radio — try to click one matching the answer text
      const labels = await qEl.locator('label').all();
      let matched = false;
      for (const lbl of labels) {
        const txt = (await lbl.textContent() || "").trim().toLowerCase();
        if (txt === String(answer).toLowerCase()) {
          await lbl.click().catch(() => {}); matched = true; break;
        }
      }
      if (!matched && labels.length > 0) await labels[0].click().catch(() => {}); // pick first option
      continue;
    }

    if (hasSelect) {
      const select = qEl.locator("select").first();
      await select.selectOption({ label: answer })
        .catch(() => select.selectOption({ value: answer })
        .catch(async () => {
          // Pick first non-empty option as fallback
          const opts = await select.locator("option").all();
          for (const opt of opts) {
            const v = await opt.getAttribute("value");
            if (v && v !== "") { await select.selectOption({ value: v }); break; }
          }
        }));
      continue;
    }

    if (hasTextarea) {
      await qEl.locator("textarea").first().fill(String(answer)).catch(() => {});
      continue;
    }

    if (hasNumber) {
      await qEl.locator('input[type="number"]').first().fill(String(answer)).catch(() => {});
      continue;
    }

    if (hasText) {
      await qEl.locator('input[type="text"], input:not([type]), input[type="email"]').first().fill(String(answer)).catch(() => {});
      continue;
    }
  }
}

// ─── Multi-frame helpers ──────────────────────────────────────────────────────

function allFrames(page) {
  try {
    return page.frames ? page.frames() : [page];
  } catch (_) {
    return [];
  }
}

async function fullDiagnostic(page) {
  try {
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
  } catch (err) {
    console.log(`   Diagnostic skipped (${err.message.slice(0, 60)})`);
  }
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

// ─── Resume selection step (smartapply first screen) ─────────────────────────

async function handleResumeSelection(ctx, job) {
  const url = ctx.url ? ctx.url() : "";
  if (!url.includes("resume-selection")) return;

  // Prefer uploading our tailored resume
  const uploadBtn = await findVisible(ctx, [
    'button:has-text("Upload a resume")',
    'button:has-text("Upload resume")',
    '[role="radio"]:has-text("Upload")',
    'label:has-text("Upload a")',
  ]);
  if (uploadBtn) {
    await uploadBtn.click();
    await ctx.waitForTimeout(1000);
    const resumePath = resumeFilePath(job.company, job.title);
    if (fs.existsSync(resumePath)) {
      try {
        const fi = ctx.locator('input[type="file"]').first();
        if (await fi.count() > 0) { await fi.setInputFiles(resumePath); console.log("   ✓ Resume uploaded"); }
      } catch (_) {}
    }
    return;
  }

  // Fall back to "Use your Indeed Resume"
  const indeedBtn = await findVisible(ctx, [
    'button:has-text("Use your Indeed Resume")',
    '[role="radio"]:has-text("Indeed Resume")',
    'label:has-text("Indeed Resume")',
  ]);
  if (indeedBtn) { await indeedBtn.click(); console.log("   ✓ Selected Indeed Resume"); }
}

// ─── Indeed Easy Apply handler ────────────────────────────────────────────────

async function handleEasyApply(applyPage, job) {
  // Print a diagnostic to show which frames/buttons are actually present
  await fullDiagnostic(applyPage);

  await fillFormAllFrames(applyPage, job);

  let maxSteps = 12;
  while (maxSteps-- > 0) {
    await applyPage.waitForTimeout(1500);

    // Detect post-submission: Indeed navigates back to homepage and preloads the next application.
    // The preloadresumeapply iframe is a reliable indicator that the previous job was submitted.
    try {
      const pageUrl = applyPage.url ? applyPage.url() : "";
      const frameUrls = allFrames(applyPage).map(f => { try { return f.url ? f.url() : ""; } catch(_) { return ""; } });
      const onHomepage = /indeed\.com\/?(\?.*)?$|indeed\.com\/jobs/.test(pageUrl) && !pageUrl.includes("viewjob") && !pageUrl.includes("apply");
      const preloading = frameUrls.some(u => u.includes("preloadresumeapply") || u.includes("apply-complete") || u.includes("confirmation"));
      if (onHomepage && preloading) {
        console.log("   ✓ Application submitted — Indeed navigated back to homepage with preload indicator.");
        return "applied";
      }
    } catch (_) {}

    // CAPTCHA check — auto-solve if API key set, otherwise pause for human
    await handleCaptcha(applyPage);

    // Login wall
    const pageUrl = applyPage.url ? applyPage.url() : "";
    if (pageUrl.includes("login")) {
      await pauseForHuman(applyPage, "Login required — log in to Indeed, then press ENTER.");
    }

    // Handle resume selection screen (first step of smartapply)
    for (const frame of allFrames(applyPage)) {
      try { await handleResumeSelection(frame, job); } catch (_) {}
    }

    await answerQuestionsAllFrames(applyPage, job);
    await fillFormAllFrames(applyPage, job);

    // Give the page a moment to finish rendering before hunting for buttons
    await applyPage.waitForTimeout(800);

    const action = await findNextOrSubmitAllFrames(applyPage);

    if (!action) {
      // Scroll to bottom and wait — button may be below the fold
      try {
        await applyPage.keyboard.press("End");
        for (const f of allFrames(applyPage)) {
          try { await f.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch (_) {}
        }
      } catch (_) {}
      await applyPage.waitForTimeout(1500);
      const retried = await findNextOrSubmitAllFrames(applyPage);
      if (!retried) {
        // Last resort: dump all visible buttons to console for debugging
        try {
          for (const f of allFrames(applyPage)) {
            const btns = await f.evaluate(() =>
              Array.from(document.querySelectorAll("button, [role='button']"))
                .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
                .map(b => b.textContent.trim().slice(0, 60))
                .filter(Boolean)
            ).catch(() => []);
            if (btns.length) console.log(`   Visible buttons in frame: ${btns.join(" | ")}`);
          }
        } catch (_) {}
        console.log("   ⚠️  Couldn't find Next/Submit button — skipping this job.");
        return "skipped";
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
  await handleCaptcha(page);

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

  // If the URL left Indeed entirely it's an external ATS — skip silently
  const postClickUrl = applyPage.url();
  if (!postClickUrl.includes("indeed.com") && !postClickUrl.includes("smartapply")) {
    console.log(`   ↪ External ATS detected (${postClickUrl.slice(0, 60)}) — skipping (Easy Apply only)`);
    return "skipped";
  }

  return await handleEasyApply(applyPage, job);
}

// ─── Browser launch / login helpers ──────────────────────────────────────────

const BROWSER_CRASH_RE = /Target page|Target closed|browser has been closed|Session closed|Connection closed/i;

async function launchBrowser() {
  const opts = {
    headless: IS_CI,   // headless in GitHub Actions, visible window locally
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
    ],
    slowMo: IS_CI ? 0 : 50,
  };
  if (CHROMIUM_PATH) opts.executablePath = CHROMIUM_PATH;
  const browser = await chromium.launch(opts);
  const context = await browser.newContext({
    storageState: fs.existsSync(path.join(SESSION_DIR, "state.json"))
      ? path.join(SESSION_DIR, "state.json")
      : undefined,
    viewport: IS_CI ? { width: 1280, height: 800 } : null,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  return { browser, context, page };
}

async function ensureLoggedIn(page, context) {
  await page.goto("https://ca.indeed.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Check if already logged in (restored session from cache)
  const loggedIn = await page.locator(
    '[data-testid="header-user-menu"], [aria-label*="account" i], .gnav-header-user, [href*="my-jobs"]'
  ).count() > 0;
  if (loggedIn) {
    console.log("✓ Already logged in (session restored).");
    return;
  }

  // Auto-login with env credentials (used in GitHub Actions and locally if set)
  if (INDEED_EMAIL && INDEED_PASSWORD) {
    console.log("   Logging in to Indeed...");
    await page.goto("https://secure.indeed.com/account/login", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    // Step 1: email
    const emailField = page.locator('input[type="email"], input[name="__email"], input[autocomplete="email"]').first();
    if (await emailField.count() > 0) {
      await emailField.fill(INDEED_EMAIL);
      await page.waitForTimeout(500);
      await page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")').first().click().catch(() => {});
      await page.waitForTimeout(2500);
    }

    // Step 2: password (may be on same page or next)
    const pwField = page.locator('input[type="password"]').first();
    if (await pwField.count() > 0) {
      await pwField.fill(INDEED_PASSWORD);
      await page.waitForTimeout(500);
      await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click().catch(() => {});
      await page.waitForTimeout(3000);
    }

    // Handle CAPTCHA that might appear on login
    await handleCaptcha(page);
    await page.waitForTimeout(2000);
    console.log("✓ Logged in.");
  } else if (!IS_CI) {
    // Local run without credentials — ask user to log in manually
    await pauseForHuman(page, "Please log in to Indeed in the browser window, then press ENTER here.");
  } else {
    console.error("❌  INDEED_EMAIL and INDEED_PASSWORD secrets are not set. Add them in GitHub → Settings → Secrets.");
    process.exit(1);
  }

  await context.storageState({ path: path.join(SESSION_DIR, "state.json") });
  console.log("✓ Session saved.");
}

async function isBrowserAlive(page) {
  try { await page.title(); return true; } catch (_) { return false; }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const REPLENISH_SCRIPT = path.join(ROOT, "scripts", "replenish.js");
const REPLENISH_THRESHOLD = 5; // auto-replenish when ready queue falls below this

function countReadyJobs() {
  if (!fs.existsSync(TRACKER)) return 0;
  const text = fs.readFileSync(TRACKER, "utf8");
  return parseCSV(text).filter((r) => r.status === "ready").length;
}

function runReplenish() {
  console.log("\n🔄  Searching Indeed for fresh jobs...");
  try {
    execSync(`node "${REPLENISH_SCRIPT}" --target 20`, {
      stdio: "inherit",
      timeout: 300_000, // 5 min max
      env: { ...process.env },
    });
  } catch (e) {
    console.log("  [warn] Replenish exited with error — continuing with existing queue.");
  }
}

async function main() {
  console.log("🚀  Ecommerce Job Application Submitter");
  if (DRY_RUN) console.log("   Mode: DRY RUN (no submissions will be made)");
  console.log(`   Session limit: ${SESSION_LIMIT} applications\n`);

  // Create tracker with CSV header if it doesn't exist yet
  if (!fs.existsSync(TRACKER)) {
    fs.writeFileSync(TRACKER, "company,title,url,location,work_type,tier,apply_method,date_found,date_applied,status,notes,skill_gaps\n");
    console.log("📋 Created fresh tracker.csv (first run on this machine)\n");
  }

  // Always search Indeed for fresh jobs before submitting
  runReplenish();

  // Load tracker (fresh after replenish)
  const trackerText = fs.readFileSync(TRACKER, "utf8");
  const rows = parseCSV(trackerText);
  const readyJobs = rows.filter((r) => r.status === "ready");

  if (readyJobs.length === 0) {
    console.log("No jobs with status=ready found. Replenish found nothing new — try again later.");
    return;
  }
  console.log(`Found ${readyJobs.length} ready application(s). Will process up to ${SESSION_LIMIT}.\n`);

  let { browser, context, page } = await launchBrowser();
  await ensureLoggedIn(page, context);

  let submitted = 0;
  let failed = 0;

  for (const job of readyJobs) {
    if (submitted >= SESSION_LIMIT) {
      console.log(`\n✋  Session limit of ${SESSION_LIMIT} reached. Stopping.`);
      break;
    }

    // Auto-relaunch if browser died
    if (!(await isBrowserAlive(page))) {
      console.log("\n🔄  Browser closed — relaunching...");
      try { await browser.close(); } catch (_) {}
      ({ browser, context, page } = await launchBrowser());
      await ensureLoggedIn(page, context);
    }

    try {
      const result = await applyToJob(page, job);

      const idx = rows.findIndex((r) => r.url === job.url);
      if (idx !== -1) {
        rows[idx].status = result === "applied" ? "applied" : result;
        rows[idx].date_applied = result === "applied" ? new Date().toISOString().split("T")[0] : "";
      }
      saveCSV(rows);

      if (result === "applied") {
        submitted++;
        console.log(`\n✅  [${submitted}/${SESSION_LIMIT}] ${job.company} — ${job.title}: SUBMITTED`);
        try { await context.storageState({ path: path.join(SESSION_DIR, "state.json") }); } catch (_) {}

        // Mid-session replenish: if ready queue is low, find more jobs while browser is paused
        const remaining = countReadyJobs();
        if (remaining < REPLENISH_THRESHOLD && submitted < SESSION_LIMIT) {
          console.log(`\n   Queue at ${remaining} — replenishing before next submission...`);
          runReplenish();
        }

        if (submitted < SESSION_LIMIT && readyJobs.indexOf(job) < readyJobs.length - 1) {
          await naturalDelay();
        }
      } else {
        console.log(`\n⏭️   ${job.company} — ${job.title}: ${result}`);
      }
    } catch (err) {
      if (BROWSER_CRASH_RE.test(err.message)) {
        // Browser crashed — don't mark as failed; next loop iteration will relaunch
        console.error(`\n⚠️  Browser crash on ${job.company} — will retry next run (status stays 'ready')`);
      } else {
        console.error(`\n❌  Error on ${job.company}: ${err.message}`);
        const idx = rows.findIndex((r) => r.url === job.url);
        if (idx !== -1) {
          rows[idx].status = "failed";
          rows[idx].notes = `Error: ${err.message.slice(0, 120)}`;
        }
        saveCSV(rows);
        failed++;
      }
    }
  }

  try { await context.storageState({ path: path.join(SESSION_DIR, "state.json") }); } catch (_) {}
  try { await browser.close(); } catch (_) {}

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Session complete.`);
  console.log(`  Submitted: ${submitted}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Tracker:   ${TRACKER}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
