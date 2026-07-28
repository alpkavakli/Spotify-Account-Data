"use client";

import { useState } from "react";

// One of only two client components in the app. Everything else is server-
// rendered, which is the point of choosing Next over an SPA.

export default function SignInForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setState("sending");
    setError(null);

    try {
      const res = await fetch("/api/auth/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "something went wrong");
      }
      setState("sent");
    } catch (err) {
      setError(err.message);
      setState("error");
    }
  }

  if (state === "sent") {
    // Deliberately says the same thing whether or not the address has an
    // account: the API answers identically too, so this page cannot be used to
    // find out who has signed up.
    return (
      <div className="notice">
        <p>
          <strong>Check your inbox.</strong>
        </p>
        <p>
          If <strong>{email}</strong> can receive mail, a sign-in link is on its
          way. It expires in 15 minutes.
        </p>
        <p className="muted">
          Nothing arrived? Check spam, then{" "}
          <button type="button" onClick={() => setState("idle")}>
            try again
          </button>
          .
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <div className="row">
        <input
          type="email"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          required
          aria-label="Email address"
        />
        <button type="submit" disabled={state === "sending" || !email}>
          {state === "sending" ? "sending…" : "email me a link"}
        </button>
      </div>
      {error ? <p className="notice err">{error}</p> : null}
    </form>
  );
}
