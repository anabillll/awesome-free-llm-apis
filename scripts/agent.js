#!/usr/bin/env node
/**
 * Ecommerce Job Search Agent
 *
 * Reads criteria.json, searches Indeed, filters, generates applications,
 * and updates tracker.csv. Meant to be driven by the Claude Code agent
 * which calls the Indeed MCP tools and then feeds results here.
 *
 * This script handles:
 *   - Auto-exclude logic (criteria.json auto_exclude_if)
 *   - Skill-gap detection (master_resume.json cross-reference)
 *   - tracker.csv append
 *   - Delegating to generate_application.js for each qualifying posting
 *
 * The Claude agent is responsible for:
 *   - Calling the Indeed MCP search/details tools
 *   - Feeding job objects to this script via --job flag
 *   - Handling browser submission (CAPTCHA, logins, form fill)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CRITERIA = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "criteria.json"), "utf8"));
const RESUME = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "master_resume.json"), "utf8"));
const TRACKER = path.join(ROOT, "data", "tracker.csv");
const GENERATE = path.join(ROOT, "scripts", "generate_application.js");
const TMP = path.join(ROOT, "output", "tmp");

fs.mkdirSync(TMP, { recursive: true });

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

function appendTracker(row) {
  const fields = [
    "company", "title", "url", "location", "work_type", "tier",
    "apply_method", "date_found", "date_applied", "status", "notes", "skill_gaps",
  ];
  const line = fields.map((f) => csvEscape(row[f] ?? "")).join(",");
  fs.appendFileSync(TRACKER, line + "\n");
}

function autoExcludeReason(jobText, jobTitle) {
  const text = (jobText + " " + jobTitle).toLowerCase();

  for (const rule of CRITERIA.auto_exclude_if) {
    switch (rule.condition) {
      case "requires_french":
        if (/bilingu|french|fran[çc]ais/.test(text)) return rule.description;
        break;
      case "requires_senior_5plus_years":
        if (/5\+?\s*years|five\s*\+?\s*years/.test(text) &&
            /senior|lead|head|director|principal/.test(text))
          return rule.description;
        break;
      case "requires_relocation_outside_canada":
        if (/must relocate|relocation required/.test(text) &&
            !/canada|toronto|remote/.test(text))
          return rule.description;
        break;
      case "requires_advanced_bi_tools":
        if (/(advanced|expert|proficient)\s+(power bi|tableau|looker)/.test(text))
          return rule.description;
        break;
      case "requires_masters_degree":
        if (/master'?s|mba|m\.b\.a|graduate degree required/.test(text))
          return rule.description;
        break;
      case "requires_coding_engineering":
        if (/\b(python|sql|javascript|typescript|react|node\.js|software engineer|backend|frontend)\b/.test(text) &&
            /required|must have|proficient/.test(text))
          return rule.description;
        break;
      case "requires_us_work_authorization_only":
        if (/us work authorization|must be authorized to work in the (us|united states)(?! and canada)/.test(text))
          return rule.description;
        break;
    }
  }
  return null;
}

function extractEmphasizeKeywords(jdText) {
  const knownSkillPatterns = [
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
  return knownSkillPatterns.filter((kw) => text.includes(kw));
}

function generateApplication(job) {
  const tmpFile = path.join(TMP, `job_${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(job, null, 2));
  try {
    const result = execSync(`node "${GENERATE}" "${tmpFile}"`, { encoding: "utf8" });
    fs.unlinkSync(tmpFile);
    return JSON.parse(result.trim());
  } catch (e) {
    fs.unlinkSync(tmpFile);
    throw e;
  }
}

function processJob(job) {
  const excludeReason = autoExcludeReason(
    job.description || "",
    job.title || ""
  );

  if (excludeReason) {
    appendTracker({
      company: job.company,
      title: job.title,
      url: job.url,
      location: job.location,
      work_type: job.work_type || "",
      tier: job.tier || "",
      apply_method: "indeed",
      date_found: today(),
      date_applied: "",
      status: "excluded",
      notes: excludeReason,
      skill_gaps: "",
    });
    return { status: "excluded", reason: excludeReason };
  }

  // Use caller-provided emphasize if given; fall back to auto-extraction
  const extracted = extractEmphasizeKeywords(job.description || "");
  const emphasize = (job.emphasize && job.emphasize.length > 0)
    ? [...new Set([...job.emphasize, ...extracted])]
    : extracted;
  const enrichedJob = { ...job, emphasize };

  const { resumeFile, coverFile, skill_gaps } = generateApplication(enrichedJob);

  appendTracker({
    company: job.company,
    title: job.title,
    url: job.url,
    location: job.location,
    work_type: job.work_type || "",
    tier: job.tier || "",
    apply_method: "indeed",
    date_found: today(),
    date_applied: "",
    status: "ready",
    notes: `Resume: ${path.basename(resumeFile)} | Cover: ${path.basename(coverFile)}`,
    skill_gaps: skill_gaps.join("; "),
  });

  return {
    status: "ready",
    resumeFile,
    coverFile,
    skill_gaps,
    emphasize,
  };
}

// CLI: node agent.js --job '{"company":...}'
const args = process.argv.slice(2);
const jobIdx = args.indexOf("--job");
if (jobIdx !== -1) {
  const job = JSON.parse(args[jobIdx + 1]);
  const result = processJob(job);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// If run without args, print usage
console.log("Usage: node agent.js --job '<job JSON>'");
console.log("The Claude agent orchestrates the search loop and calls this script per job.");
