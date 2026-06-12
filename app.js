/* SAVESTATE: client-side only. No storage, no analytics, no outbound requests
   beyond this site's own files. The only exception is the map embed, which
   loads OpenStreetMap tiles after an explicit click. */
"use strict";

const S = {
  bill: null,
  targets: null,
  points: null,
  geo: { mode: null, district: null, coords: null },
  seed: 0,
  lastGenerated: ""
};

/* ---------- tiny DOM helpers ---------- */
function $(id) { return document.getElementById(id); }
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const k in (attrs || {})) {
    if (k === "class") el.className = attrs[k];
    else el.setAttribute(k, attrs[k]);
    /* deliberately no innerHTML path anywhere in this file: every string,
       including wiki-derived data, is rendered as a text node */
  }
  for (const kid of kids) {
    if (kid == null) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

/* ---------- seeded randomness so "Reword it" changes everything at once ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }

/* ---------- dates ---------- */
function dlong(iso) {
  if (!iso) return "";
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US",
    { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
function dshort(iso) {
  if (!iso) return "";
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US",
    { month: "long", day: "numeric", timeZone: "UTC" });
}
function daysUntil(iso) {
  if (!iso) return null;
  const target = new Date(iso + "T23:59:59Z").getTime();
  return Math.ceil((target - Date.now()) / 86400000);
}
function icsDate(iso) { return iso.replaceAll("-", ""); }
function icsDayAfter(iso) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

/* ---------- boot ---------- */
async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    [S.bill, S.targets, S.points] = await Promise.all([
      loadJSON("data/bill.json"),
      loadJSON("data/targets.json"),
      loadJSON("data/points.json")
    ]);
  } catch (e) {
    document.body.prepend(h("div", { class: "stale-banner" },
      "Data files failed to load. If you opened index.html straight from disk, serve the folder instead: python3 -m http.server"));
    return;
  }
  renderStatus();
  renderPlaybook();
  renderPointsList();
  renderCheatSheet();
  renderCalls();
  renderVisit();
  renderRecipients();
  fillDistrictSelect();
  wireBuilder();
  wireDeciders();
  wireGeo();
  wireMisc();
});

/* ---------- status ---------- */
const PHASES = ["assembly", "senate-committee", "senate-floor", "governor", "law"];
function phaseIndex(p) {
  if (p === "concurrence") return 2;
  if (p === "chaptered" || p === "law") return 4;
  if (p === "vetoed") return 3;
  const i = PHASES.indexOf(p);
  return i < 0 ? 1 : i;
}

function renderStatus() {
  const b = S.bill;
  const v = b.assembly_vote;
  const steps = [
    "Assembly: passed " + v.ayes + "-" + v.noes,
    "Senate committees",
    "Senate floor",
    "Governor's desk",
    "Law"
  ];
  const now = phaseIndex(b.phase);
  const track = $("phase-track");
  steps.forEach((label, i) => {
    const li = h("li", { class: i < now ? "done" : (i === now ? "now" : "") },
      (i < now ? "✓ " : "") + label + (i === now ? "  ← now" : ""));
    track.append(li);
  });

  const hd = b.committee && b.committee.hearing_date;
  const dl = b.committee && b.committee.letter_deadline;
  const cd = $("countdown");
  if (b.phase === "senate-committee" && hd) {
    const dh = daysUntil(hd);
    const dd = daysUntil(dl);
    let msg = "Hearing " + dlong(hd) + " (" + (dh <= 0 ? "today" : dh + (dh === 1 ? " day" : " days")) + ")";
    if (dd != null && dd >= 0) msg += " · letters due in " + (dd === 0 ? "0 days, today" : dd + (dd === 1 ? " day" : " days"));
    if (dd != null && dd < 0) msg += " · portal letter window has closed; email and calls still work";
    cd.textContent = msg;
  } else if (b.phase === "vetoed") {
    cd.textContent = "Vetoed.";
  } else if (phaseIndex(b.phase) === 4) {
    cd.textContent = "Signed into law.";
  } else {
    cd.textContent = "";
  }

  $("sync-line").textContent = "Synced " + new Date(b.synced_at).toLocaleString() +
    " from LegInfo (rev " + b.last_amended + " text) and consumerrights.wiki (rev " + S.points.wiki.revid + ").";

  if (b.history && b.history.length) {
    $("history-line").textContent = "Latest action, " + b.history[0].date + ": " + b.history[0].action;
  }
  if (b.stale) {
    const sb = $("stale-banner");
    sb.textContent = "The last automatic refresh could not reach LegInfo. You are seeing the last good data, synced " + new Date(b.synced_at).toLocaleString() + ". Double-check dates against the official status link in the footer.";
    sb.classList.remove("hidden");
  } else if (b.notice) {
    const sb = $("stale-banner");
    sb.textContent = b.notice;
    sb.classList.remove("hidden");
  }
}

/* ---------- playbook ---------- */
function playbookItems() {
  const b = S.bill, t = S.targets;
  const c = b.committee || {};
  switch (b.phase) {
    case "senate-committee": return [
      { t: "Put a letter in the official record", d: c.letter_deadline,
        body: "Use the builder below, then paste it into the Legislature's position letter portal as SUPPORT for " + b.measure + ". Portal letters are what the committee analysis tallies. Most committees close letters one week out, so treat " + dshort(c.letter_deadline) + " as the cutoff." },
      { t: "Email the committee inbox", d: null,
        body: "Same letter, straight to " + t.committee.email + ". The send button below opens it pre-filled in your own mail app." },
      { t: "Check whether your senator is one of the nine", d: null,
        body: "Use the location section above. A committee member's office weighs mail from their own district heaviest, and that fact goes in your first line." },
      { t: "Call on " + dshort(c.call_day), d: c.call_day,
        body: "The Friday before the vote, offices tally calls. The script and all ten numbers are below. Under a minute per call." },
      { t: "Be in the room " + dshort(c.hearing_date), d: c.hearing_date,
        body: "Public comment is open to anyone present: name, city, \"I support AB 1921.\" Print the visit sheet before you go." }
    ];
    case "senate-committee-2": return [
      { t: "Second committee: " + (b.second_committee ? b.second_committee.name : ""), d: (b.second_committee || {}).hearing_date,
        body: "The bill cleared the first committee and moved to Business, Professions and Economic Development. Same drill: portal letter, email, calls. This page has re-aimed every button at the new committee." }
    ];
    case "senate-floor": return [
      { t: "Write your own senator", d: null,
        body: "The bill is past committee and every senator votes next. Find yours with the location section or the official lookup, then send the letter from the builder." },
      { t: "Call your senator's Capitol office", d: null,
        body: "District phone numbers follow the pattern (916) 651-40 plus your two-digit district number. The calls section fills it in once your district is known." }
    ];
    case "concurrence": return [
      { t: "Back to the Assembly for one vote", d: null,
        body: "The Senate amended the bill, so the Assembly votes once more on the changes. It passed there " + S.bill.assembly_vote.ayes + "-" + S.bill.assembly_vote.noes + " before. Letters to your Assemblymember and the author's office help hold the margin." }
    ];
    case "governor": return [
      { t: "Ask the Governor to sign", d: null,
        body: "AB 1921 is on Governor Newsom's desk. He has 12 days to sign or veto once a bill is presented. Use his contact form, pick AB 1921, mark SUPPORT, and paste your letter. Then call " + S.targets.governor.phone + "." }
    ];
    case "chaptered": case "law": return [
      { t: "It's law. Two minutes of thank-yous", d: null,
        body: "Offices remember gratitude because they get so little of it. A one-line thank-you to the author and to your senator's office builds the relationship for the next bill." }
    ];
    case "vetoed": return [
      { t: "Vetoed", d: null,
        body: "A two-thirds vote of both houses can override, which is rare in California. The realistic path is reintroduction next session. The wiki and FULU will carry next steps; the data on this page keeps refreshing." }
    ];
    default: return [
      { t: "Watch this space", d: null, body: "The bill is between stations. This page refreshes itself every few hours from LegInfo." }
    ];
  }
}

