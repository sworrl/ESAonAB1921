/* SAVESTATE delivery relay. One job: take a reviewed letter from the page,
   submit it once, forget it. Node stdlib only, no dependencies.

   Delivery: if RELAY_SMTP_HOST is set, the relay logs in to that mail service
   (Gmail app password, Resend, Brevo, SendGrid, ...) and submits over TLS, so
   the service signs the mail and it passes SPF/DKIM. Otherwise it hands off to
   a local Postfix on loopback. Either way the From is the service mailbox and
   the constituent's address is only Reply-To/CC, so no address is ever forged.

   Retention model: the message exists in process memory for the lifetime of
   one request. Nothing is written to disk and no content is ever logged. The
   only state kept in memory is rate-limit counters and content hashes for
   duplicate suppression, both of which expire and neither of which can
   reconstruct a letter. */

import { createServer } from "node:http";
import { createConnection } from "node:net";
import tls from "node:tls";
import { createHash } from "node:crypto";

const PORT = 8125;
const HOST = "127.0.0.1";
const TO = process.env.RELAY_TO || "SPDTCP.Committee@sen.ca.gov";
// Hard allowlist of deliverable recipients. The relay will NEVER send anywhere
// off this list, so it cannot be turned into a general mailer no matter what
// the page posts. Today the only emailable office is the committee inbox; every
// other official takes letters through their own web form, which a human
// submits. Add a verified official address here before the page can target it.
const ALLOWED = new Set((process.env.RELAY_ALLOWED || TO).split(",").map(s => s.trim()).filter(Boolean));
// Generic, identity-free defaults. The deployer sets RELAY_FROM to a mailbox
// on the mail service they send through; example.org is RFC 2606 reserved, so
// out of the box this impersonates nobody. The letter is the sender's: their
// name signs it and their address is Reply-To/CC. SITE is optional and only
// adds a "via <host>" line if a deployer wants attribution.
const FROM_ADDR = process.env.RELAY_FROM || "letters@example.org";
const SITE = process.env.RELAY_SITE || "";
// Outbound mail service. Point RELAY_SMTP_HOST/USER/PASS at a free provider's
// SMTP submission (e.g. smtp.gmail.com with an app password) and the relay
// authenticates and sends through it. Leave RELAY_SMTP_HOST empty to fall back
// to a local Postfix on loopback. Port defaults to 587 (STARTTLS) for a remote
// host and 25 for loopback; use 465 for implicit TLS.
const SMTP_HOST = process.env.RELAY_SMTP_HOST || "";
const SMTP_PORT = Number(process.env.RELAY_SMTP_PORT || (SMTP_HOST ? 587 : 25));
const SMTP_USER = process.env.RELAY_SMTP_USER || "";
const SMTP_PASS = process.env.RELAY_SMTP_PASS || "";
const SMTP_SECURE = (process.env.RELAY_SMTP_SECURE || (SMTP_PORT === 465 ? "tls" : SMTP_HOST ? "starttls" : "none")).toLowerCase();
const SMTP_HELO = process.env.RELAY_HELO || FROM_ADDR.split("@")[1] || "localhost";
const SMTP_INSECURE = process.env.RELAY_SMTP_INSECURE === "1"; // skip TLS cert validation (testing only)
const SMTP_SNI = /[a-zA-Z]/.test(SMTP_HOST) ? SMTP_HOST : undefined; // SNI must be a hostname, never an IP
const MAX_PER_HOUR = 3;        // per source IP
const MIN_GAP_MS = 60_000;     // per source IP
const LETTER_MAX = 6000;
const FIELD_MAX = 120;

const ipState = new Map();     // ip -> { count, windowStart, last }
const seen = new Map();        // letterHash -> expiry

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of seen) if (v < now) seen.delete(k);
  for (const [k, v] of ipState) if (now - v.windowStart > 3_600_000) ipState.delete(k);
}, 300_000).unref();

