# 07 — Future features

Ideas designed far enough to be worth writing down, but **not committed to a
phase**. Nothing here blocks Phase 1 or Phase 2. When one of these gets
scheduled it graduates into its own numbered phase doc.

---

## Weekly / monthly lyrical summary — "what your listening was about"

**One line:** at the end of every week and month, tell the user what their
listening was *about* — the recurring themes in the lyrics they actually spent
time on, weighted by minutes played, with the songs that carried each theme.

### The idea in the user's words

> If I play *Without You I'm Nothing* 500 times and *Let It Happen* twice, the
> week's summary should say "you listened to these topics mostly, and these are
> the songs they were mentioned in."

So a song that took 40% of the week's listening minutes should account for
roughly 40% of what the summary says. That is a **weighted arithmetic mean**,
and the weight is time.

### The lyric body is the input. Everything else is bookkeeping

This is the point of the feature and it constrains every other decision below.
The themes are **derived from the full lyric text** — not from titles, not from
genre, not from what a model already knows about a famous song. A design that
quietly stops reading the words has stopped being this feature.

Two consequences that are easy to get wrong:

- **A song embedding alone is not enough.** One vector per song is a lossy
  summary. It is good at "how close are these two songs" and bad at "name the
  topics and say which lines carried them". The pipeline below therefore has a
  stage where a model **reads the lyric body** and emits structured themes, and
  the embedding is a second, supporting signal rather than the whole mechanism.
- **Songs with no lyrics are excluded, never zero-filled.** Instrumentals and
  not-found songs have minutes but no text. They drop out of both sums and the
  summary states its own coverage — the same rule the stats page already follows
  for the 12-month export window.

### Decided

| Question | Answer |
|---|---|
| Windows | Rolling **last 7 days** and **last 30 days** |
| Where the play data comes from | **Live Spotify API** (`recently-played`) |
| Per-song weight | **Minutes played** (`ms_played`) |
| Primary signal | **Themes extracted from the full lyric body**, per song, once, globally |
| Aggregation | Minutes-weighted mean over those per-song themes |
| Prose | An LLM writes the paragraph from the aggregate |
| Genre | A second signal, folded into the text the model reads |

### This has a hard Phase 2 dependency

An uploaded export is history — it arrives days to weeks after the fact, and the
"Account data" package only covers the last 12 months in a single dated dump.
There is no such thing as "this week" in it.

A rolling weekly summary therefore needs **Spotify connect and
`recently-played` polling**, which is Phase 2 and gated on Spotify Extended
Access. Genre is the same story: Spotify exposes genres on the *artist*, via the
API, not in the export.

That is worth stating plainly because it inverts the Phase 1 rule. Everything in
Phase 1 was chosen so that **nothing could be blocked by Spotify's review**
(`docs/05-PHASE-1-SAAS.md`). This feature can be. Build it knowing that.

`recently-played` returns only the last 50 plays and no further back, so weekly
coverage requires **polling on a schedule and storing the plays ourselves** — a
new per-user, append-only play-events table, not a recomputation of anything the
export gives us.

---

### Stage 1 — read each lyric body. Once, globally

The same insight the lyric catalogue already runs on (`docs/05` step 6): a song's
lyrics are identical for everybody, so anything derived from them is too. Analyse
once, every user benefits, and cost stays flat as the user base grows. This is
the expensive stage and it is **per song, not per user** — it does not scale with
traffic.

The model receives the full lyric body, with the artist's genres prefixed so that
the same words in a sludge-metal track and a bossa-nova track are not read the
same way:

```
[genres: shoegaze, dream pop]
<full lyric body>
```

and returns two things, both stored on the song:

**1a. Structured themes.** A small JSON document — themes with confidences,
plus the concrete imagery that produced them:

```json
{
  "themes": [
    {"label": "self-erasure",  "confidence": 0.91},
    {"label": "codependency",  "confidence": 0.84},
    {"label": "religious imagery", "confidence": 0.42}
  ],
  "mood": "resigned",
  "narrative_stance": "first-person, addressing an absent other"
}
```