function renderPlaybook() {
  const list = $("playbook-list");
  list.textContent = "";
  for (const item of playbookItems()) {
    const li = h("li", null, h("strong", null, item.t));
    if (item.d) li.append(" ", h("span", { class: "due" }, "by " + dshort(item.d)));
    li.append(h("p", null, item.body));
    list.append(li);
  }
}

/* ---------- points ---------- */
function livePoints() { return S.points.points.filter(p => !p.removed); }

function renderPointsList() {
  const ul = $("points-list");
  for (const p of livePoints()) {
    const cb = h("input", { type: "checkbox", value: p.id });
    const label = h("label", null, cb,
      h("span", null,
        h("span", { class: "pt-title" }, p.title),
        h("span", { class: "pt-sub" }, p.esa_quote ? "ESA: “" + truncate(p.esa_quote, 110) + "”" : p.summary.split(". ")[0] + ".")));
    ul.append(h("li", null, label));
  }
}
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }
function selectedPoints() {
  return [...$("points-list").querySelectorAll("input:checked")].map(i =>
    livePoints().find(p => p.id === i.value));
}

function renderCheatSheet() {
  const wrap = $("cheat-list");
  for (const p of livePoints()) {
    const card = h("div", { class: "cheat-card" }, h("h3", null, p.title));
    if (p.esa_quote) card.append(h("p", { class: "claim" }, "“" + p.esa_quote + "”  (ESA op-ed)"));
    card.append(h("p", { class: "answer" }, p.summary));
    card.append(h("p", { class: "src" },
      h("a", { href: S.points.wiki.url + "#" + encodeURI(p.anchor), rel: "noopener noreferrer" }, "full section on the wiki")));
    if (p.stale_content) card.append(h("p", { class: "drift" },
      "The wiki section behind this card changed after this summary was written. Click through for the current version."));
    wrap.append(card);
  }
}

/* ---------- letter engine ---------- */
const OPENERS = {
  "senate-committee": [
    c => "I'm writing to ask for your aye vote on AB 1921, the Protect Our Games Act, when it comes before the " + c + " on " + dshort(S.bill.committee.hearing_date) + ".",
    c => "Please vote yes on AB 1921 at the " + dshort(S.bill.committee.hearing_date) + " hearing.",
    c => "I'm asking you to support AB 1921 when your committee takes it up on " + dshort(S.bill.committee.hearing_date) + ". The Assembly passed it " + S.bill.assembly_vote.ayes + " to " + S.bill.assembly_vote.noes + ", and it deserves the same result in the Senate.",
    c => "AB 1921 comes before your committee on " + dshort(S.bill.committee.hearing_date) + ", and I'm writing as one of the people it protects: someone who pays for games."
  ],
  "senate-floor": [
    () => "I'm writing to ask for your aye vote when AB 1921, the Protect Our Games Act, reaches the Senate floor.",
    () => "Please vote yes on AB 1921. It passed the Assembly " + S.bill.assembly_vote.ayes + " to " + S.bill.assembly_vote.noes + " and cleared policy committee; the floor vote is what remains."
  ],
  "governor": [
    () => "I'm writing to ask you to sign AB 1921, the Protect Our Games Act.",
    () => "Please sign AB 1921 when it reaches your desk."
  ],
  "author": [
    () => "I'm writing to thank you for authoring AB 1921, the Protect Our Games Act.",
    () => "Thank you for carrying AB 1921, the Protect Our Games Act, through the Assembly."
  ]
};
const CLOSERS = [
  "Please vote aye on AB 1921. Thank you for your time.",
  "The Assembly passed this 43 to 16. I'm asking your committee to keep it moving. Thank you.",
  "Thank you for reading this, and for the work your office does.",
  "I ask for your aye vote. Thank you."
];
const CLOSERS_GOV = [
  "Please sign it. Thank you.",
  "Signing this bill costs taxpayers nothing and tells every publisher selling into California that a sale is a sale. Thank you."
];
const CLOSERS_AUTHOR = [
  "Thank you for fighting for this. It matters to the people who pay for games.",
  "I'm grateful you took this on. Please see it through."
];

function residenceLine(rnd, recipient) {
  const city = $("f-city").value.trim();
  const d = S.geo.district;
  const mode = S.geo.mode;
  if (mode === "ca") {
    if (recipient.kind === "member-own" && city) return pick(rnd, [
      "I'm your constituent in " + city + ".",
      "I live and vote in your district, in " + city + "."
    ]);
    if (recipient.kind === "member-own") return "I live and vote in your district.";
    if (d && memberByDistrict(d) && city) return "I live in " + city + ", in Senate District " + d + ", which Senator " + memberByDistrict(d).name + " represents on this committee.";
    if (city) return pick(rnd, ["I live in " + city + ".", "I'm writing from " + city + "."]);
    return "I'm a California resident.";
  }
  if (mode === "out") {
    const st = $("f-state").value.trim();
    const where = city ? (st ? city + ", " + st : city) : (st || "");
    if (where) return pick(rnd, [
      "I'm writing from " + where + ", outside California. The games I buy are sold under the rules your state sets, because publishers don't ship a separate version for one state.",
      "I live in " + where + ", out of state, and I'm paying attention to this committee because California's rules on game sales become everyone's rules."
    ]);
    return "I'm writing from outside California because the rules your state sets for game sales become everyone's rules.";
  }
  if (city) return "I'm writing from " + city + ".";
  return "";
}

