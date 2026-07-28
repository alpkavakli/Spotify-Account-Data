import { currentUser } from "@/lib/api";
import "./globals.css";

// Keeps the serif, deliberately-not-"AI-looking" character of the Personal
// Edition's UI. The look is a product decision, not an accident.
export const metadata = {
  title: {
    default: "Lyric Search — find your songs by the words in them",
    template: "%s · Lyric Search",
  },
  description:
    "Search your own Spotify listening history by the words in song lyrics, " +
    "see every match across your library, playlists and history, and turn a " +
    "search into a playlist.",
};

// The header shows who is signed in, so no page in the app can be static.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }) {
  const user = await currentUser();

  return (
    <html lang="en">
      <body>
        <header>
          <a href="/" className="brand">
            lyric search
          </a>
          <nav>
            {user ? (
              <>
                <a href="/app">search</a>
                <a href="/app/stats">stats</a>
                <a href="/app/upload">upload</a>
                <form action="/api/auth/logout" method="post" className="inline">
                  <button type="submit">sign out</button>
                </form>
              </>
            ) : (
              <a href="/signin">sign in</a>
            )}
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <span>
            Not affiliated with Spotify. Lyrics from{" "}
            <a href="https://lrclib.net">LRCLIB</a>.
          </span>
        </footer>
      </body>
    </html>
  );
}
