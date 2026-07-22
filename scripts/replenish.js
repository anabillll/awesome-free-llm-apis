#!/usr/bin/env node
/**
 * Replenish — auto-fills tracker.csv with fresh jobs from Indeed.
 *
 * Scans Indeed job listings via Playwright, filters against criteria.json,
 * generates application materials for each qualifying job, and appends them
 * to tracker.csv so submitter.js always has a queue to work from.
 *
 * Usage:
 *   node scripts/replenish.js [--target N]
 *
 * Options:
 *   --target N   Ensure at least N ready-jobs are in the tracker (default: 20)
 *   --dry-run    Print jobs found without writing to tracker
 *
 * Runs headlessly by default. Set DEBUG=1 to see the browser.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const CRITERIA = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "criteria.json"), "utf8"));
const TRACKER = path.join(ROOT, "data", "tracker.csv");
const GENERATE = path.join(ROOT, "scripts", "generate_application.js");
const TMP = path.join(ROOT, "output", "tmp");
const BROWSER_SESSION = path.join(ROOT, "output", "browser_session");

fs.mkdirSync(TMP, { recursive: true });

const args = process.argv.slice(2);
const TARGET = parseInt(args[args.indexOf("--target") + 1] || "20", 10);
const DRY_RUN = args.includes("--dry-run");
const HEADLESS = !process.env.DEBUG;

// Search queries to cycle through
const SEARCH_QUERIES = [
  "ecommerce manager",
  "shopify manager",
  "email marketing manager",
  "digital marketing manager",
  "paid media specialist",
  "performance marketing manager",
  "klaviyo specialist",
  "facebook ads manager",
  "google ads specialist",
  "ecommerce specialist",
  "media buyer",
  "growth marketing manager",
];

function today() {
  return new Date().toISOString().split("T")[0];
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function readTracker() {
  if (!fs.existsSync(TRACKER)) return [];
  const lines = fs.readFileSync(TRACKER, "utf8").trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] || ""; });
    return row;
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      result.push(current); current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function appendTracker(row) {
  const fields = [
    "company", "title", "url", "location", "work_type", "tier",
    "apply_method", "date_found", "date_applied", "status", "notes", "skill_gaps",
  ];
  const line = fields.map((f) => csvEscape(row[f] ?? "")).join(",");
  fs.appendFileSync(TRACKER, line + "\n");
}

function countReady() {
  return readTracker().filter((r) => r.status === "ready").length;
}

function trackerUrls() {
  return new Set(readTracker().map((r) => r.url));
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

function autoExcludeReason(text, title) {
  const t = (text + " " + title).toLowerCase();
  for (const rule of CRITERIA.auto_exclude_if) {
    switch (rule.condition) {
      case "requires_french":
        if (/bilingu|french|fran[çc]ais/.test(t)) return rule.description; break;
      case "requires_senior_5plus_years":
        if (/5\+?\s*years|five\s*\+?\s*years/.test(t) &&
            /senior|lead|head|director|principal/.test(t)) return rule.description; break;
      case "requires_relocation_outside_canada":
        if (/must relocate|relocation required/.test(t) &&
            !/canada|toronto|remote/.test(t)) return rule.description; break;
      case "requires_advanced_bi_tools":
        if (/(advanced|expert|proficient)\s+(power bi|tableau|looker)/.test(t)) return rule.description; break;
      case "requires_masters_degree":
        if (/master'?s|mba|m\.b\.a|graduate degree required/.test(t)) return rule.description; break;
      case "requires_coding_engineering":
        if (/\b(python|sql|javascript|typescript|react|node\.js|software engineer|backend|frontend)\b/.test(t) &&
            /required|must have|proficient/.test(t)) return rule.description; break;
      case "requires_us_work_authorization_only":
        if (/us work authorization|must be authorized to work in the (us|united states)(?! and canada)/.test(t)) return rule.description; break;
    }
  }
  return null;
}

function extractEmphasizeKeywords(jdText) {
  const patterns = [
    "shopify", "klaviyo", "google analytics", "google ads", "facebook ads",
    "meta ads", "instagram ads", "tiktok ads", "email marketing",
    "seo", "sem", "ppc", "cro", "conversion rate optimization",
    "a/b testing", "multivariate testing", "media buying", "paid social",
    "paid search", "e-commerce", "ecommerce", "digital marketing",
    "marketing automation", "account management", "data analysis",
    "microsoft excel", "google sheets", "customer acquisition",
    "retention marketing", "ltv", "roas", "roi", "cpa", "cpm", "ctr",
    "product listing", "catalog management", "inventory management",
    "campaign management", "audience targeting", "lookalike audiences",
    "customer segmentation", "performance marketing", "growth marketing",
    "brand management", "content marketing", "social media marketing",
    "influencer marketing", "affiliate marketing",
  ];
  const text = jdText.toLowerCase();
  return patterns.filter((kw) => text.includes(kw));
}

function generateApplication(job) {
  const tmpFile = path.join(TMP, `replenish_${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(job, null, 2));
  try {
    const result = execSync(`node "${GENERATE}" "${tmpFile}"`, { encoding: "utf8" });
    fs.unlinkSync(tmpFile);
    return JSON.parse(result.trim());
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    throw e;
  }
}

function classifyWorkType(location, snippet) {
  const t = (location + " " + snippet).toLowerCase();
  if (/\bremote\b/.test(t)) return "remote";
  if (/hybrid/.test(t)) return "hybrid";
  return "on-site";
}

function classifyTier(location, workType) {
  if (workType === "remote") return 1;
  if (workType === "hybrid") return 3;
  // On-site: check if commutable city
  const commutable = CRITERIA.location_priority[3].commutable_cities.map((c) => c.toLowerCase());
  const loc = location.toLowerCase();
  if (commutable.some((c) => loc.includes(c))) return 4;
  return 99; // outside commutable
}

function isOutsideCommutableArea(location, workType) {
  if (workType === "remote") return false;
  const commutable = CRITERIA.location_priority[3].commutable_cities.map((c) => c.toLowerCase());
  const loc = location.toLowerCase();
  return !commutable.some((c) => loc.includes(c));
}

async function searchIndeedPage(page, query, location, seenUrls) {
  const jobs = [];
  const searchLoc = location || "remote";
  const url = `https://ca.indeed.com/jobs?q=${encodeURIComponent(query)}&l=${encodeURIComponent(searchLoc)}&remotejob=032b3046-06a3-4876-8dfd-474eb5e7ed11`;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2000);

    // Extract job cards
    const cards = await page.$$eval(
      '[data-testid="slider_item"], .job_seen_beacon, [class*="jobCard"], [class*="result"]',
      (els) => els.map((el) => {
        const titleEl = el.querySelector('[class*="jobTitle"] a, h2 a, [data-testid="jobTitle"] a');
        const compEl = el.querySelector('[class*="companyName"], [data-testid="company-name"]');
        const locEl = el.querySelector('[class*="companyLocation"], [data-testid="text-location"]');
        const snippetEl = el.querySelector('[class*="summary"], [class*="snippet"]');
        if (!titleEl) return null;
        return {
          title: titleEl.innerText.trim(),
          company: compEl ? compEl.innerText.trim() : "",
          location: locEl ? locEl.innerText.trim() : "",
          snippet: snippetEl ? snippetEl.innerText.trim() : "",
          href: titleEl.href || "",
        };
      }).filter(Boolean)
    ).catch(() => []);

    for (const card of cards) {
      if (!card.href || seenUrls.has(card.href)) continue;
      if (!card.title || !card.company) continue;
      jobs.push(card);
    }
  } catch (e) {
    console.log(`  [warn] search failed for "${query}" @ ${searchLoc}: ${e.message.split("\n")[0]}`);
  }
  return jobs;
}

async function getJobDescription(page, href) {
  try {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(1500);
    const desc = await page.$eval(
      '#jobDescriptionText, [class*="jobDescription"], [class*="description-content"]',
      (el) => el.innerText.trim()
    ).catch(() => "");
    const applyUrl = page.url();
    return { description: desc, url: applyUrl };
  } catch (e) {
    return { description: "", url: href };
  }
}

async function main() {
  const readyCount = countReady();
  console.log(`\n🔍 Replenish — ${readyCount} ready jobs in tracker, target: ${TARGET}`);

  if (readyCount >= TARGET && !DRY_RUN) {
    console.log(`✅ Already have ${readyCount} ready jobs — no replenishment needed.\n`);
    return;
  }

  const needed = TARGET - readyCount;
  console.log(`📋 Need to find ${needed} more qualifying jobs...\n`);

  const existingUrls = trackerUrls();
  const newJobs = [];
  let added = 0;

  let browser, context, page;
  try {
    browser = await chromium.launch({
      headless: HEADLESS,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    context = await browser.newContext({
      storageState: fs.existsSync(path.join(BROWSER_SESSION, "state.json"))
        ? path.join(BROWSER_SESSION, "state.json")
        : undefined,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    });
    page = await context.newPage();

    // Cycle through search queries until we have enough
    const searchTargets = [
      ...SEARCH_QUERIES.map((q) => ({ q, loc: "" })),           // remote
      ...SEARCH_QUERIES.slice(0, 6).map((q) => ({ q, loc: "Toronto, ON" })), // on-site/hybrid
    ];

    for (const { q, loc } of searchTargets) {
      if (added >= needed) break;

      console.log(`🔎 Searching: "${q}" ${loc ? `@ ${loc}` : "(remote)"}`);
      const cards = await searchIndeedPage(page, q, loc, existingUrls);
      console.log(`   Found ${cards.length} new listings`);

      for (const card of cards) {
        if (added >= needed) break;
        if (existingUrls.has(card.href)) continue;

        // Quick title relevance check
        const titleLower = card.title.toLowerCase();
        const relevant = CRITERIA.target_titles.some((t) =>
          titleLower.includes(t.toLowerCase().split(" ")[0]) ||
          t.toLowerCase().includes(titleLower.split(" ")[0])
        );
        if (!relevant) continue;

        const workType = classifyWorkType(card.location, card.snippet);
        const tier = classifyTier(card.location, workType);

        // Skip non-commutable on-site jobs
        if (tier === 99) {
          console.log(`   ⛔ Skip (location): ${card.title} @ ${card.company} (${card.location})`);
          existingUrls.add(card.href);
          continue;
        }

        // Get full job description
        const { description, url } = await getJobDescription(page, card.href);
        existingUrls.add(url);
        existingUrls.add(card.href);

        // Auto-exclude check
        const excludeReason = autoExcludeReason(description + " " + card.snippet, card.title);
        if (excludeReason) {
          console.log(`   ⛔ Auto-excluded: ${card.title} @ ${card.company} — ${excludeReason}`);
          if (!DRY_RUN) {
            appendTracker({
              company: card.company, title: card.title, url,
              location: card.location, work_type: workType, tier,
              apply_method: "indeed", date_found: today(),
              date_applied: "", status: "excluded",
              notes: `AUTO-EXCLUDED: ${excludeReason}`, skill_gaps: "",
            });
          }
          continue;
        }

        const emphasize = extractEmphasizeKeywords(description + " " + card.snippet);
        const job = {
          company: card.company,
          title: card.title,
          url,
          location: card.location,
          work_type: workType,
          tier,
          description: description || card.snippet,
          emphasize,
        };

        if (DRY_RUN) {
          console.log(`   ✅ [DRY-RUN] Would add: ${card.title} @ ${card.company} (${card.location})`);
          newJobs.push(job);
          added++;
          continue;
        }

        // Generate tailored application
        try {
          const { resumeFile, coverFile, skill_gaps } = generateApplication(job);
          const base = path.basename(resumeFile).replace(".txt", "");
          const notes = `Resume: ${path.basename(resumeFile)} | Cover: ${path.basename(coverFile)}`;
          appendTracker({
            company: job.company, title: job.title, url: job.url,
            location: job.location, work_type: workType, tier,
            apply_method: "indeed", date_found: today(),
            date_applied: "", status: "ready",
            notes,
            skill_gaps: skill_gaps.join("; "),
          });
          console.log(`   ✅ Added: ${job.title} @ ${job.company} → ${path.basename(resumeFile)}`);
          added++;
        } catch (e) {
          console.log(`   ⚠️  Failed to generate for ${job.title} @ ${job.company}: ${e.message.split("\n")[0]}`);
        }

        // Polite delay between detail page fetches
        await page.waitForTimeout(1500 + Math.random() * 1000);
      }

      // Delay between search pages
      await page.waitForTimeout(2000 + Math.random() * 2000);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  console.log(`\n✅ Replenish complete — added ${added} new jobs to tracker.`);
  console.log(`   Ready jobs now: ${countReady()}\n`);
}

main().catch((e) => {
  console.error("Fatal error in replenish:", e.message);
  process.exit(1);
});