function memberByDistrict(d) {
  return S.targets.members.find(m => m.district === Number(d)) || null;
}

function currentRecipient() {
  const sel = $("send-recipient");
  return RECIPIENTS[Number(sel.value)] || RECIPIENTS[0];
}

let RECIPIENTS = [];
function renderRecipients() {
  const t = S.targets, b = S.bill;
  RECIPIENTS = [];
  if (b.phase === "governor") {
    RECIPIENTS.push({ label: "Governor Newsom (contact form)", kind: "governor", link: t.governor.contact,
      salutation: "Dear Governor Newsom:" });
  }
  RECIPIENTS.push({
    label: "Committee inbox: " + t.committee.email, kind: "committee", email: t.committee.email,
    salutation: "Dear Chair " + chairLastName() + " and Members of the Committee:"
  });
  const d = S.geo.district;
  if (d) {
    const m = memberByDistrict(d);
    if (m) RECIPIENTS.push({
      label: "Your senator on the committee: " + m.name, kind: "member-own",
      link: sdSite(d) + "/contact", salutation: "Dear Senator " + lastName(m.name) + ":", phone: m.phone
    });
    else RECIPIENTS.push({
      label: "Your senator (District " + d + ", via contact form)", kind: "own-senator",
      link: sdSite(d) + "/contact", salutation: "Dear Senator:"
    });
  }
  RECIPIENTS.push({
    label: "Bill author, Asm. Ward (comment form on LegInfo)", kind: "author",
    link: b.links.status, salutation: "Dear Assemblymember Ward:"
  });
  const sel = $("send-recipient");
  sel.textContent = "";
  RECIPIENTS.forEach((r, i) => sel.append(h("option", { value: i }, r.label)));
  sel.addEventListener("change", updateSendHelp);
  updateSendHelp();
}
function chairLastName() {
  const c = S.targets.members.find(m => m.role === "Chair");
  return c ? lastName(c.name) : "";
}
function lastName(n) { return n.split(" ").slice(-1)[0]; }
function sdSite(d) { return "https://sd" + String(d).padStart(2, "0") + ".senate.ca.gov"; }
function sdPhone(d) { return "(916) 651-40" + String(d).padStart(2, "0"); }

function updateSendHelp() {
  const r = currentRecipient();
  const el = $("send-help");
  el.textContent = "";
  if (r.email) {
    el.append("Opens your own mail app addressed to ", h("span", { class: "mono" }, r.email),
      ". The mail goes from your account; this site never touches it.");
  } else {
    el.append("This recipient takes letters through a web form. The button copies your letter and opens ",
      h("a", { href: r.link, rel: "noopener noreferrer" }, r.link.replace("https://", "")),
      " in a new tab; paste it there.");
  }
}

function buildLetter() {
  return buildLetterFor(currentRecipient(), S.seed);
}

/* Build one letter for an arbitrary recipient at an arbitrary seed. The
   single-letter builder and the "reach every decider" panel both go through
   here, so a member's letter and the committee's letter differ only by
   salutation, the role line, and the seed (which reshuffles every phrase). */
function buildLetterFor(r, seed) {
  const rnd = mulberry32(seed);
  const phaseKey = OPENERS[S.bill.phase] ? S.bill.phase : "senate-committee";
  const name = $("f-name").value.trim();
  const city = $("f-city").value.trim();
  const story = $("f-story").value.trim();
  let pts = selectedPoints();
  if (!pts.length) pts = [livePoints().find(p => p.id === "plain-summary") || livePoints()[0]];

  const lines = [];
  lines.push(r.salutation);
  lines.push("");
  const opener = (r.kind === "governor")
    ? pick(rnd, OPENERS["governor"])()
    : r.kind === "author"
      ? pick(rnd, OPENERS["author"])()
      : pick(rnd, OPENERS[phaseKey])(S.bill.committee.name);
  const res = residenceLine(rnd, r);
  let first = res ? opener + " " + res : opener;
  if (r.role_line) first += " " + r.role_line;
  lines.push(first);
  lines.push("");

  const paras = pts.map(p => pick(rnd, p.variants));
  if (story) {
    const pos = rnd() < 0.5 ? 0 : 1;
    paras.splice(Math.min(pos + 1, paras.length), 0, story);
  }
  for (const p of paras) { lines.push(p); lines.push(""); }

  lines.push(pick(rnd, r.kind === "governor" ? CLOSERS_GOV : r.kind === "author" ? CLOSERS_AUTHOR : CLOSERS));
  lines.push("");
  lines.push(name || "[Your name]");
  const state = $("f-state").value.trim();
  const place = [city, state].filter(Boolean).join(", ");
  const distNote = (S.geo.mode === "ca" && S.geo.district)
    ? (place ? " · Senate District " + S.geo.district : "Senate District " + S.geo.district) : "";
  if (place || distNote) lines.push(place + distNote);
  return lines.join("\n");
}

function subjectLine() {
  const rnd = mulberry32(S.seed + 7);
  const hd = S.bill.committee && S.bill.committee.hearing_date;
  const pool = S.bill.phase === "governor"
    ? ["Please sign AB 1921", "AB 1921 signature request"]
    : [
      "Support for AB 1921 (Protect Our Games Act)",
      "Please vote aye on AB 1921",
      hd ? "AB 1921: support ahead of the " + dshort(hd) + " hearing" : "AB 1921 support letter",
      "AB 1921 support letter"
    ];
  return pick(rnd, pool);
}

/* ---------- reach every decider ----------
   One registered intent (name, city, email, story, points) expands into an
   individual letter to every official with a vote or a role on this bill.
   The user reviews and sends each: the committee inbox can be delivered by
   the site's relay in one press; every other official takes letters only
   through their own contact form, which a human submits. There is no
   auto-blast and no path to anyone who isn't deciding this bill. The set is
   bounded by the Legislature, not by a number we chose. */
function pad2(n) { return String(n).padStart(2, "0"); }

let DECIDERS = [];
const covDone = new Set();

