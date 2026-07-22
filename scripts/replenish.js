#!/usr/bin/env node
/**
 * Replenish — finds fresh jobs from Indeed and adds them to tracker.csv.
 *
 * Uses Indeed's RSS feeds (no browser needed for search), then visits each
 * job page via Playwright to grab the full description.
 *
 * Usage:
 *   node scripts/replenish.js             (ensure 20 ready jobs)
 *   node scripts/replenish.js --target 30 (ensure 30 ready jobs)
 *   node scripts/replenish.js --dry-run   (print without writing)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
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
const targetArg = args.indexOf("--target");
const TARGET = targetArg !== -1 ? parseInt(args[targetArg + 1], 10) : 20;
const DRY_RUN = args.includes("--dry-run");

// Search queries → Indeed RSS
const SEARCH_QUERIES = [
  { q: "ecommerce manager", l: "" },
  { q: "shopify manager", l: "" },
  { q: "email marketing manager klaviyo", l: "" },
  { q: "digital marketing manager", l: "" },
  { q: "paid media specialist", l: "" },
  { q: "performance marketing manager", l: "" },
  { q: "klaviyo email specialist", l: "" },
  { q: "facebook ads manager ecommerce", l: "" },
  { q: "google ads specialist", l: "" },
  { q: "ecommerce coordinator shopify", l: "" },
  { q: "media buyer DTC", l: "" },
  { q: "growth marketing manager", l: "" },
  { q: "email marketing manager", l: "Toronto, ON" },
  { q: "ecommerce manager", l: "Toronto, ON" },
  { q: "digital marketing manager", l: "Toronto, ON" },
  { q: "paid media manager", l: "Toronto, ON" },
];

// ─── CSV helpers ──────────────────────────────────────────────────────────────

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
    } else { cur += c; }
  }
  result.push(cur);
  return result;
}

function csvEsc(v) {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function readTracker() {
  if (!fs.existsSync(TRACKER)) return [];
  const lines = fs.readFileSync(TRACKER, "utf8").trim().split("\n");
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] || ""; });
    return row;
  });
}

function appendTracker(row) {
  const fields = [
    "company", "title", "url", "location", "work_type", "tier",
    "apply_method", "date_found", "date_applied", "status", "notes", "skill_gaps",
  ];
  const line = fields.map((f) => csvEsc(row[f] ?? "")).join(",");
  fs.appendFileSync(TRACKER, line + "\n");
}

function countReady() {
  return readTracker().filter((r) => r.status === "ready").length;
}

function trackerKeys() {
  // Deduplicate by URL and also by "company + title" to avoid near-duplicates
  const rows = readTracker();
  const urls = new Set(rows.map((r) => r.url));
  const pairs = new Set(rows.map((r) => `${r.company.toLowerCase()}|${r.title.toLowerCase()}`));
  return { urls, pairs };
}

function today() {
  return new Date().toISOString().split("T")[0];
}

// ─── Indeed RSS ───────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function parseRSS(xml) {
  const items = [];
  const matches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  for (const m of matches) {
    const block = m[1];
    const extract = (tag) => {
      const cdataM = block.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`));
      if (cdataM) return cdataM[1].trim();
      const plain = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return plain ? plain[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() : "";
    };
    const rawTitle = extract("title");   // "Job Title - Company (Location)"
    const link = extract("link") || extract("guid");
    const snippet = extract("description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    if (!link || !rawTitle) continue;

    // Parse "Job Title - Company (Location)"
    const dashIdx = rawTitle.lastIndexOf(" - ");
    if (dashIdx === -1) continue;
    const jobTitle = rawTitle.slice(0, dashIdx).trim();
    const rest = rawTitle.slice(dashIdx + 3).trim();
    const parenIdx = rest.lastIndexOf("(");
    const company = parenIdx > 0 ? rest.slice(0, parenIdx).trim() : rest;
    const location = parenIdx > 0 ? rest.slice(parenIdx + 1).replace(")", "").trim() : "";

    items.push({ title: jobTitle, company, location, snippet, link });
  }
  return items;
}

async function fetchIndeedRSS(query, location) {
  const params = new URLSearchParams({ q: query, sort: "date" });
  if (location) params.set("l", location);
  // Remote filter key for Indeed Canada
  if (!location) params.set("remotejob", "032b3046-06a3-4876-8dfd-474eb5e7ed11");
  const url = `https://ca.indeed.com/rss?${params.toString()}`;
  try {
    const xml = await httpsGet(url);
    return parseRSS(xml);
  } catch (e) {
    console.log(`  [warn] RSS fetch failed for "${query}": ${e.message}`);
    return [];
  }
}

// ─── Filtering & classification ───────────────────────────────────────────────

function autoExcludeReason(text, title) {
  const t = (text + " " + title).toLowerCase();
  for (const rule of CRITERIA.auto_exclude_if) {
    switch (rule.condition) {
      case "requires_french":
        if (/bilingu|french|fran[çc]ais/.test(t)) return rule.description; break;
      case "requires_senior_5plus_years":
        if (/[5-9]\+?\s*years|five\s*\+?\s*years|ten\s*years/.test(t) &&
            /senior|lead|head|director|principal|vp\b/.test(t)) return rule.description; break;
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

function classifyWorkType(location, snippet) {
  const t = (location + " " + snippet).toLowerCase();
  if (/\bremote\b/.test(t)) return "remote";
  if (/hybrid/.test(t)) return "hybrid";
  return "on-site";
}

function classifyTier(location, workType) {
  if (workType === "remote") return 1;
  if (workType === "hybrid") return 3;
  const commutable = CRITERIA.location_priority[3].commutable_cities.map((c) => c.toLowerCase());
  const loc = location.toLowerCase();
  if (commutable.some((c) => loc.includes(c))) return 4;
  return 99;
}

function isTitleRelevant(title) {
  const t = title.toLowerCase();
  // Must contain at least one relevant keyword
  const relevant = [
    "ecommerce", "e-commerce", "shopify", "email marketing", "digital marketing",
    "paid media", "paid social", "media buyer", "performance marketing",
    "google ads", "facebook ads", "meta ads", "klaviyo", "growth marketing",
    "marketing manager", "marketing specialist", "marketing coordinator",
    "crm", "retention", "sem", "seo", "ppc", "dtc",
  ];
  return relevant.some((kw) => t.includes(kw));
}

function extractEmphasizeKeywords(text) {
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
  const lower = text.toLowerCase();
  return patterns.filter((kw) => lower.includes(kw));
}

// ─── Application generation ───────────────────────────────────────────────────

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

// ─── Playwright: fetch full job description ───────────────────────────────────

async function fetchJobDescription(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(1200);
    const desc = await page.$eval(
      '#jobDescriptionText, [class*="jobDescription"], [class*="description"]',
      (el) => el.innerText.trim()
    ).catch(() => "");
    // Capture final URL (after redirects)
    const finalUrl = page.url();
    return { description: desc, finalUrl };
  } catch (_) {
    return { description: "", finalUrl: url };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const readyNow = countReady();
  console.log(`\n🔍 Replenish — ${readyNow} ready jobs in tracker, target: ${TARGET}`);

  if (readyNow >= TARGET && !DRY_RUN) {
    console.log(`✅ Already at target (${readyNow} ready). Nothing to do.\n`);
    return;
  }

  const needed = TARGET - readyNow;
  console.log(`📋 Looking for ${needed} new jobs...\n`);

  // Collect RSS results across all queries
  const allItems = [];
  const seenLinks = new Set();
  for (const { q, l } of SEARCH_QUERIES) {
    process.stdout.write(`  RSS: "${q}"${l ? ` @ ${l}` : " (remote)"}... `);
    const items = await fetchIndeedRSS(q, l);
    let fresh = 0;
    for (const item of items) {
      if (!seenLinks.has(item.link)) {
        seenLinks.add(item.link);
        allItems.push(item);
        fresh++;
      }
    }
    console.log(`${fresh} new listings`);
    await new Promise((r) => setTimeout(r, 800)); // polite delay between RSS requests
  }

  console.log(`\nTotal unique listings from RSS: ${allItems.length}`);

  // Filter by title relevance first (cheap)
  const { urls: trackerUrls, pairs: trackerPairs } = trackerKeys();
  const candidates = allItems.filter((item) => {
    if (!isTitleRelevant(item.title)) return false;
    if (trackerUrls.has(item.link)) return false;
    const pair = `${item.company.toLowerCase()}|${item.title.toLowerCase()}`;
    if (trackerPairs.has(pair)) return false;
    return true;
  });
  console.log(`After title filter: ${candidates.length} candidates\n`);

  if (candidates.length === 0) {
    console.log("No new candidates found. Try running again later for fresh listings.\n");
    return;
  }

  // Launch browser just for fetching full descriptions
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
      ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
      : undefined,
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  let added = 0;
  const { urls: freshUrls, pairs: freshPairs } = trackerKeys(); // re-read after browser launch

  try {
    for (const item of candidates) {
      if (added >= needed) break;

      // Re-check dedup (tracker may have been updated mid-run)
      if (freshUrls.has(item.link)) continue;
      const pair = `${item.company.toLowerCase()}|${item.title.toLowerCase()}`;
      if (freshPairs.has(pair)) continue;

      const workType = classifyWorkType(item.location, item.snippet);
      const tier = classifyTier(item.location, workType);
      if (tier === 99) {
        console.log(`  ⛔ Out of area: ${item.title} @ ${item.company} (${item.location})`);
        freshUrls.add(item.link);
        continue;
      }

      // Quick exclude on snippet alone (saves a page load)
      const quickExclude = autoExcludeReason(item.snippet, item.title);
      if (quickExclude) {
        console.log(`  ⛔ Auto-excluded (snippet): ${item.title} @ ${item.company}`);
        if (!DRY_RUN) {
          appendTracker({
            company: item.company, title: item.title, url: item.link,
            location: item.location, work_type: workType, tier,
            apply_method: "indeed", date_found: today(),
            date_applied: "", status: "excluded",
            notes: `AUTO-EXCLUDED: ${quickExclude}`, skill_gaps: "",
          });
        }
        freshUrls.add(item.link);
        freshPairs.add(pair);
        continue;
      }

      // Fetch full description
      process.stdout.write(`  📄 ${item.title} @ ${item.company}... `);
      const { description, finalUrl } = await fetchJobDescription(page, item.link);
      freshUrls.add(finalUrl);
      freshUrls.add(item.link);

      const fullText = description || item.snippet;
      const excludeReason = autoExcludeReason(fullText, item.title);
      if (excludeReason) {
        console.log(`excluded (${excludeReason.slice(0, 50)})`);
        if (!DRY_RUN) {
          appendTracker({
            company: item.company, title: item.title, url: finalUrl,
            location: item.location, work_type: workType, tier,
            apply_method: "indeed", date_found: today(),
            date_applied: "", status: "excluded",
            notes: `AUTO-EXCLUDED: ${excludeReason}`, skill_gaps: "",
          });
        }
        freshPairs.add(pair);
        continue;
      }

      const emphasize = extractEmphasizeKeywords(fullText);
      const job = {
        company: item.company,
        title: item.title,
        url: finalUrl,
        location: item.location,
        work_type: workType,
        tier,
        description: fullText,
        emphasize,
      };

      if (DRY_RUN) {
        console.log(`[DRY-RUN] would add`);
        added++;
        freshPairs.add(pair);
        continue;
      }

      try {
        const { resumeFile, coverFile, skill_gaps } = generateApplication(job);
        appendTracker({
          company: job.company, title: job.title, url: job.url,
          location: job.location, work_type: workType, tier,
          apply_method: "indeed", date_found: today(),
          date_applied: "", status: "ready",
          notes: `Resume: ${path.basename(resumeFile)} | Cover: ${path.basename(coverFile)}`,
          skill_gaps: skill_gaps.join("; "),
        });
        console.log(`✅ added`);
        added++;
        freshPairs.add(pair);
      } catch (e) {
        console.log(`failed to generate: ${e.message.slice(0, 60)}`);
      }

      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n✅ Replenish done — added ${added} new jobs. Ready jobs now: ${countReady()}\n`);
}

main().catch((e) => {
  console.error("Fatal error in replenish:", e.message);
  process.exit(1);
});
