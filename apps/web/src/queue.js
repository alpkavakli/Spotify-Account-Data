"use strict";

// The job queue, behind a small interface.
//
// pg-boss keeps jobs in Postgres, so there is no Redis to run, back up or lose —
// the decision in docs/01-DECISIONS.md. It is wrapped rather than used directly
// so the API can enqueue work without importing a queue library, and so tests
// can run the jobs synchronously with no queue at all (see NullQueue).

const QUEUE_PARSE_UPLOAD = "parse-upload";
const QUEUE_FETCH_LYRICS = "fetch-lyrics";

/** What the API is allowed to do with the queue: put work on it. */
class Queue {
  async enqueueParseUpload(uploadId) { throw new Error("Queue.enqueueParseUpload not implemented"); }
  async enqueueFetchLyrics() { throw new Error("Queue.enqueueFetchLyrics not implemented"); }
}

class PgBossQueue extends Queue {
  /** @param {import("pg-boss").PgBoss} boss */
  constructor(boss) {
    super();
    this.boss = boss;
  }

  async enqueueParseUpload(uploadId) {
    return this.boss.send(QUEUE_PARSE_UPLOAD, { uploadId });
  }

  async enqueueFetchLyrics() {
    // singletonKey collapses concurrent requests into one queued job: a hundred
    // uploads finishing at once should trigger one sweep, not a hundred.
    return this.boss.send(
      QUEUE_FETCH_LYRICS,
      {},
      { singletonKey: QUEUE_FETCH_LYRICS, singletonHours: 1 }
    );
  }
}

/**
 * Records what would have been enqueued, and runs nothing.
 *
 * Used by the API tests: they care that the route queued the work, not that a
 * worker picked it up — the jobs have their own tests that call them directly.
 */
class NullQueue extends Queue {
  constructor() {
    super();
    this.parseUploads = [];
    this.lyricSweeps = 0;
  }

  async enqueueParseUpload(uploadId) {
    this.parseUploads.push(uploadId);
  }

  async enqueueFetchLyrics() {
    this.lyricSweeps++;
  }
}

module.exports = { Queue, PgBossQueue, NullQueue, QUEUE_PARSE_UPLOAD, QUEUE_FETCH_LYRICS };