function deciders() {
  const t = S.targets, b = S.bill, d = S.geo.district;
  const committeeStage = b.phase === "senate-committee" || b.phase === "senate-committee-2";
  const hd = (b.committee && b.committee.hearing_date) ? dshort(b.committee.hearing_date) : "its hearing";
  const list = [];

  if (b.phase === "governor") {
    list.push({
      name: "Governor " + t.governor.name, role: "Signs or vetoes", kind: "governor",
      method: "form", link: t.governor.contact, phone: t.governor.phone,
      salutation: "Dear Governor Newsom:", role_line: ""
    });
  }

  // The committee staff inbox: the one address a machine can deliver to.
  list.push({
    name: "Committee record inbox", role: "Counted in the official analysis", kind: "committee",
    method: "email", email: t.committee.email, phone: t.committee.phone,
    salutation: "Dear Chair " + chairLastName() + " and Members of the Committee:", role_line: ""
  });

  // Each committee member, individually, while the bill sits in committee.
  if (committeeStage) {
    for (const m of t.members) {
      const mine = d && m.district === Number(d);
      const sal = m.role === "Chair" ? "Dear Chair " + lastName(m.name) + ":"
        : m.role === "Vice Chair" ? "Dear Vice Chair " + lastName(m.name) + ":"
          : "Dear Senator " + lastName(m.name) + ":";
      const role_line = m.role === "Chair"
        ? "As chair, you decide whether AB 1921 is heard on " + hd + ". I'm asking you to give it a hearing and an aye vote."
        : "You sit on the committee that votes on AB 1921 on " + hd + ".";
      list.push({
        name: "Sen. " + m.name, role: m.role + " · SD-" + pad2(m.district) + " · " + m.party,
        kind: mine ? "member-own" : "member", method: "form",
        link: sdSite(m.district) + "/contact", phone: m.phone,
        salutation: sal, role_line: role_line, mine: !!mine
      });
    }
  }

  // The user's own senator, when they aren't already one of the nine.
  if (d && !memberByDistrict(d)) {
    list.push({
      name: "Your senator · SD-" + pad2(d), role: "Represents you · floor vote", kind: "own-senator",
      method: "form", link: sdSite(d) + "/contact", phone: sdPhone(d),
      salutation: "Dear Senator:",
      role_line: "You represent me in Senate District " + d + ". When AB 1921 reaches the floor, I'm asking for your aye vote.",
      mine: true
    });
  }

  // The bill's author: a thank-you that doubles as a nudge to hold the line.
  list.push({
    name: t.author.name, role: "Wrote the bill", kind: "author",
    method: "form", link: b.links.status, phone: null,
    salutation: "Dear Assemblymember Ward:",
    role_line: "Please keep fighting for it, and hold the line against amendments that weaken it."
  });

  return list;
}

function buildAll() {
  const name = $("f-name").value.trim();
  if (!name) { $("build-note").textContent = "Add your name in step 1 first; it signs every letter."; return; }
  if (!S.seed) S.seed = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
  DECIDERS = deciders();
  covDone.clear();
  renderDeciders();
  $("coverage").classList.remove("hidden");
  $("share-row").classList.remove("hidden");
  $("build-note").textContent = $("f-email").value.trim()
    ? ""
    : "Add a reply email in step 1 to send the committee letter through the site. The contact-form letters don't need it.";
  updateCoverage();
}

function renderDeciders() {
  const wrap = $("deciders-list");
  wrap.textContent = "";
  DECIDERS.forEach((r, i) => wrap.append(decisionCard(r, i)));
}

function decisionCard(r, i) {
  const letter = buildLetterFor(r, S.seed + i * 101);
  const card = h("div", { class: "decider-card" + (r.mine ? " mine" : "") });
  card.append(h("div", { class: "dc-head" },
    h("span", { class: "dc-name" }, r.name + (r.mine && r.kind === "member-own" ? "  ← your senator" : "")),
    h("span", { class: "dc-role" }, r.role)));

  const ta = h("textarea", { rows: "10", spellcheck: "true", "aria-label": "Letter to " + r.name });
  ta.value = letter;
  const warn = h("div", { class: "dc-warn hidden" });
  ta.addEventListener("input", debounce(() => {
    const hits = slopCheck(ta.value);
    if (hits.length) { warn.textContent = "Robot detector: " + hits.join(", ") + ". Put it in your own words."; warn.classList.remove("hidden"); }
    else warn.classList.add("hidden");
  }, 400));
  const det = h("details", { class: "dc-letter" }, h("summary", null, "Read and edit this letter"));
  det.append(ta, warn);
  card.append(det);

  const actions = h("div", { class: "dc-actions" });
  const status = h("span", { class: "dc-status fine" });
  if (r.method === "email") {
    const btn = h("button", { type: "button", class: "btn-amber" }, "Send via SAVESTATE");
    btn.addEventListener("click", () => sendOne(r, ta.value, btn, status, i));
    actions.append(btn);
  } else {
    const btn = h("button", { type: "button" }, "Open form + copy letter");
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(ta.value).catch(() => {});
      window.open(r.link, "_blank", "noopener");
      markDone(i);
      status.textContent = "Letter copied. Paste it into the form and send under your name.";
      flash(btn, "Copied + opened");
    });
    actions.append(btn);
  }
  if (r.phone) actions.append(h("a", { class: "dc-phone", href: "tel:" + r.phone.replace(/[^0-9+]/g, "") }, "☎ " + r.phone));
  actions.append(status);
  card.append(actions);
  return card;
}

async function sendOne(r, letter, btn, status, i) {
  const email = $("f-email").value.trim();
  if (!email) { status.textContent = "Add a reply email in step 1; the committee won't take anonymous mail."; return; }
  btn.disabled = true; status.textContent = "Sending...";
  try {
    const resp = await fetch("api/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("f-name").value.trim(), city: $("f-city").value.trim(), state: $("f-state").value.trim(), email, subject: subjectLine(), letter })
    });
    const dd = await resp.json();
    if (!dd.ok) { status.textContent = dd.error || "The relay refused it."; btn.disabled = false; return; }
    status.textContent = "Delivered. You're CC'd as your receipt.";
    flash(btn, "Sent"); markDone(i);
    setTimeout(() => { btn.disabled = false; }, 60_000); // matches the relay's per-minute gap
  } catch {
    status.textContent = "Relay unreachable. Use the committee email button in step 4, or its contact channels.";
    btn.disabled = false;
  }
}

function markDone(i) { covDone.add(i); updateCoverage(); }

