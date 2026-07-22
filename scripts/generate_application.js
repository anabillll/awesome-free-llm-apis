#!/usr/bin/env node
/**
 * Generates a tailored plain-text resume and cover letter for a job posting.
 *
 * Usage:
 *   node generate_application.js <job.json>
 *
 * The job JSON must contain:
 *   { company, title, description, location, url, emphasize: string[], hidden_keyword?: string }
 *
 * Outputs two files into output/:
 *   resumes/<company_slug>_<title_slug>.txt
 *   cover_letters/<company_slug>_<title_slug>.txt
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RESUME_PATH = path.join(ROOT, "data", "master_resume.json");
const OUT_RESUME = path.join(ROOT, "output", "resumes");
const OUT_COVER = path.join(ROOT, "output", "cover_letters");

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}

function toTitleCase(s) {
  // Preserve known proper-noun patterns; title-case everything else
  return s
    .split(" ")
    .map((w) =>
      /^(GA4|CRO|SEM|SEO|PPC|DTC|LTV|AOV|CAC|ROAS|CPA|CPM|CTR|ROI|SMS|UX|UI|A\/B|QA|B2B|B2C|KPI)$/i.test(w)
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1)
    )
    .join(" ");
}

function buildResume(resume, job) {
  const { personal, education, certifications, skills, experience } = resume;
  const emphasize = job.emphasize || [];

  // Reorder skills: emphasised ones first, then the rest
  const allSkills = [
    ...skills.platforms_tools,
    ...skills.marketing_ecommerce,
    ...skills.soft_skills,
  ];

  const mapped = allSkills.map((sk) => {
    // Rephrase to match JD terminology where the concept is the same
    for (const kw of emphasize) {
      if (sk.toLowerCase().includes(kw.toLowerCase()) ||
          kw.toLowerCase().includes(sk.toLowerCase())) {
        return toTitleCase(kw); // use JD's phrasing, properly cased
      }
    }
    return sk;
  });

  const ordered = [
    ...emphasize.map(toTitleCase).filter((kw) =>
      mapped.some((m) => m.toLowerCase() === kw.toLowerCase())
    ),
    ...mapped.filter((sk) =>
      !emphasize.some((kw) => toTitleCase(kw).toLowerCase() === sk.toLowerCase())
    ),
  ];
  const uniqueSkills = [...new Set(ordered)];

  const lines = [];
  lines.push(personal.name.toUpperCase());
  lines.push(personal.email + (personal.phone ? `  |  ${personal.phone}` : ""));
  lines.push(personal.location);
  if (personal.linkedin) lines.push(personal.linkedin);
  lines.push("");

  lines.push("SKILLS");
  lines.push(uniqueSkills.join(", "));
  lines.push("");

  if (experience && experience.length > 0) {
    lines.push("EXPERIENCE");
    for (const exp of experience) {
      lines.push(`${exp.title} – ${exp.company} (${exp.start}–${exp.end || "Present"})`);
      if (exp.location) lines.push(exp.location);
      if (exp.bullets) {
        for (const b of exp.bullets) lines.push(`  • ${b}`);
      }
      lines.push("");
    }
  }

  lines.push("EDUCATION");
  for (const ed of education) {
    lines.push(`${ed.degree}${ed.field ? `, ${ed.field}` : ""} – ${ed.institution}`);
  }
  lines.push("");

  if (certifications && certifications.length > 0) {
    lines.push("CERTIFICATIONS");
    for (const cert of certifications) {
      lines.push(cert.name + (cert.issuer ? ` – ${cert.issuer}` : ""));
    }
  }

  return lines.join("\n");
}

function buildCoverLetter(resume, job) {
  const { personal, skills } = resume;
  const { company, title, description, hidden_keyword } = job;

  const topSkills = (job.emphasize || []).slice(0, 4).map(toTitleCase).join(", ");
  const allSkills = [
    ...skills.platforms_tools,
    ...skills.marketing_ecommerce,
  ].join(", ");

  let body = `Dear Hiring Team at ${company},

I am writing to express my interest in the ${title} role at ${company}. With a background in e-commerce operations, digital marketing, and performance media — including hands-on experience with ${topSkills || allSkills} — I am confident I can contribute meaningfully to your team from day one.

My experience spans Shopify store management, paid media buying across Facebook and Google Ads, Klaviyo-driven email marketing automation, and data-informed decision-making through Google Analytics and multivariate testing. I am particularly drawn to ${company} because the scope of this role aligns closely with the ecommerce challenges I most enjoy solving: growing revenue, improving conversion rates, and scaling paid acquisition efficiently.

I thrive in cross-functional environments, am comfortable owning projects independently, and bring strong attention to detail to every campaign and process I manage.

I would welcome the opportunity to discuss how my background fits ${company}'s goals. Thank you for your consideration.

Sincerely,
${personal.name}
${personal.email}`;

  if (hidden_keyword) {
    body = body.replace(
      "Thank you for your consideration.",
      `${hidden_keyword}. Thank you for your consideration.`
    );
  }

  return body;
}

function findSkillGaps(resume, job) {
  const allKnown = [
    ...resume.skills.platforms_tools,
    ...resume.skills.marketing_ecommerce,
    ...resume.skills.soft_skills,
    ...resume.education.map((e) => e.degree),
    ...(resume.certifications || []).map((c) => c.name),
  ].map((s) => s.toLowerCase());

  const gaps = [];
  for (const kw of job.emphasize || []) {
    const kwLower = kw.toLowerCase();
    const known = allKnown.some(
      (sk) => sk.includes(kwLower) || kwLower.includes(sk)
    );
    if (!known) gaps.push(kw);
  }
  return gaps;
}

function main() {
  const jobPath = process.argv[2];
  if (!jobPath) {
    console.error("Usage: node generate_application.js <job.json>");
    process.exit(1);
  }

  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  const resume = JSON.parse(fs.readFileSync(RESUME_PATH, "utf8"));

  fs.mkdirSync(OUT_RESUME, { recursive: true });
  fs.mkdirSync(OUT_COVER, { recursive: true });

  const base = `${slug(job.company)}_${slug(job.title)}`;

  const resumeText = buildResume(resume, job);
  const coverText = buildCoverLetter(resume, job);
  const gaps = findSkillGaps(resume, job);

  const resumeFile = path.join(OUT_RESUME, `${base}.txt`);
  const coverFile = path.join(OUT_COVER, `${base}.txt`);

  fs.writeFileSync(resumeFile, resumeText);
  fs.writeFileSync(coverFile, coverText);

  console.log(JSON.stringify({ resumeFile, coverFile, skill_gaps: gaps }));
}

main();
