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

### Decided

| Question | Answer |
|---|---|
| Windows | Rolling **last 7 days** and **last 30 days** |
| Where the play data comes from | **Live Spotify API** (`recently-played`) |
| Per-song weight | **Minutes played** (`ms_played`) |
| Method | **Lyric embeddings → time-weighted centroid → LLM writes the prose** |
| Genre | A second signal, folded into the text that gets embedded |

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

### How the arithmetic actually works

**1. Embed each song's lyrics — once, globally.**

The same insight the lyric catalogue already runs on (`docs/05` step 6): lyrics
are identical for everybody, so the vector is too. Embed once, every user
benefits, and cost stays flat as the user base grows.

The text embedded is the lyric body prefixed with the artist's genres, so that
the same words in a sludge-metal track and a bossa-nova track do not land in the
same place:

```
[genres: shoegaze, dream pop]
<lyric body>
```

**2. Take the time-weighted mean over the window.**

```
centroid = Σ(minutes_i × vector_i) / Σ(minutes_i)
```

Literally the weighted arithmetic mean the feature asks for. Songs with no
lyrics — instrumental, or never found — have no vector and are **excluded from
both sums**, never treated as a zero vector.

**3. Rank themes against it.**

Keep a fixed vocabulary of theme labels ("heartbreak", "defiance", "religious
imagery", "city at night", …), embedded with the same model. Cosine-similarity
the centroid against each; the top ones are the week's topics.

**4. Attribute each theme back to songs.**

```
contribution(song, theme) = minutes(song) × cos(vector_song, vector_theme)
```

This is the half that answers *"in these songs these topics were mentioned"*,
and it is also what keeps the feature honest — every claim in the summary can
point at the songs and the minutes that produced it.

**5. An LLM turns the ranked themes and songs into a paragraph.**

It receives theme labels, song titles, artists and minutes. It does **not**
receive lyric bodies (see the hosting section).

### Two design traps, written down before they are hit

**A single centroid is a blunt instrument.** The mean of "heartbreak" and
"euphoric dance" is not a mood — it is a point in vector space that means
nothing, and the nearest theme label to it will be arbitrary. If someone's week
genuinely had two moods, one average will describe neither.

*Mitigation:* run weighted k-means (k=2 or 3) over the window's vectors and
report the clusters, falling back to a single centroid only when one cluster
clearly dominates. Report the honest thing: "your week had two halves."

**One song can eat the whole summary.** That is arithmetically correct and it is
exactly the user's 500-plays example — but a summary that is 90% one song is a
worse read than the fact itself.

*Mitigation:* do not dampen the maths (no log/sqrt weighting — it would make the
number stop meaning "minutes"). Instead **state the concentration as a finding**:
"63% of your listening minutes last week were one song: *Without You I'm
Nothing*." Then summarise the remaining 37% separately. The concentration stat is
more interesting than the theme list it would otherwise drown.

**Coverage, again.** If lyrics were found for only 70% of the week's minutes, the
summary must say so — the same rule the stats page already follows for the
12-month export window. A confident summary built on two-thirds of the data,
with no note saying which two-thirds, is the failure mode this project keeps
designing against.

### Where the model runs — the open decision

Two workloads with completely different economics, so they get separate answers.

| | Embedding lyrics | Writing the prose |
|---|---|---|
| How often | Once per **song**, ever, shared by all users | Once per **user**, per week |
| Volume | Grows with the catalogue, then flattens | Grows linearly with users |
| Quality needed | Modest — it feeds arithmetic, not prose | High — a person reads it |
| Hardware | CPU is fine | GPU, or a hosted API |

**Recommendation: embed locally, write remotely.**

- **Embedding self-hosted** is genuinely cheap. A small sentence-transformer
  (~100 MB, 384 dims) runs on the VPS's CPU, and because vectors are global and
  computed once per song, the work is amortised across the entire user base
  exactly like lyric fetching. There is no ongoing per-user cost at all.
- **Prose from a hosted API** is low-volume by construction: one call per user
  per week, with a small prompt (a few dozen song titles and theme labels, no
  lyric bodies). Cost scales with users but from a very low base — benchmark it
  with a real prompt before committing to a provider, and treat any published
  price as something to re-check rather than something this doc should freeze.

This also happens to be the best privacy and licensing position: **lyric bodies
never leave the server**. Only derived themes and song titles do. A project that
promises "we show the matching line, never the whole lyric" should not be posting
whole lyrics to a third party, and vectors are derived data rather than a copy of
the work.

**On self-hosting the LLM too:** worth wanting, and the CV argument is real — but
note that the split above already gives you a self-hosted ML component. The
embedding model, the weighted centroid, the clustering and the theme ranking are
the actual machine learning here. The prose step is the commodity part. Running
your own generation model is a hardware commitment (a GPU box, or very slow CPU
inference) bought for the least differentiated piece of the pipeline. A
reasonable path: ship on a hosted API, keep the prose step behind an interface
like `Mailer` and `BlobStore` already are, and swap in a local model when there
is a reason beyond wanting one.

> Note on "free hosted APIs": the major providers have trial credits and
> rate-limited free tiers, not free production use. Plan on paying for this step
> or on self-hosting it — not on it being free.

### Data model sketch

Global, alongside `lyrics`:

```sql
song_embeddings (song_id PK → songs, model text, vector real[], computed_at)
```

`real[]` rather than pgvector to start with: a few hundred vectors per user
averaged in application code needs no index, and adding a Postgres extension is
an infrastructure decision worth deferring until nearest-neighbour search over
the whole catalogue is actually the query being run. `model` is a column because
the day the embedding model changes, every vector computed by the old one is
incomparable with the new — and silently mixing two models' vectors produces
confident nonsense.

Per user:

```sql
play_events   (user_id, song_id, played_at, ms_played)   -- from recently-played polling
user_summaries(user_id, window, period_start, period_end,
               themes jsonb, concentration real, prose text, generated_at)
```

Summaries are stored, not recomputed on page load: the window has closed, the
answer cannot change, and a page that re-runs an LLM call on every refresh is
both slow and billable.

### Still open

- The theme vocabulary — hand-written list, or derived by clustering the whole
  catalogue and labelling the clusters?
- Does the user see this in the app only, or does it get emailed weekly? (Email
  needs the real mailer that `src/server.js` currently refuses to boot without.)
- Non-English lyrics: a monolingual embedding model will quietly do a bad job
  rather than fail. Which model, and does it need to be multilingual?