function updateCoverage() {
  const n = DECIDERS.length, done = covDone.size;
  $("cov-fill").style.width = n ? Math.round(100 * done / n) + "%" : "0%";
  const c = $("cov-count");
  c.textContent = "";
  if (n && done >= n) {
    $("cov-fill").classList.add("full");
    c.append(h("strong", null, "All " + n + " reached."),
      " What moves this bill is distinct people, not messages. Send the tool to one friend who games.");
  } else {
    $("cov-fill").classList.remove("full");
    c.append("Contacted " + done + " of " + n + " deciders.");
  }
}

async function doShare() {
  const n = DECIDERS.length || deciders().length;
  const url = location.origin + location.pathname;
  const text = "I just wrote the " + n + " officials deciding California's AB 1921, the Protect Our Games Act (the Stop Killing Games bill). Your turn:";
  if (navigator.share) { try { await navigator.share({ title: "SAVESTATE", text: text, url: url }); return; } catch (e) { /* fell through to clipboard */ } }
  await navigator.clipboard.writeText(text + " " + url).catch(() => {});
  flash($("btn-share"), "Copied to share");
}

function wireDeciders() {
  $("btn-build-all").addEventListener("click", buildAll);
  $("btn-share").addEventListener("click", doShare);
  $("btn-schedule").addEventListener("click", scheduleSends);
}

/* ---------- bespoke example story ----------
   Thousands of combinations from hand-written fragments built on real,
   documented shutdowns. It is an illustration to replace with the visitor's
   own game and own loss, not testimony to send as-is; the slop guard still
   runs if they edit it, and none of these fragments trip it. */
const EX_GAMES = [
  { g: "The Crew", pub: "Ubisoft", buy: "2014", price: "$60" },
  { g: "Concord", pub: "Sony", buy: "2024", price: "$40" },
  { g: "Anthem", pub: "EA", buy: "2019", price: "$60" },
  { g: "Babylon's Fall", pub: "Square Enix", buy: "2022", price: "$60" },
  { g: "Marvel's Avengers", pub: "Square Enix", buy: "2020", price: "$60" },
  { g: "Hyper Scape", pub: "Ubisoft", buy: "2020", price: "$20" },
  { g: "Battlefield 1943", pub: "EA", buy: "2009", price: "$15" },
  { g: "Gran Turismo Sport", pub: "Sony", buy: "2017", price: "$60" },
  { g: "The Crew 2", pub: "Ubisoft", buy: "2018", price: "$60" }
];
const EX_OPEN = [
  d => "In " + d.buy + " I paid " + d.price + " for " + d.g + ".",
  d => "I bought " + d.g + " for " + d.price + " back in " + d.buy + ".",
  d => d.g + " cost me " + d.price + " when it came out in " + d.buy + ".",
  d => "I spent " + d.price + " on " + d.g + " in " + d.buy + ", and I played it for years.",
  d => "My copy of " + d.g + " set me back " + d.price + " in " + d.buy + "."
];
const EX_KILL = [
  d => d.pub + " later shut the servers off, and the game stopped working.",
  d => "Years on, " + d.pub + " ended the only servers it ran on, so now it will not start.",
  d => "Then " + d.pub + " pulled the plug on the servers and the whole thing went dark.",
  d => d.pub + " switched it off for good, the single-player parts included.",
  d => "When " + d.pub + " closed the servers, even the parts that never needed anyone else stopped."
];
const EX_LOSS = [
  "There was no refund and no offline version, so the money and the game are both gone.",
  "I was never offered my money back, and the box on my shelf loads to a menu that goes nowhere.",
  "Nothing was handed off, so what I paid for stopped existing the day a company decided it should.",
  "No patch, no standalone build, no refund. I own nothing I can point to.",
  "I have a dead install on my drive and a receipt for a game I cannot play.",
  "Support told me there was nothing they could do, and that was the end of it."
];
const EX_ASK = [
  "AB 1921 would have required 60 days of notice and one of three things: a patch, an offline build, or my money back.",
  "That is the exact ambush AB 1921 stops: notice first, then a way to keep playing or a refund.",
  "I am asking you to make sure the next buyer gets warning and a remedy, which is all AB 1921 requires.",
  "Sixty days of notice and a playable copy or a refund would have made this right.",
  ""
];
function exRand() { return (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) / 4294967296; }
function exPick(a) { return a[Math.floor(exRand() * a.length)]; }
function exampleStory() {
  const d = exPick(EX_GAMES);
  const parts = [exPick(EX_OPEN)(d), exPick(EX_KILL)(d), exPick(EX_LOSS)];
  const ask = exPick(EX_ASK);
  if (ask) parts.push(ask);
  return parts.join(" ");
}

/* ---------- schedule follow-ups ----------
   Reminders for the bill's real decision points, exported to the visitor's
   own calendar. This never sends on a timer: a human comes back and presses
   send at each stage, with a fresh reword so re-contact reads as new. */
function scheduleSends() {
  const b = S.bill, c = b.committee || {};
  const url = location.origin + location.pathname;
  const ev = [];
  if (c.letter_deadline) ev.push(vevent("ab1921-send1", c.letter_deadline,
    "AB 1921: send your support letter",
    "Build and send at " + url + " . Portal: " + b.links.portal + " and the committee inbox. Hit Reword for a draft in fresh words."));
  if (c.call_day) ev.push(vevent("ab1921-send2", c.call_day,
    "AB 1921: call, then send a fresh letter to your own senator",
    "Reword first so your second contact reads as new writing. Numbers and letters: " + url));
  if (c.hearing_date) ev.push(vevent("ab1921-hearing", c.hearing_date,
    "AB 1921 hearing day",
    "Public comment is open to anyone present. Agenda: " + b.links.agenda,
    S.targets.places.hearing.address));
  if (!ev.length) { flash($("btn-schedule"), "No dates yet"); return; }
  const cal = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SAVESTATE//AB1921//EN", "CALSCALE:GREGORIAN",
    ...ev, "END:VCALENDAR"].join("\r\n");
  download("AB1921-schedule.ics", cal, "text/calendar");
  $("schedule-status").textContent = "Saved to your calendar. At each reminder, Reword for a fresh letter before you send.";
}

