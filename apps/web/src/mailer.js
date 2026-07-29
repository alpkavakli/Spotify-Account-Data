"use strict";

// Sending email.
//
// An interface plus a console implementation, for the same reason the storage
// and blob layers are interfaces: the API should not know or care whether a
// message goes to SMTP, to a transactional-email API, or to stdout. Tests hand
// in a recorder and assert on what would have been sent.
//
// Passwordless login is the only mail the service sends in Phase 1, and it is
// load-bearing: if it does not arrive, nobody can log in.

const nodemailer = require("nodemailer");

class Mailer {
  /** @param {{to: string, subject: string, text: string}} message */
  async send(message) { throw new Error("Mailer.send not implemented"); }
}

/**
 * Prints the message instead of sending it.
 *
 * The development default, and deliberately useful rather than a stub: the login
 * link is printed in full so you can click it out of the terminal without an
 * SMTP server. It refuses to be used in production, because a login system that
 * silently sends mail to a log file is worse than one that fails to start.
 */
class ConsoleMailer extends Mailer {
  constructor({ log = console.log } = {}) {
    super();
    this.log = log;
  }

  async send({ to, subject, text }) {
    this.log(
      `\n──── email (not actually sent) ────\n` +
        `to:      ${to}\n` +
        `subject: ${subject}\n\n${text}\n` +
        `───────────────────────────────────\n`
    );
  }
}

/** Collects messages in memory. Used by the tests. */
class MemoryMailer extends Mailer {
  constructor() {
    super();
    this.sent = [];
  }

  async send(message) {
    this.sent.push(message);
  }

  /** The most recent message sent to an address, or undefined. */
  lastTo(email) {
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase());
  }
}

/**
 * Sends over SMTP.
 *
 * SMTP rather than one provider's HTTP API because it is the one interface every
 * transactional-email service speaks: Resend, Postmark, SES, Fastmail and a box
 * in a cupboard are all a host, a port and a credential. Changing provider is
 * then an edit to `.env`, not a new class — which matters for the one message
 * the service cannot function without.
 */
class SmtpMailer extends Mailer {
  /**
   * @param {object} options
   * @param {string} options.from        the `From:` header — `Name <addr@domain>`
   * @param {string} [options.url]       `smtp://user:pass@host:587`, or `smtps://` for implicit TLS
   * @param {object} [options.transport] a pre-built nodemailer transport, or the
   *   options to build one from. Tests pass `{jsonTransport: true}`; the env
   *   builder passes discrete host/port/auth so a password containing `@` or `/`
   *   does not have to survive being parsed as a URL.
   */
  constructor({ from, url, transport } = {}) {
    super();
    if (!from) throw new Error("SmtpMailer needs a `from` address");
    if (!url && !transport) throw new Error("SmtpMailer needs `url` or `transport`");
    this.from = from;
    this.transport = nodemailer.createTransport(transport || url);
  }

  async send({ to, subject, text }) {
    await this.transport.sendMail({ from: this.from, to, subject, text });
  }

  /**
   * Asks the server whether it will talk to us.
   *
   * Called at boot: an SMTP credential that is wrong is invisible until the
   * first person tries to log in, and by then the failure is theirs, not ours.
   */
  async verify() {
    await this.transport.verify();
  }
}

/**
 * Build the mailer the environment describes.
 *
 * Lives here rather than in `server.js` so the rule below is testable, because
 * it is a security rule and not a configuration detail:
 *
 * **`ConsoleMailer` in production is an authentication hole.** Sign-in links
 * would be written to the container log, where they are readable by anyone with
 * log access and by nobody who is trying to log in. So production without SMTP
 * configured does not degrade — it refuses to start. A service that is down is
 * an incident; a service that mails sign-in links to a log file is a breach.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Mailer}
 */
function mailerFromEnv(env = process.env) {
  const from = env.MAIL_FROM;
  const url = env.SMTP_URL;
  const host = env.SMTP_HOST;

  if (url || host) {
    if (!from) {
      throw new Error("SMTP is configured but MAIL_FROM is not — set the From: address");
    }
    if (url) return new SmtpMailer({ from, url });
    return new SmtpMailer({
      from,
      transport: {
        host,
        // 587 (STARTTLS) is what every provider documents first.
        port: Number(env.SMTP_PORT || 587),
        // `secure` means implicit TLS from the first byte, which is port 465.
        // On 587 the connection starts plain and upgrades, so this is false and
        // nodemailer requires the upgrade anyway.
        secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : Number(env.SMTP_PORT) === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      },
    });
  }

  if (env.NODE_ENV === "production") {
    throw new Error(
      "No mailer is configured. Set SMTP_URL (or SMTP_HOST/SMTP_USER/SMTP_PASSWORD) " +
        "and MAIL_FROM. Refusing to start in production with the console mailer, " +
        "because sign-in links would be printed to the log instead of emailed."
    );
  }

  return new ConsoleMailer();
}

module.exports = { Mailer, ConsoleMailer, MemoryMailer, SmtpMailer, mailerFromEnv };
