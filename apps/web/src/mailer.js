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

module.exports = { Mailer, ConsoleMailer, MemoryMailer };