/* ---------- slop guard ---------- */
const SLOP_PATTERNS = [
  [/—/g, "an em dash (the classic AI tell; use a comma or a period)"],
  [/\bdelve\b/i, "“delve”"],
  [/\bleverage\b/i, "“leverage”"],
  [/\butilize\b/i, "“utilize”"],
  [/\brobust\b/i, "“robust”"],
  [/\bseamless/i, "“seamless”"],
  [/\bcomprehensive\b/i, "“comprehensive”"],
  [/\bpivotal\b/i, "“pivotal”"],
  [/\bfurthermore\b/i, "“furthermore”"],
  [/\bmoreover\b/i, "“moreover”"],
  [/in today's\b/i, "“in today's...”"],
  [/it'?s worth noting/i, "“it's worth noting”"],
  [/in conclusion/i, "“in conclusion”"],
  [/game.?changer/i, "“game-changer”"],
  [/tapestry/i, "metaphorical “tapestry”"],
  [/testament to/i, "“testament to”"],
  [/stark reminder/i, "“stark reminder”"],
  [/unwavering/i, "“unwavering”"],
  [/beacon of/i, "“beacon of”"],
  [/i hope this (letter|email|message) finds you well/i, "“I hope this finds you well”"],
  [/it'?s not (just )?[\w\s]{1,20}[,;] it'?s/i, "the “it's not X, it's Y” pattern"]
];
function slopCheck(text) {
  const hits = [];
  for (const [re, label] of SLOP_PATTERNS) if (re.test(text)) hits.push(label);
  return hits;
}
function runSlopCheck() {
  const hits = slopCheck($("letter").value);
  const box = $("slop-warn");
  if (!hits.length) { box.classList.add("hidden"); return; }
  box.textContent = "Robot detector: this draft contains " + hits.join(", ") +
    ". Staffers read hundreds of letters and can smell pasted AI text. Put it in your own words.";
  box.classList.remove("hidden");
}

/* ---------- builder wiring ---------- */
function wireBuilder() {
  $("btn-generate").addEventListener("click", () => {
    S.seed = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
    writeLetter();
    $("btn-reroll").disabled = false;
  });
  $("btn-reroll").addEventListener("click", () => {
    const cur = $("letter").value;
    if (cur && cur !== S.lastGenerated &&
        !confirm("You've edited the draft. Rewording regenerates it and loses your edits. Continue?")) return;
    S.seed = (S.seed + 1) >>> 0;
    writeLetter();
  });
  $("btn-pickforme").addEventListener("click", () => {
    const boxes = [...$("points-list").querySelectorAll("input")];
    boxes.forEach(b => { b.checked = false; });
    const rnd = mulberry32((crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0);
    const core = pick(rnd, ["three-exits", "not-forever", "plain-summary"]);
    const exclude = new Set([core, core === "three-exits" ? "not-forever" : "three-exits"]);
    const rest = livePoints().map(p => p.id).filter(id => !exclude.has(id));
    const extra = [];
    while (extra.length < 2 && rest.length) extra.push(rest.splice(Math.floor(rnd() * rest.length), 1)[0]);
    for (const b of boxes) if (b.value === core || extra.includes(b.value)) b.checked = true;
  });
  $("letter").addEventListener("input", debounce(() => { runSlopCheck(); updateLenLine(); }, 400));
  $("btn-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("letter").value);
    flash($("btn-copy"), "Copied");
  });
  $("btn-txt").addEventListener("click", () => {
    download("AB1921-letter.txt", $("letter").value, "text/plain");
  });
  const relayBtn = $("btn-relay");
  if (relayBtn) relayBtn.addEventListener("click", async () => {
    const btn = $("btn-relay"), st = $("relay-status");
    const letter = $("letter").value;
    if (!letter.trim()) { flash(btn, "Generate first"); return; }
    btn.disabled = true;
    st.textContent = "Sending...";
    try {
      const r = await fetch("api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: $("f-name").value.trim(),
          city: $("f-city").value.trim(),
          state: $("f-state").value.trim(),
          email: $("f-email").value.trim(),
          subject: subjectLine(),
          letter
        })
      });
      const d = await r.json();
      if (!d.ok) { st.textContent = d.error || "The relay refused it."; btn.disabled = false; return; }
      st.textContent = "Delivered to the committee inbox. The CC in your email is your receipt.";
      flash(btn, "Sent");
      setTimeout(() => { btn.disabled = false; }, 60_000); // matches the relay's one-per-minute gap
    } catch {
      st.textContent = "Relay unreachable. The buttons below send the same letter from your own mail app.";
      btn.disabled = false;
    }
  });
  $("btn-mail").addEventListener("click", async () => {
    const r = currentRecipient();
    const body = $("letter").value;
    if (!body.trim()) { flash($("btn-mail"), "Generate first"); return; }
    if (r.email) {
      if (body.length > 1900) {
        alert("This letter is long for a mailto link and some mail apps cut it off. It's on your clipboard too; paste if the body arrives truncated.");
        await navigator.clipboard.writeText(body).catch(() => {});
      }
      location.href = "mailto:" + r.email +
        "?subject=" + encodeURIComponent(subjectLine()) +
        "&body=" + encodeURIComponent(body);
    } else {
      await navigator.clipboard.writeText(body).catch(() => {});
      window.open(r.link, "_blank", "noopener");
      flash($("btn-mail"), "Copied + opened form");
    }
  });
  $("btn-example").addEventListener("click", () => {
    $("f-story").value = exampleStory();
    const note = $("example-note");
    note.textContent = "An example built from a real shutdown. Swap in your own game and what it actually cost you; an office can tell a borrowed story from a lived one. Click again for a different one.";
    note.classList.remove("hidden");
  });
  $("btn-ics-all").addEventListener("click", downloadIcs);
}

function writeLetter() {
  const text = buildLetter();
  $("letter").value = text;
  S.lastGenerated = text;
  runSlopCheck();
  updateLenLine();
}
function updateLenLine() {
  const n = $("letter").value.length;
  const words = $("letter").value.split(/\s+/).filter(Boolean).length;
  $("len-line").textContent = n ? words + " words. Under 300 is the sweet spot." : "";
}
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1400);
}
function download(name, text, mime) {
  const a = h("a", {
    href: URL.createObjectURL(new Blob([text], { type: mime })),
    download: name
  });
  document.body.append(a); a.click(); a.remove();
}