const headerSafe = s => String(s || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, FIELD_MAX);
const asciiOnly = s => headerSafe(s).replace(/[^\x20-\x7e]/g, "");
// printable ASCII only, no characters that mean anything in an SMTP envelope or address header
const EMAIL_RE = /^[\x21-\x7e]{1,64}@[\x21-\x7e]{1,255}\.[a-zA-Z]{2,24}$/;
const EMAIL_BAD = /[<>(),;:"'\\\[\]@\s]/;
const emailOk = e => EMAIL_RE.test(e) && !EMAIL_BAD.test(e.replace("@", ""));

function clientIp(req) {
  return headerSafe(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function allow(ip) {
  const now = Date.now();
  const st = ipState.get(ip) || { count: 0, windowStart: now, last: 0 };
  if (now - st.windowStart > 3_600_000) { st.count = 0; st.windowStart = now; }
  if (now - st.last < MIN_GAP_MS) return "Slow down: one send per minute.";
  if (st.count >= MAX_PER_HOUR) return "Limit reached: three sends per hour. The committee inbox doesn't need more copies than that.";
  st.count += 1; st.last = now;
  ipState.set(ip, st);
  return null;
}

// normalize to CRLF (servers reject bare LF as smuggling), then dot-stuff
const prepBody = raw => raw.replace(/\r\n/g, "\n").split("\n").map(l => (l.startsWith(".") ? "." + l : l)).join("\r\n");

// Minimal SMTP response reader: buffers lines and completes a response on a
// "NNN " line (a space after the code), folding multiline "NNN-" replies.
function smtpEngine(sock) {
  let buf = "", lines = [];
  const queue = [], waiters = [];
  const emit = resp => { const w = waiters.shift(); if (w) w.resolve(resp); else queue.push(resp); };
  const failAll = e => { while (waiters.length) waiters.shift().reject(e); };
  sock.setEncoding("utf8");
  sock.on("data", chunk => {
    buf += chunk; let nl;
    while ((nl = buf.indexOf("\r\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2); lines.push(line);
      if (/^\d{3} /.test(line)) { emit({ code: +line.slice(0, 3), text: lines.join(" ") }); lines = []; }
    }
  });
  sock.on("error", failAll);
  sock.on("close", () => failAll(new Error("smtp connection closed")));
  return {
    read: () => new Promise((resolve, reject) => { const q = queue.shift(); q ? resolve(q) : waiters.push({ resolve, reject }); }),
    write: s => sock.write(s)
  };
}

// Authenticated submission through a real mail service. The service signs the
// message, so it passes SPF/DKIM and reaches inboxes; From is the service
// mailbox and the constituent is only Reply-To/CC, so nothing is forged.
async function sendAuthSmtp(raw, recipients) {
  const body = prepBody(raw);
  let sock = SMTP_SECURE === "tls"
    ? tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_SNI, rejectUnauthorized: !SMTP_INSECURE })
    : createConnection({ host: SMTP_HOST, port: SMTP_PORT });
  await new Promise((res, rej) => { sock.once(SMTP_SECURE === "tls" ? "secureConnect" : "connect", res); sock.once("error", rej); });
  let eng = smtpEngine(sock);
  const step = async (cmd, ok) => {
    if (cmd != null) eng.write(cmd + "\r\n");
    const r = await eng.read();
    if (!(Array.isArray(ok) ? ok : [ok]).includes(r.code)) throw new Error("smtp " + r.code + ": " + r.text.slice(0, 100));
    return r;
  };
  try {
    sock.setTimeout(25_000, () => sock.destroy(new Error("smtp timeout")));
    await step(null, 220);                       // greeting
    await step("EHLO " + SMTP_HELO, 250);
    if (SMTP_SECURE === "starttls") {
      await step("STARTTLS", 220);
      sock = tls.connect({ socket: sock, servername: SMTP_SNI, rejectUnauthorized: !SMTP_INSECURE });
      await new Promise((res, rej) => { sock.once("secureConnect", res); sock.once("error", rej); });
      sock.setTimeout(25_000, () => sock.destroy(new Error("smtp timeout")));
      eng = smtpEngine(sock);
      await step("EHLO " + SMTP_HELO, 250);       // re-introduce over the TLS channel
    }
    if (SMTP_USER) {
      await step("AUTH LOGIN", 334);
      await step(Buffer.from(SMTP_USER).toString("base64"), 334);
      await step(Buffer.from(SMTP_PASS).toString("base64"), 235);
    }
    await step("MAIL FROM:<" + FROM_ADDR + ">", 250);
    for (const r of recipients) await step("RCPT TO:<" + r + ">", [250, 251]);
    await step("DATA", 354);
    await step(body + "\r\n.", 250);              // body terminated by CRLF.CRLF
    eng.write("QUIT\r\n");
  } finally {
    sock.end();
  }
}

// Fallback: hand off to a local Postfix on loopback (no auth, plain), used when
// RELAY_SMTP_HOST is unset. Resolves on the 250 after DATA.
function smtpSubmit(raw, rcpts) {
  return new Promise((resolve, reject) => {
    const payload = prepBody(raw);
    const dialogue = [
      ["220", "HELO " + SMTP_HELO + "\r\n"],
      ["250", "MAIL FROM:<" + FROM_ADDR + ">\r\n"],
      ...rcpts.map(r => ["250", "RCPT TO:<" + r + ">\r\n"]),
      ["250", "DATA\r\n"],
      ["354", payload + "\r\n.\r\n"],
      ["250", "QUIT\r\n"]
    ];
    let i = 0, buf = "";
    const sock = createConnection({ host: "127.0.0.1", port: SMTP_PORT });
    const fail = msg => { sock.destroy(); reject(new Error(msg)); };
    sock.setTimeout(20_000, () => fail("smtp timeout at step " + i));
    sock.on("error", e => fail("smtp " + e.message));
    sock.on("data", chunk => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (line.length >= 4 && line[3] === "-") continue; // multiline reply, wait for the last
        if (i >= dialogue.length) return;
        const [want, send] = dialogue[i];
        if (!line.startsWith(want)) return fail("smtp step " + i + " got: " + line.slice(0, 80));
        i += 1;
        if (i === dialogue.length) { sock.end(send); resolve(); return; }
        sock.write(send);
      }
    });
  });
}

// Pick the path: authenticated service if configured, else loopback Postfix.
function deliver(raw, recipients) {
  return SMTP_HOST ? sendAuthSmtp(raw, recipients) : smtpSubmit(raw, recipients);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health") return json(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/api/send") return json(res, 404, { ok: false, error: "not found" });

  let buf = "";
  req.setEncoding("utf8");
  req.on("data", c => { buf += c; if (buf.length > LETTER_MAX + 2000) { req.destroy(); } });
  req.on("end", async () => {
    let d;
    try { d = JSON.parse(buf); } catch { return json(res, 400, { ok: false, error: "bad json" }); }

    const name = headerSafe(d.name);
    const city = headerSafe(d.city);
    const state = headerSafe(d.state);
    const email = headerSafe(d.email);
    const subject = asciiOnly(d.subject) || "Support for AB 1921";
    const letter = String(d.letter || "").replace(/\r\n/g, "\n").trim();
    const target = d.recipient ? headerSafe(d.recipient) : TO;

    if (!ALLOWED.has(target)) return json(res, 400, { ok: false, error: "That recipient is not a verified official address. This relay only delivers to offices it is configured for." });
    if (name.length < 2) return json(res, 400, { ok: false, error: "Your name is required: anonymous mail to a legislative office is worthless, and we won't relay it." });
    if (!emailOk(email)) return json(res, 400, { ok: false, error: "A working reply address is required so the office can verify a real person sent this. We don't keep it." });
    if (letter.length < 80) return json(res, 400, { ok: false, error: "That letter is too short to be worth a staffer's time. Generate or write a real one." });
    if (letter.length > LETTER_MAX) return json(res, 400, { ok: false, error: "Letter too long: keep it under " + LETTER_MAX + " characters." });

    const ip = clientIp(req);
    const limited = allow(ip);
    if (limited) return json(res, 429, { ok: false, error: limited });

    const hash = createHash("sha256").update(letter).digest("hex");
    if (seen.has(hash)) return json(res, 409, { ok: false, error: "This exact letter was already sent. Hit Reword so yours reads as yours." });
    seen.set(hash, Date.now() + 3_600_000);

    const fromName = (name + (city ? " in " + city : "")).replace(/"/g, "'");
    const raw = [
      `From: "${fromName} (via SAVESTATE)" <${FROM_ADDR}>`,
      `Reply-To: "${name.replace(/"/g, "'")}" <${email}>`,
      `To: ${target}`,
      `Cc: ${email}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      letter,
      "",
      "--",
      `Sent by ${name}${city ? ", " + city : ""}${state ? ", " + state : ""} <${email}> after personal review${SITE ? ", via " + SITE : ""}.`,
      `This relay keeps no copy and no logs. Reply goes to the sender, not the site.`
    ].join("\r\n");

    try {
      await deliver(raw, [target, email]);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 502, { ok: false, error: "Local mailer refused the message. Try the email-app button instead." });
      console.error("relay: submit failure:", e.message); /* no content, ever */
    }
  });
});

server.listen(PORT, HOST, () => console.error(
  `relay: listening on ${HOST}:${PORT}, delivering to ${TO} via ` +
  (SMTP_HOST ? `${SMTP_HOST}:${SMTP_PORT} (${SMTP_SECURE})` : "loopback postfix")));
