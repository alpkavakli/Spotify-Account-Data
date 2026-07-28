import { redirect } from "next/navigation";
import { apiGet, currentUser } from "@/lib/api";

export const metadata = { title: "Stats" };
export const dynamic = "force-dynamic";

/**
 * Say plainly what period these numbers describe.
 *
 * Spotify's standard export contains only the LAST 12 MONTHS, so a stats page
 * that stays quiet reads as all-time and misleads — the top-songs list will be
 * missing songs the user played hundreds of times years ago. The window comes
 * from the ingest itself, so it stops warning the moment they upload extended
 * history.
 */
function Coverage({ coverage }) {
  if (!coverage?.from) return null;

  return (
    <div className={coverage.source === "account-data" ? "notice warn" : "notice"}>
      Counts cover <strong>{coverage.from}</strong> to <strong>{coverage.to}</strong>.
      {coverage.skipThresholdSeconds !== null ? (
        <> A play counts as a listen from {coverage.skipThresholdSeconds}s.</>
      ) : null}
      {coverage.source === "account-data" ? (
        <>
          {" "}
          This is Spotify&rsquo;s &ldquo;Account data&rdquo; export, which only
          includes the last 12 months — anything you played before{" "}
          {coverage.from} is missing. Request &ldquo;Extended streaming
          history&rdquo; from{" "}
          <a href="https://www.spotify.com/account/privacy/">Spotify</a> for your
          full record, then <a href="/app/upload">upload it here</a>.
        </>
      ) : null}
    </div>
  );
}

export default async function StatsPage() {
  const user = await currentUser();
  if (!user) redirect("/signin");

  const [stats, words] = await Promise.all([
    apiGet("/stats"),
    apiGet("/topWords?limit=40"),
  ]);

  if (stats.status !== 200) {
    return <p className="notice err">{stats.data?.error || "could not load your stats"}</p>;
  }

  const s = stats.data;

  if (s.tracks === 0) {
    return (
      <>
        <h1>Stats</h1>
        <div className="notice">
          Nothing here yet. <a href="/app/upload">Upload your Spotify data</a> to
          see your listening.
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Stats</h1>

      <p className="muted">
        {s.plays} plays · {s.streams} listens · {s.hours} hours · {s.tracks} songs
        · {s.artists} artists
      </p>

      <Coverage coverage={s.coverage} />

      <h2>Most listened songs</h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>song</th>
            <th>artist</th>
            <th className="num">plays</th>
            <th className="num">listens</th>
            <th className="num">minutes</th>
          </tr>
        </thead>
        <tbody>
          {s.topSongs.map((song, i) => (
            <tr key={song.id}>
              <td>{i + 1}</td>
              <td>{song.track}</td>
              <td>{song.artist}</td>
              <td className="num">{song.plays}</td>
              <td className="num">{song.streams}</td>
              <td className="num">{song.minutes}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Most listened artists</h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>artist</th>
            <th className="num">songs</th>
            <th className="num">plays</th>
            <th className="num">listens</th>
            <th className="num">hours</th>
          </tr>
        </thead>
        <tbody>
          {s.topArtists.map((artist, i) => (
            <tr key={artist.artist}>
              <td>{i + 1}</td>
              <td>{artist.artist}</td>
              <td className="num">{artist.songs}</td>
              <td className="num">{artist.plays}</td>
              <td className="num">{artist.streams}</td>
              <td className="num">{artist.hours}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {words.status === 200 && words.data.words.length > 0 ? (
        <>
          <h2>Your most-sung words</h2>
          <p className="muted">
            Across the {words.data.songsWithLyrics} songs we found lyrics for.
            Click one to search it.
          </p>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>word</th>
                <th className="num">songs</th>
                <th className="num">plays</th>
              </tr>
            </thead>
            <tbody>
              {words.data.words.map((w, i) => (
                <tr key={w.word}>
                  <td>{i + 1}</td>
                  <td>
                    <a href={`/app?q=${encodeURIComponent(w.word)}`}>{w.word}</a>
                  </td>
                  <td className="num">{w.songs}</td>
                  <td className="num">{w.plays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  );
}