/* ---------- calendar ---------- */
function icsEscape(s) { return s.replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n"); }
function vevent(uid, dateIso, summary, description, location) {
  return [
    "BEGIN:VEVENT",
    "UID:" + uid + "@savestate",
    "DTSTAMP:" + icsDate(S.bill.synced_at.slice(0, 10)) + "T000000Z",
    "DTSTART;VALUE=DATE:" + icsDate(dateIso),
    "DTEND;VALUE=DATE:" + icsDayAfter(dateIso),
    "SUMMARY:" + icsEscape(summary),
    "DESCRIPTION:" + icsEscape(description),
    location ? "LOCATION:" + icsEscape(location) : null,
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(summary), "TRIGGER:-PT12H", "END:VALARM",
    "END:VEVENT"
  ].filter(Boolean).join("\r\n");
}
function downloadIcs() {
  const b = S.bill, c = b.committee || {};
  const ev = [];
  if (c.letter_deadline) ev.push(vevent("ab1921-letters", c.letter_deadline,
    "AB 1921: last day for position letters",
    "Paste your letter at " + b.links.portal + " marked SUPPORT, and email " + S.targets.committee.email));
  if (c.call_day) ev.push(vevent("ab1921-calls", c.call_day,
    "AB 1921: call the committee offices",
    "Script and all ten numbers: see the calls section of the site. Committee line: " + S.targets.committee.phone));
  if (c.hearing_date) ev.push(vevent("ab1921-hearing", c.hearing_date,
    "AB 1921 hearing: Senate Privacy, Digital Technologies, and Consumer Protection",
    "Public comment is open to anyone present. Agenda: " + b.links.agenda,
    S.targets.places.hearing.address));
  if (!ev.length) { flash($("btn-ics-all"), "No dates yet"); return; }
  const cal = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SAVESTATE//AB1921//EN", "CALSCALE:GREGORIAN",
    ...ev, "END:VCALENDAR"].join("\r\n");
  download("AB1921-reminders.ics", cal, "text/calendar");
}

/* ---------- geolocation, entirely on-device ---------- */
function wireGeo() {
  $("geo-ca").addEventListener("click", () => setGeoMode("ca", null, "manual"));
  $("geo-out").addEventListener("click", () => setGeoMode("out", null, "manual"));
  $("geo-district").addEventListener("change", e => {
    const v = e.target.value;
    if (v) setGeoMode("ca", Number(v), "manual");
  });
  $("geo-btn").addEventListener("click", () => {
    const btn = $("geo-btn");
    btn.disabled = true; btn.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      S.geo.coords = [lon, lat];
      try {
        const [ca, districts] = await Promise.all([
          loadJSON("data/ca-boundary.geojson"),
          loadJSON("data/districts.geojson")
        ]);
        if (pointInGeom([lon, lat], ca.geometry)) {
          let found = null;
          for (const f of districts.features) {
            if (pointInGeom([lon, lat], f.geometry)) { found = f.properties.d; break; }
          }
          setGeoMode("ca", found, "gps");
        } else {
          setGeoMode("out", null, "gps");
        }
      } catch (e) {
        geoResultText("Couldn't load the bundled maps. Pick an option manually.", false);
      }
      btn.disabled = false; btn.textContent = "Use my location";
    }, () => {
      geoResultText("Your browser didn't share a location. That's fine; pick an option manually.", false);
      const btn2 = $("geo-btn");
      btn2.disabled = false; btn2.textContent = "Use my location";
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
  });
}

function fillDistrictSelect() {
  const sel = $("geo-district");
  for (let i = 1; i <= 40; i++) sel.append(h("option", { value: i }, "SD-" + String(i).padStart(2, "0")));
}

function setGeoMode(mode, district, source) {
  S.geo.mode = mode;
  S.geo.district = district;
  $("geo-ca").classList.toggle("active", mode === "ca");
  $("geo-out").classList.toggle("active", mode === "out");
  if (district) $("geo-district").value = String(district);

  const box = $("geo-result");
  box.textContent = "";
  box.classList.remove("hidden", "constituent");

  let distLine = "";
  if (S.geo.coords) {
    const mi = haversineMiles(S.geo.coords, [S.targets.places.hearing.lon, S.targets.places.hearing.lat]);
    distLine = " You're about " + Math.round(mi) + " miles from the hearing room.";
  }

  if (mode === "ca" && district && memberByDistrict(district)) {
    const m = memberByDistrict(district);
    box.classList.add("constituent");
    box.append(h("p", null,
      h("strong", null, "Senate District " + district + ". Your senator, " + m.name + ", sits on the committee that votes on this bill."),
      " Constituent mail and calls are the heaviest input a member's office gets, and your letter now says you're a constituent.", distLine));
    box.append(h("p", null, "Office: " + m.phone + " · ",
      h("a", { href: sdSite(district) + "/contact", rel: "noopener noreferrer" }, "contact form"), " · ",
      h("a", { href: sdSite(district), rel: "noopener noreferrer" }, "district site")));
  } else if (mode === "ca" && district) {
    box.append(h("p", null,
      h("strong", null, "Senate District " + district + "."),
      " Your senator isn't one of the nine on this committee, but they vote when the bill reaches the floor, and the committee still counts your letter in the record.", distLine));
    box.append(h("p", null, "Your senator's office: " + sdPhone(district) + " · ",
      h("a", { href: sdSite(district) + "/contact", rel: "noopener noreferrer" }, "contact form"), " · ",
      h("a", { href: S.targets.lookup.rep, rel: "noopener noreferrer" }, "confirm with the official lookup")));
  } else if (mode === "ca") {
    box.append(h("p", null,
      h("strong", null, "California."),
      " Find your Senate district with the ", h("a", { href: S.targets.lookup.rep, rel: "noopener noreferrer" }, "official lookup"),
      " or pick it in the dropdown, and this page will tell you if your senator is one of the nine.", distLine));
  } else {
    box.append(h("p", null,
      h("strong", null, "Outside California."),
      " Your letter still counts in the official tally; it just isn't constituent mail. The portal and the committee inbox are your channels, and the cheat sheet travels well if you know a Californian.", distLine));
  }
  if (source === "gps") {
    box.append(h("p", { class: "fine" }, "Determined on your device against bundled maps. Nothing was transmitted."));
  }
  renderRecipients();
  renderCalls();
  if (!$("coverage").classList.contains("hidden")) {
    $("build-note").textContent = "Location changed. Hit Build my letters again to refresh your senator.";
  }
}

function geoResultText(msg, ok) {
  const box = $("geo-result");
  box.textContent = "";
  box.classList.remove("hidden", "constituent");
  box.append(h("p", null, msg));
}

