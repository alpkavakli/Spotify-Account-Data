"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// The API takes the raw file as the request body — no multipart, no parser on
// either side. `fetch(url, { body: file })` is the whole upload.

const MAX_BYTES = 200 * 1024 * 1024;

export default function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState(null);
  const [state, setState] = useState("idle"); // idle | uploading | done | error
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (!file) return;

    if (file.size > MAX_BYTES) {
      setError("that file is larger than 200 MB");
      setState("error");
      return;
    }

    setState("uploading");
    setError(null);

    try {
      const res = await fetch(
        `/api/uploads?filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: file,
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `upload failed (${res.status})`);
      }
      setState("done");
      setFile(null);
      // Re-render the server component so the new row appears in the list.
      router.refresh();
    } catch (err) {
      setError(err.message);
      setState("error");
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="row">
        <input
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => {
            setFile(e.target.files?.[0] || null);
            setState("idle");
            setError(null);
          }}
          aria-label="Your Spotify export zip"
        />
        <button type="submit" disabled={!file || state === "uploading"}>
          {state === "uploading" ? "uploading…" : "upload"}
        </button>
      </div>

      {state === "done" ? (
        <p className="notice">
          Uploaded. We are reading it now — refresh in a moment to see the result.
        </p>
      ) : null}
      {error ? <p className="notice err">{error}</p> : null}
    </form>
  );
}
