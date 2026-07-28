import { redirect } from "next/navigation";
import { apiGet, currentUser } from "@/lib/api";
import UploadForm from "./form";

export const metadata = { title: "Upload" };
export const dynamic = "force-dynamic";

const STATUS_TEXT = {
  pending: "waiting to be processed",
  processing: "being processed…",
  done: "done",
  failed: "failed",
};

export default async function UploadPage() {
  const user = await currentUser();
  if (!user) redirect("/signin");

  const { status, data } = await apiGet("/uploads");
  const uploads = status === 200 ? data.uploads : [];

  return (
    <>
      <h1>Upload your Spotify data</h1>

      <p className="lede">
        Drop in the zip Spotify emailed you. We read it in the background — you
        can leave this page.
      </p>

      <UploadForm />

      <h2>Which download do I need?</h2>
      <div className="notice">
        Ask for <strong>both</strong> at{" "}
        <a href="https://www.spotify.com/account/privacy/">
          spotify.com/account/privacy
        </a>
        :
        <ul>
          <li>
            <strong>Account data</strong> — a few days. Your playlists and liked
            songs, plus the <strong>last 12 months</strong> of listening.
          </li>
          <li>
            <strong>Extended streaming history</strong> — up to 30 days. Your{" "}
            <em>entire</em> listening record, but no playlists or liked songs.
          </li>
        </ul>
        They contain different things, so request both and upload each when it
        arrives. Uploading again adds to your library rather than replacing it.
      </div>

      {uploads.length > 0 ? (
        <>
          <h2>Your uploads</h2>
          <table>
            <thead>
              <tr>
                <th>file</th>
                <th>when</th>
                <th></th>
                <th className="num">songs</th>
              </tr>
            </thead>
            <tbody>
              {uploads.map((u) => (
                <tr key={u.id}>
                  <td>{u.filename || "(unnamed)"}</td>
                  <td className="muted">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td className={u.status === "failed" ? "muted" : ""}>
                    {u.status === "failed" ? (
                      <span title={u.error}>failed — {u.error}</span>
                    ) : (
                      STATUS_TEXT[u.status] || u.status
                    )}
                  </td>
                  <td className="num">{u.songs_found ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Processing usually takes a few seconds. Finding lyrics for new songs
            takes longer — search works as they arrive.
          </p>
        </>
      ) : null}
    </>
  );
}
