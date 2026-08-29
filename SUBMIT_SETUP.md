# Running the Job Submitter Locally

The submitter opens a real Chrome window on your computer, logs into Indeed once,
then fills and submits each application automatically. It pauses and waits for you
on CAPTCHAs, login walls, or any question it can't answer.

## One-time setup (do this once)

### 1. Install Node.js
Download from https://nodejs.org (LTS version). Verify: `node --version`

### 2. Clone or download this repo to your computer

### 3. Install dependencies
```
cd awesome-free-llm-apis
npm install
npx playwright install chromium
```

## Running the submitter

```
node scripts/submitter.js
```

A Chrome window will open. The script will:
1. Ask you to log into Indeed (one time — session is saved)
2. Work through each `ready` job in `data/tracker.csv`
3. Fill every field automatically using your resume and cover letters
4. Paste screening answers from `data/screening_answers.json`
5. Wait 90–180 seconds between submissions to look natural
6. Pause and hand control to you for: CAPTCHAs, login walls, unknown questions

### Options
```
node scripts/submitter.js --dry-run     # fills forms but doesn't click Submit
node scripts/submitter.js --limit 5    # submit at most 5 this session
```

## What you'll see
- `✅ Submitted` — application went through
- `⚠️  PAUSING` — needs you in the browser (CAPTCHA, unknown question, external ATS)
- `❌ Error` — something went wrong; check tracker.csv for details

## After each session
`data/tracker.csv` is updated automatically with status `applied` and the date.

## Files the submitter uses
| File | Purpose |
|------|---------|
| `data/tracker.csv` | Source of truth — jobs with `status=ready` get processed |
| `data/master_resume.json` | Your name, email, work authorization answers |
| `data/screening_answers.json` | Pre-written answers for Acceler8, ScaleMyMealPrep, Marketech |
| `output/resumes/*.txt` | Tailored resume per job (uploaded as file) |
| `output/cover_letters/*.txt` | Tailored cover letter per job |
| `output/browser_session/state.json` | Saved Indeed login (so you only log in once) |
