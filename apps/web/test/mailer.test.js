"use strict";

// The mailer, and the rule that decides which one production gets.
//
// No Postgres and no network. `SmtpMailer` is exercised through nodemailer's
// jsonTransport, which builds the real MIME message and hands it back instead of
// opening a socket — so these assertions are against what would actually go on
// the wire, not against a hand-written fake that agrees with us by construction.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  Mailer,
  ConsoleMailer,
  MemoryMailer,
  SmtpMailer,
  mailerFromEnv,
} = require("../src/mailer");

/** An SmtpMailer that builds messages but never connects. */
function jsonMailer(from = "Lyric Search <hi@example.com>") {
  return new SmtpMailer({ from, transport: { jsonTransport: true } });
}

/** The message SmtpMailer handed to nodemailer, parsed back out. */
async function sentBy(mailer, message) {
  const info = await mailer.transport.sendMail({ from: mailer.from, ...message });
  return JSON.parse(info.message);
}

test.describe("Mailer (the interface)", () => {
  test.it("refuses to be used directly", async () => {
    await assert.rejects(() => new Mailer().send({}), /not implemented/);
  });
});

test.describe("SmtpMailer", () => {
  test.it("puts the message on the wire with the right envelope", async () => {
    const mailer = jsonMailer();
    const sent = await sentBy(mailer, {
      to: "person@example.com",
      subject: "Your sign-in link",
      text: "Click to sign in:\n\nhttps://example.com/auth/callback?token=abc\n",
    });

    assert.equal(sent.from.address, "hi@example.com");
    assert.equal(sent.from.name, "Lyric Search");
    assert.deepEqual(sent.to.map((t) => t.address), ["person@example.com"]);
    assert.equal(sent.subject, "Your sign-in link");
    assert.match(sent.text, /auth\/callback\?token=abc/);
  });

  test.it("sends the link as plain text, not HTML", async () => {
    // The sign-in mail is one URL. An HTML part would only give a filter more to
    // dislike, and some clients rewrite links in HTML mail.
    const mailer = jsonMailer();
    const sent = await sentBy(mailer, { to: "a@b.com", subject: "s", text: "https://x/y" });
    assert.equal(sent.html, undefined);
  });

  test.it("does not mangle a link containing token characters", async () => {
    // Login tokens are URL-safe base64; a mailer that wrapped or re-encoded the
    // line would produce a link that 400s, and only in production.
    const token = "aB3-_x".repeat(12);
    const link = `https://example.com/auth/callback?token=${token}`;
    const sent = await sentBy(jsonMailer(), { to: "a@b.com", subject: "s", text: link });
    assert.ok(sent.text.includes(link), "the link must survive intact");
  });

  test.it("needs a from address", () => {
    assert.throws(() => new SmtpMailer({ transport: { jsonTransport: true } }), /from/);
  });

  test.it("needs somewhere to send", () => {
    assert.throws(() => new SmtpMailer({ from: "a@b.com" }), /url.*transport/);
  });

  test.it("is a Mailer", () => {
    assert.ok(jsonMailer() instanceof Mailer);
  });
});