/* even-odd ray casting across every ring of every polygon */
function pointInGeom(pt, geom) {
  const polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
  const [x, y] = pt;
  let inside = false;
  for (const poly of polys) for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[j];
      if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
    }
  }
  return inside;
}
function haversineMiles(a, b) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* ---------- calls ---------- */
function renderCalls() {
  const b = S.bill, t = S.targets;
  const name = "my name is [your name], and I'm calling from [your city]";
  $("call-script").textContent =
    "“Hi, " + name + ". I'm asking the Senator to vote aye on AB 1921, the Protect Our Games Act" +
    (b.committee && b.committee.hearing_date ? ", at the " + dshort(b.committee.hearing_date) + " hearing" : "") +
    ". Thank you.”";
  const list = $("calls-list");
  list.textContent = "";
  list.append(h("div", { class: "call-row" },
    h("span", null, "Committee office (staff)"), h("span", { class: "num" }, t.committee.phone)));
  for (const m of t.members) {
    const mine = S.geo.district && m.district === Number(S.geo.district);
    list.append(h("div", { class: "call-row" },
      h("span", null, "Sen. " + m.name + " (" + m.role + ", " + m.party + "-" + String(m.district).padStart(2, "0") + ")" + (mine ? " ← yours" : "")),
      h("span", { class: "num" }, m.phone)));
  }
  if (S.geo.district && !memberByDistrict(S.geo.district)) {
    list.append(h("div", { class: "call-row" },
      h("span", null, "Your senator (SD-" + String(S.geo.district).padStart(2, "0") + ")"),
      h("span", { class: "num" }, sdPhone(S.geo.district))));
  }
}

/* ---------- showing up ---------- */
function mapsLinks(place) {
  const q = encodeURIComponent(place.address);
  const wrap = h("div", { class: "maplinks" },
    h("a", { href: "https://www.google.com/maps/dir/?api=1&destination=" + q, rel: "noopener noreferrer", target: "_blank" }, "Google Maps"),
    h("a", { href: "https://maps.apple.com/?daddr=" + q, rel: "noopener noreferrer", target: "_blank" }, "Apple Maps"),
    h("a", { href: "https://www.openstreetmap.org/directions?to=" + place.lat + "%2C" + place.lon, rel: "noopener noreferrer", target: "_blank" }, "OSM directions"));
  const embedBtn = h("button", { type: "button" }, "Show map");
  const slot = h("div", { class: "map-embed" });
  embedBtn.addEventListener("click", () => {
    const d = 0.011;
    const bbox = [place.lon - d, place.lat - d * 0.7, place.lon + d, place.lat + d * 0.7].join("%2C");
    slot.textContent = "";
    slot.append(h("iframe", {
      src: "https://www.openstreetmap.org/export/embed.html?bbox=" + bbox + "&layer=mapnik&marker=" + place.lat + "%2C" + place.lon,
      title: "Map: " + place.label, loading: "lazy",
      referrerpolicy: "no-referrer", sandbox: "allow-scripts allow-same-origin"
    }));
    slot.append(h("p", { class: "fine" }, "Map tiles load from openstreetmap.org once you click, which is why the map is click-to-load."));
    embedBtn.remove();
  });
  wrap.append(embedBtn);
  return [wrap, slot];
}

function renderVisit() {
  const b = S.bill, t = S.targets;
  $("showup-intro").textContent = (b.committee && b.committee.hearing_date)
    ? "The committee meets " + dlong(b.committee.hearing_date) + " at " + t.places.hearing.address +
      ". Hearings are public. After the witnesses, the chair asks who else supports the bill: you walk to the microphone and give your name, your city, and one sentence. That moment goes in the record."
    : "No hearing is currently scheduled. The cards below stay useful for office visits.";
  const cards = $("visit-cards");
  cards.textContent = "";
  for (const key of ["hearing", "committee_office", "capitol_offices"]) {
    const p = t.places[key];
    const card = h("div", { class: "visit-card" },
      h("h3", null, p.label),
      h("p", { class: "addr" }, p.address),
      h("p", { class: "note" }, p.note));
    const [links, slot] = mapsLinks(p);
    card.append(links, slot);
    cards.append(card);
  }
  $("btn-print-visit").addEventListener("click", printVisitSheet);
}

function printVisitSheet() {
  const b = S.bill, t = S.targets;
  const sheet = $("visit-sheet");
  sheet.textContent = "";
  sheet.append(
    h("h1", null, "AB 1921 hearing day sheet"),
    h("p", null, (b.committee.hearing_date ? dlong(b.committee.hearing_date) + " · " : "") +
      t.places.hearing.address + " · check the room on the agenda: " + b.links.agenda),
    h("h2", null, "Getting in"),
    h("ul", null,
      h("li", null, "Arrive 30 to 45 minutes early; building security is airport-style."),
      h("li", null, "Find the hearing room on the posted agenda or ask at the information desk."),
      h("li", null, "AB 1921 may not be first on the agenda. Bring something to read.")),
    h("h2", null, "At the public comment microphone"),
    h("p", null, "“My name is ______________, from ______________. I support AB 1921. [One sentence if you want: name the game you lost.] Thank you.”"),
    h("h2", null, "Phone numbers"),
    h("ul", null,
      h("li", null, "Committee office: " + t.committee.phone),
      ...t.members.map(m => h("li", null, "Sen. " + m.name + " (" + m.role + "): " + m.phone + " · " + m.suite + ", 1021 O Street"))),
    h("h2", null, "Checklist"),
    h("ul", null,
      h("li", null, "☐ Printed copy of my letter (drop one at the committee office, " + t.places.committee_office.address + ")"),
      h("li", null, "☐ ID for building entry"),
      h("li", null, "☐ Phone silenced before entering the room"),
      h("li", null, "☐ One sentence ready for the microphone")),
    h("p", { class: "sheet-foot" }, "savestate · letters and numbers generated " + new Date().toLocaleDateString() + " · verify the hearing on the agenda page before traveling")
  );
  document.body.classList.add("print-visit");
  window.print();
  setTimeout(() => document.body.classList.remove("print-visit"), 500);
}

/* ---------- misc ---------- */
function wireMisc() {
  $("committee-email").textContent = S.targets.committee.email;
  $("portal-link").href = S.targets.portal.url;
  $("wiki-link").href = S.points.wiki.url;
  $("foot-wiki").href = S.points.wiki.url;
  $("foot-status").href = S.bill.links.status;
  $("text-link").href = S.bill.links.text;
  stampAiNote();
}

// AI disclosure: name the model and stamp each publish. Prefer the CI build
// time (data/build.json, written at deploy); fall back to the data sync time.
function stampAiNote() {
  const el = $("ai-note");
  if (!el) return;
  const set = t => { el.textContent = "Yes, AI was used to build this site. Specifically Claude Code (Fable 5), with the no-ai-slop skill. Last published " + t + "."; };
  fetch("build.json").then(r => r.ok ? r.json() : null).then(b => {
    set(new Date((b && b.built_at) ? b.built_at : S.bill.synced_at).toLocaleString());
  }).catch(() => set(new Date(S.bill.synced_at).toLocaleString()));
}
