import { redirect } from "next/navigation";
import { apiGet, currentUser } from "@/lib/api";

export const metadata = { title: "Search" };
export const dynamic = "force-dynamic";

/**
 * The snippet arrives with [[ ]] around the matched words — the marker both
 * storage adapters agree on, asserted by the conformance suite. Rendered as
 * React elements rather than dangerouslySetInnerHTML: lyric text is third-party
 * content and must never be interpreted as markup.
 */
function Snippet({ text }) {
  const parts = String(text || "").split(/\[\[|\]\]/);
  return (
    <span className="snippet">
      {parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
    </span>
  );
}

function Result({ song }) {
  const bits = [];
  if (song.occurrences > 1) bits.push(`${song.occurrences}× in lyrics`);
  if (song.playCount) {
    bits.push(
      song.streamCount < song.playCount
        ? `played ${song.playCount}× (${song.streamCount} listens)`
        : `played ${song.playCount}×`
    );
  }
  if (song.inLibrary) bits.push("liked");
  if (song.playlists?.length) bits.push(`in: ${song.playlists.join(", ")}`);

  return (
    <div className="song">
      <div>
        <b>{song.track}</b> <span className="artist">— {song.artist}</span>
      </div>
      <Snippet text={song.snippet} />
      <span className="info">{bits.join(" · ")}</span>
    </div>
  );
}

export default async function SearchPage({ searchParams }) {
  const user = await currentUser();
  if (!user) redirect("/signin");

  const params = await searchParams;
  const q = String(params?.q || "").trim();

  const status = await apiGet("/status");
  const library = status.status === 200 ? status.data : null;
  const results = q ? await apiGet(`/searchForWord?q=${encodeURIComponent(q)}`) : null;

  return (
    <>
      <h1>Search your lyrics</h1>

      <form method="get" action="/app">
        <div className="row">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="a word — door, rain, september…"
            aria-label="Search your lyrics"
          />
          <button type="submit">search</button>
        </div>
      </form>

      {library && library.tracks === 0 ? (
        <div className="notice">
          Nothing to search yet. <a href="/app/upload">Upload your Spotify data</a>{" "}
          to get started.
        </div>
      ) : library ? (
        <p className="muted">
          {library.tracks} songs · lyrics found for {library.lyrics?.ok ?? 0}
          {library.processed < library.tracks ? (
            <>
              {" "}
              · <span className="pill">
                {library.tracks - library.processed} still being looked up
              </span>
            </>
          ) : null}
        </p>
      ) : null}

      {results ? (
        results.status === 200 ? (
          <>
            <h2>
              {results.data.count} {results.data.count === 1 ? "song" : "songs"}{" "}
              mentioning “{q}”
            </h2>
            {results.data.results.map((song) => (
              <Result key={song.id} song={song} />
            ))}
            {results.data.count === 0 ? (
              <p className="muted">
                No matches. Only songs whose lyrics we found are searchable.
              </p>
            ) : null}
          </>
        ) : (
          <p className="notice err">
            {results.data?.error || "that search did not work"}
          </p>
        )
      ) : null}
    </>
  );
}
