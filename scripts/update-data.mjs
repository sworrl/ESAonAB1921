/* Refreshes data/bill.json and data/points.json from LegInfo and
   consumerrights.wiki. Runs in GitHub Actions on a schedule, or locally:
   node scripts/update-data.mjs

   Rules:
   - Hand-written prose (summaries, variants) is never overwritten.
   - If a wiki section's text changes, its point gets stale_content: true
     so the site can flag the drift and a human can re-summarize.
   - New wiki sections become new points marked needs_review: true with the
     section's own opening sentences as the only variant.
   - If a fetch fails, the old file is kept and marked stale: true. */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BILL_ID = "202520260AB1921";
const LEGINFO = `https://leginfo.legislature.ca.gov/faces/billStatusClient.xhtml?bill_id=${BILL_ID}`;
const WIKI_API = "https://consumerrights.wiki/api.php";
const WIKI_PAGE = "User:Louis/Rebuttal_to_the_ESA_on_AB_1921_and_Stop_Killing_Games";
const UA = "savestate-data-refresh (static civic info site; contact via repo issues)";

const readJson = p => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const writeJson = (p, obj) => writeFileSync(join(ROOT, p), JSON.stringify(obj, null, 2) + "\n");

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

/* ---------- LegInfo ---------- */
function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .split("\n").map(s => s.trim()).filter(Boolean);
}
const after = (lines, label) => {
  const i = lines.findIndex(l => l.toLowerCase().startsWith(label.toLowerCase()));
  return i >= 0 && i + 1 < lines.length ? lines[i + 1] : null;
};
function usDateToIso(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(s || "");
  return m ? `20${m[3]}-${m[1]}-${m[2]}` : null;
}
function isoShift(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function prevBusinessDay(iso) {
  let d = isoShift(iso, -1);
  while ([0, 6].includes(new Date(d + "T00:00:00Z").getUTCDay())) d = isoShift(d, -1);
  return d;
}

function derivePhase({ type, houseLoc, committeeLoc, lastAction, oldPhase }) {
  const a = (lastAction || "").toLowerCase();
  const t = (type || "").toLowerCase();
  if (a.includes("chaptered")) return "chaptered";
  if (a.includes("vetoed")) return "vetoed";
  if (a.includes("enrolled") || a.includes("presented to the governor")) return "governor";
  if (a.includes("concurrence")) return "concurrence";
  if (houseLoc === "Senate" && t.includes("committee process")) {
    return /privacy/i.test(committeeLoc || "") ? "senate-committee" : "senate-committee-2";
  }
  if (houseLoc === "Senate" && (t.includes("floor process") || a.includes("third reading"))) return "senate-floor";
  return oldPhase;
}

async function refreshBill() {
  const bill = readJson("data/bill.json");
  try {
    const lines = htmlToLines(await fetchText(LEGINFO));
    const houseLoc = after(lines, "House Location:");
    const committeeLoc = after(lines, "Committee Location:");
    const hearingUs = after(lines, "Committee Hearing Date:");
    const lastAmendedUs = after(lines, "Last Amended Date:");
    const typeIdx = lines.findIndex(l => l === "Type of Measure");
    const type = typeIdx >= 0 ? lines[typeIdx + 1] : null;

    const histIdx = lines.findIndex(l => l.startsWith("Last 5 History Actions"));
    const history = [];
    if (histIdx >= 0) {
      let i = histIdx + 1;
      while (i < lines.length && history.length < 5) {
        if (/^\d{2}\/\d{2}\/\d{2}$/.test(lines[i])) {
          history.push({ date: usDateToIso(lines[i]), action: lines[i + 1] || "" });
          i += 2;
        } else i += 1;
        if (i - histIdx > 30) break;
      }
    }

    if (!houseLoc && !history.length) throw new Error("LegInfo page parsed to nothing recognizable");

    const hearingIso = usDateToIso(hearingUs);
    const activeIsPdtcp = /privacy/i.test(committeeLoc || "");
    if (houseLoc) bill.house_location = houseLoc;
    if (type) bill.type_of_measure = type;
    if (lastAmendedUs) bill.last_amended = usDateToIso(lastAmendedUs) || bill.last_amended;
    if (history.length) bill.history = history;
    bill.phase = derivePhase({
      type, houseLoc, committeeLoc,
      lastAction: history[0] && history[0].action,
      oldPhase: bill.phase
    });
    if (activeIsPdtcp && hearingIso) {
      bill.committee.hearing_date = hearingIso;
      bill.committee.letter_deadline = isoShift(hearingIso, -7);
      bill.committee.call_day = prevBusinessDay(hearingIso);
      bill.notice = null;
    } else if (committeeLoc && !activeIsPdtcp && bill.phase.startsWith("senate-committee")) {
      bill.second_committee.hearing_date = hearingIso;
      bill.notice = `LegInfo now shows the bill in: ${committeeLoc}. Member cards on this page still show the first committee; check the official status link for the current one.`;
    }
    const votes = (history.find(h => /ayes \d+\. noes \d+/i.test(h.action)) || {}).action;
    const vm = votes && /ayes (\d+)\. noes (\d+)/i.exec(votes);
    if (vm && bill.house_location === "Senate") {
      bill.assembly_vote = { ayes: +vm[1], noes: +vm[2], date: (history.find(h => h.action === votes) || {}).date || bill.assembly_vote.date };
    }
    bill.stale = false;
    bill.synced_at = new Date().toISOString();
    writeJson("data/bill.json", bill);
    console.log(`bill.json: refreshed (phase=${bill.phase}, hearing=${bill.committee.hearing_date})`);
  } catch (e) {
    bill.stale = true;
    writeJson("data/bill.json", bill);
    console.error("bill.json: refresh FAILED, kept last good data:", e.message);
  }
}

/* ---------- wiki ---------- */
function cleanWikitext(s) {
  return s
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[\s\S]*?<\/ref>/g, "")
    .replace(/\[\[File:[\s\S]*?\]\]/g, "")
    .replace(/\{\{[\s\S]*?\}\}/g, "")
    .replace(/'{2,}/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/<\/?blockquote>/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}
const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 16);
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
const firstSentences = (s, n) => s.split(/(?<=[.!?])\s+/).slice(0, n).join(" ");

async function refreshPoints() {
  const pts = readJson("data/points.json");
  try {
    const url = `${WIKI_API}?action=parse&page=${encodeURIComponent(WIKI_PAGE)}&prop=wikitext|sections|revid&format=json&formatversion=2`;
    const data = JSON.parse(await fetchText(url));
    const revid = data.parse.revid;
    const wikitext = data.parse.wikitext;
    const apiSections = data.parse.sections;

    const parts = wikitext.split(/^==([^=].*?)==\s*$/m);
    const sections = [];
    for (let i = 1; i < parts.length; i += 2) {
      const title = parts[i].replace(/'{2,}/g, "").trim();
      if (/^references$/i.test(title)) continue;
      const body = parts[i + 1] || "";
      const quoteMatch = /<blockquote>([\s\S]*?)<\/blockquote>/.exec(body);
      const quote = quoteMatch ? cleanWikitext(quoteMatch[1]).replace(/^["“]|["”]$/g, "") : null;
      const clean = cleanWikitext(body);
      const apiSec = apiSections.find(s => cleanWikitext(s.line) === title || s.line === title);
      sections.push({
        title,
        anchor: apiSec ? apiSec.linkAnchor || apiSec.anchor : title.replace(/ /g, "_"),
        quote,
        clean,
        hash: sha(clean)
      });
    }
    if (!sections.length) throw new Error("no sections parsed from wikitext");

    const seen = new Set();
    for (const sec of sections) {
      let p = pts.points.find(x => x.anchor === sec.anchor)
        || pts.points.find(x => slugify(sec.title).includes(x.id) || x.title === sec.title);
      if (p) {
        if (p.sec_hash && p.sec_hash !== sec.hash) p.stale_content = true;
        if (p.sec_hash === sec.hash) p.stale_content = false;
        p.sec_hash = sec.hash;
        p.anchor = sec.anchor;
        if (sec.quote) p.esa_quote = sec.quote;
        p.removed = false;
        seen.add(p.id);
      } else {
        const id = slugify(sec.title);
        pts.points.push({
          id,
          title: sec.title,
          esa_quote: sec.quote,
          summary: firstSentences(sec.clean.replace(sec.quote || "", "").trim(), 2),
          variants: [firstSentences(sec.clean.replace(sec.quote || "", "").trim(), 2)],
          anchor: sec.anchor,
          sec_hash: sec.hash,
          stale_content: false,
          needs_review: true,
          removed: false
        });
        seen.add(id);
        console.log(`points.json: NEW wiki section added as point "${id}" (needs_review)`);
      }
    }
    for (const p of pts.points) {
      if (!seen.has(p.id)) { p.removed = true; console.log(`points.json: point "${p.id}" no longer on the wiki, marked removed`); }
    }
    pts.wiki.revid = revid;
    pts.wiki.synced_at = new Date().toISOString();
    pts.wiki.stale = false;
    writeJson("data/points.json", pts);
    console.log(`points.json: refreshed (revid=${revid}, sections=${sections.length})`);
  } catch (e) {
    pts.wiki.stale = true;
    writeJson("data/points.json", pts);
    console.error("points.json: refresh FAILED, kept last good data:", e.message);
  }
}

await refreshBill();
await refreshPoints();