This is what makes the summary concrete and quotable, and it is the half that
answers *"in these songs these topics were mentioned"*. A confidence per theme —
not a bare list — is what lets the aggregation below be a real weighted mean
rather than a vote count.

**1b. An embedding of the same text.** A vector, for the arithmetic that a
discrete theme list cannot do: which songs this week were most alike, which song
sits nearest the week's centre, and scoring open-vocabulary themes that are not
in the fixed list.

### Stage 2 — the weighted mean over the window

**Themes (the primary answer).** For each theme, sum every song's confidence
weighted by the minutes spent on it:

```
score(theme) = Σ(minutes_i × confidence_i(theme)) / Σ(minutes_i)
```

Literally the weighted arithmetic mean the feature asks for, taken over a theme
space instead of a vector space — and **better behaved there**, because the
result is a distribution rather than a point. A week split between heartbreak and
euphoria comes out bimodal, which is the truth, instead of averaging into a
region that means nothing (see the traps below).

**Attribution comes free.** Each song's contribution to each theme is already a
term in that sum:

```
contribution(song, theme) = minutes(song) × confidence(song, theme)
```

Every claim in the summary can point at the songs and the minutes that produced
it. That is the difference between a summary and a horoscope.

**Vectors (the supporting answer).** The minutes-weighted centroid of the
window's embeddings, used for "the songs closest to your week's centre" and for
ranking themes outside the fixed vocabulary.

### Stage 3 — the prose

An LLM turns the ranked themes, their contributing songs and the minutes into a
paragraph. This step needs **no lyric bodies** — the reading already happened in
Stage 1, and what reaches it is derived data: theme labels, song titles, artists,
numbers.

---

### Two design traps, written down before they are hit

**Averaging vectors destroys mixed weeks.** The mean of "heartbreak" and
"euphoric dance" is not a mood — it is a point in vector space that means
nothing, and the nearest theme label to it will be arbitrary. This is the main
reason the theme tally, not the centroid, is the primary mechanism: a tally
*represents* a mixed week correctly. Where vectors are used, run weighted k-means
(k=2 or 3) and report the clusters rather than one centre, falling back to a
single centre only when one cluster clearly dominates. Report the honest thing:
"your week had two halves."

**One song can eat the whole summary.** That is arithmetically correct and it is
exactly the 500-plays example — but a summary that is 90% one song is a worse
read than the fact itself.

*Mitigation:* do not dampen the maths (no log/sqrt weighting — it would make the
number stop meaning "minutes"). Instead **state the concentration as a finding**:
"63% of your listening minutes last week were one song: *Without You I'm
Nothing*." Then summarise the remaining 37% separately. The concentration stat is
more interesting than the theme list it would otherwise drown.

---

### Where the models run

Two workloads, different in every dimension that matters. They get separate
answers.

| | Stage 1 — analyse lyrics | Stage 3 — write prose |
|---|---|---|
| Reads lyric bodies | **Yes. This is the whole job.** | No — derived data only |
| How often | Once per **song**, ever, shared by all users | Once per **user**, per week |
| Volume | Bounded by the catalogue; front-loaded, then marginal | Grows linearly with users |
| Latency | Irrelevant — batch, offline, retryable | Irrelevant — the window has closed |
| Task | Narrow and repetitive: extract themes from text | Open-ended: write something a person enjoys |
| Quality bar | Consistency matters more than eloquence | Eloquence is the product |

**Stage 1 is the strongest self-hosting candidate in the whole project**, and
this is a correction to what this doc said first. Every property points the same
way: high volume, fully batchable, latency-insensitive, a narrow task with a
consistency-not-eloquence quality bar, and the one step where sending the data
out is legally awkward. It also runs on your schedule, so a slow local model
costs you nothing but wall-clock time on a queue that already exists (`pg-boss`,
`docs/05` step 6). If you want to host a model yourself, host **this** one — it
is where self-hosting is the right engineering call and not just the one you
wanted to make.