test.describe("mailerFromEnv", () => {
  test.it("gives development the console mailer", () => {
    assert.ok(mailerFromEnv({}) instanceof ConsoleMailer);
  });

  test.it("REFUSES to start production without SMTP", () => {
    // The point of the whole function. Console-mailing sign-in links writes them
    // to the log, where the wrong people can read them and the right person
    // cannot. Down beats that.
    assert.throws(
      () => mailerFromEnv({ NODE_ENV: "production" }),
      /No mailer is configured/
    );
  });

  test.it("builds an SmtpMailer from SMTP_URL", () => {
    const mailer = mailerFromEnv({
      SMTP_URL: "smtp://user:pass@smtp.example.com:587",
      MAIL_FROM: "hi@example.com",
    });
    assert.ok(mailer instanceof SmtpMailer);
    assert.equal(mailer.transport.options.host, "smtp.example.com");
    assert.equal(mailer.transport.options.port, 587);
  });

  test.it("builds one from discrete host/port/credentials", () => {
    // The reason this path exists: SES SMTP passwords are base64 and contain
    // `+` and `/`, which do not survive being parsed as part of a URL.
    const mailer = mailerFromEnv({
      SMTP_HOST: "email-smtp.eu-west-1.amazonaws.com",
      SMTP_USER: "AKIAEXAMPLE",
      SMTP_PASSWORD: "BG9v+ar/2xQ==",
      MAIL_FROM: "hi@example.com",
    });
    assert.equal(mailer.transport.options.auth.pass, "BG9v+ar/2xQ==");
    assert.equal(mailer.transport.options.port, 587, "587 by default");
  });

  test.it("infers implicit TLS from port 465", () => {
    const on465 = mailerFromEnv({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      MAIL_FROM: "hi@example.com",
    });
    assert.equal(on465.transport.options.secure, true);

    const on587 = mailerFromEnv({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      MAIL_FROM: "hi@example.com",
    });
    assert.equal(on587.transport.options.secure, false, "587 upgrades with STARTTLS");
  });

  test.it("lets SMTP_SECURE override the inference", () => {
    const mailer = mailerFromEnv({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "2525",
      SMTP_SECURE: "true",
      MAIL_FROM: "hi@example.com",
    });
    assert.equal(mailer.transport.options.secure, true);
  });

  test.it("omits auth entirely when no user is given", () => {
    // An unauthenticated relay on the same private network is a legitimate
    // setup; sending `auth: {user: undefined}` is not the same thing and makes
    // nodemailer attempt AUTH with nothing.
    const mailer = mailerFromEnv({ SMTP_HOST: "localhost", MAIL_FROM: "hi@example.com" });
    assert.equal(mailer.transport.options.auth, undefined);
  });

  test.it("refuses SMTP without a from address", () => {
    // Every provider rejects a message with no From:, so this would configure a
    // mailer that starts fine and fails on the first login attempt.
    assert.throws(
      () => mailerFromEnv({ SMTP_HOST: "smtp.example.com" }),
      /MAIL_FROM/
    );
  });

  test.it("configured SMTP wins in development too", () => {
    // So you can point a staging box at a real provider without pretending to
    // be production.
    const mailer = mailerFromEnv({
      NODE_ENV: "development",
      SMTP_URL: "smtp://smtp.example.com:587",
      MAIL_FROM: "hi@example.com",
    });
    assert.ok(mailer instanceof SmtpMailer);
  });
});

test.describe("ConsoleMailer", () => {
  test.it("prints the link in full so it can be clicked out of the terminal", async () => {
    const lines = [];
    const mailer = new ConsoleMailer({ log: (m) => lines.push(m) });
    await mailer.send({
      to: "person@example.com",
      subject: "Your sign-in link",
      text: "https://example.com/auth/callback?token=abc",
    });
    const printed = lines.join("\n");
    assert.match(printed, /person@example\.com/);
    assert.match(printed, /auth\/callback\?token=abc/);
    assert.match(printed, /not actually sent/, "it must not look like it was delivered");
  });
});

test.describe("MemoryMailer", () => {
  test.it("returns the most recent message to an address", async () => {
    const mailer = new MemoryMailer();
    await mailer.send({ to: "a@b.com", subject: "first", text: "1" });
    await mailer.send({ to: "a@b.com", subject: "second", text: "2" });
    assert.equal(mailer.lastTo("a@b.com").subject, "second");
  });

  test.it("matches addresses case-insensitively", async () => {
    const mailer = new MemoryMailer();
    await mailer.send({ to: "Person@Example.com", subject: "s", text: "t" });
    assert.ok(mailer.lastTo("person@example.com"));
  });

  test.it("returns undefined for an address nothing was sent to", async () => {
    assert.equal(new MemoryMailer().lastTo("nobody@example.com"), undefined);
  });
});
