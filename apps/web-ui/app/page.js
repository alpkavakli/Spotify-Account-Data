import { currentUser } from "@/lib/api";

// The landing page: the only page a search engine will ever see, and the reason
// docs/01-DECISIONS.md picked SSR over an SPA. The service is ad-supported, so
// organic traffic is the business model and an empty <div id="root"> would be
// the wrong trade.

export const metadata = {
  title: "Lyric Search — find your songs by the words in them",
  description:
    "Which of your songs mention 'door'? Upload your Spotify data and search " +
    "your own listening history by the words in the lyrics.",
};

export default async function HomePage() {
  const user = await currentUser();

  return (
    <>
      <h1>Search your music by the words in it.</h1>

      <p className="lede">
        Which of your songs mention <em>door</em>? Or <em>rain</em>, or{" "}
        <em>September</em>? Upload your Spotify data and find every match across
        your library, your playlists and everything you have listened to.
      </p>

      <p>
        {user ? (
          <a href="/app">Go to your library →</a>
        ) : (
          <a href="/signin">Get started — no password needed →</a>
        )}
      </p>

      <h2>How it works</h2>
      <ol className="muted">
        <li>
          Ask Spotify for your data at{" "}
          <a href="https://www.spotify.com/account/privacy/">
            spotify.com/account/privacy
          </a>
          .
        </li>
        <li>Upload the zip here when it arrives.</li>
        <li>
          We match every song against a lyrics database and index the words, so
          you can search them.
        </li>
      </ol>

      <div className="notice">
        <strong>Ask for both packages.</strong> The &ldquo;Account data&rdquo;
        download arrives in a few days but only contains the{" "}
        <strong>last 12 months</strong> of listening. &ldquo;Extended streaming
        history&rdquo; covers your whole account but takes up to 30 days — and it
        does not include your playlists, so you want both. We read either one, and
        we always tell you which period your numbers actually cover.
      </div>

      <h2>What we do with your data</h2>
      <ul className="muted">
        <li>Your listening history is yours alone — nobody else can see it.</li>
        <li>
          Song lyrics are stored once and shared across everyone who owns that
          song, so we ask the lyrics service about each song only once.
        </li>
        <li>
          We show the matching line, never the whole lyric — see{" "}
          <a href="https://lrclib.net">LRCLIB</a> for the source.
        </li>
        <li>Deleting your account deletes your data. Immediately, not eventually.</li>
      </ul>

      <p className="muted">
        Prefer to run it yourself? There is a free, open-source edition you can
        self-host that never talks to us at all.
      </p>
    </>
  );
}