**Stage 3 should start hosted.** Low volume, no lyric bodies involved, and
eloquence is exactly what small local models are worst at. Put it behind an
interface the way `Mailer` and `BlobStore` already are, and swap in something
local if there is ever a reason.

> On "free hosted APIs": the major providers have trial credits and rate-limited
> free tiers, not free production use. Plan on paying for Stage 3 or on
> self-hosting it — not on it being free. Benchmark with a real prompt before
> picking a provider, and treat any published price as something to re-check
> rather than something this doc should freeze.

#### The licensing question, stated correctly

An earlier draft of this doc argued for keeping lyric bodies on the server for
**privacy** reasons. That argument was wrong and is withdrawn. Lyric bodies are
not user data — they are identical for every user, which is the entire reason
they are stored globally. Sending one to a model discloses nothing about anybody.
The user-private facts are *which songs a person played and when*, and those
never need to leave regardless of where Stage 1 runs.

The real question is **licensing**, which `PROJECT_PLAN.md §5` already names as
the larger, Spotify-independent risk. Three things worth separating:

- §5's concern is **public display** of lyrics. Sending text to a model for
  analysis is processing, not display. Different exposure, and not obviously the
  same answer.
- The durable artefact this feature creates is a **theme list, not a copy of the
  lyric**. Derived data. Arguably this reduces exposure relative to what is
  already stored today.
- **LRCLIB's usage expectations** apply at service scale (§5 again). Bulk-feeding
  its corpus into a third-party model is a different kind of use than displaying
  a matching line, and is worth checking against their terms before, not after.

If Stage 1 runs on a hosted API, the mitigations are ordinary: pick a provider
whose terms exclude training on input, keep no provider-side copy, and store only
the derived themes. **Self-hosting Stage 1 makes this entire section moot**,
which is a real point in its favour on top of the engineering ones above.

---

### Data model sketch

Global, alongside `lyrics` — same shape, same "fetch once, share with everyone"
pattern:

```sql
song_analysis   (song_id PK → songs, model text, themes jsonb,
                 mood text, analysed_at)
song_embeddings (song_id PK → songs, model text, vector real[], computed_at)
```

`real[]` rather than pgvector to start with: a few hundred vectors per user
averaged in application code needs no index, and adding a Postgres extension is
an infrastructure decision worth deferring until nearest-neighbour search over
the whole catalogue is the query actually being run.

`model` is a column on **both** tables, and it is load-bearing. The day either
model changes, everything the old one produced is incomparable with the new —
and silently mixing two models' output produces confident nonsense. It also makes
re-analysis a backfill rather than a migration.

Per user:

```sql
play_events    (user_id, song_id, played_at, ms_played)   -- recently-played polling
user_summaries (user_id, window, period_start, period_end,
                themes jsonb, concentration real, coverage real,
                prose text, generated_at)
```

Summaries are stored, not recomputed on page load: the window has closed, the
answer cannot change, and a page that re-runs a model call on every refresh is
both slow and billable. `coverage` is the share of the window's minutes that had
lyrics at all — the summary has to be able to say what it is based on.

### Still open

- **The theme vocabulary.** Hand-written fixed list, open vocabulary from the
  model, or derived by clustering the analysed catalogue and labelling the
  clusters? A fixed list makes weeks comparable to each other and to other users;
  an open vocabulary describes any given song better. Probably both: a fixed
  spine for the arithmetic, free-text for colour.
- **Where the user sees it.** In the app only, or emailed weekly? Email needs the
  real mailer that `src/server.js` currently refuses to boot without.
- **Non-English lyrics.** A monolingual model will quietly do a bad job rather
  than fail — which is the worst failure mode this project has, because it is
  invisible. Which model, and is it multilingual?
- **Re-analysis cost.** Stage 1 is cheap per song and expensive per catalogue.
  Changing the model or the theme vocabulary means a full backfill. Worth knowing
  the size of that before the catalogue is large.
