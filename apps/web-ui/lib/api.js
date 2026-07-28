import { cookies } from "next/headers";

// Talking to the API from a server component.
//
// The browser reaches the API through the /api rewrite in next.config.mjs, so it
// only ever sees one origin. Server components skip that hop and call the API
// process directly — but they have to forward the caller's cookie by hand,
// because a server component has no browser attached to it.

const API_ORIGIN = process.env.API_ORIGIN || "http://127.0.0.1:3001";

/**
 * Fetch from the API as the currently signed-in user.
 *
 * @returns {Promise<{status: number, data: any}>} — never throws on a 4xx,
 *   because "not signed in" and "no songs yet" are normal states for a page to
 *   render, not exceptions.
 */
export async function apiGet(path) {
  const cookieHeader = (await cookies()).toString();

  let res;
  try {
    res = await fetch(API_ORIGIN + path, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
      // Always live: this is a user's private library, and a cached page would
      // be both stale and, if it were ever shared, someone else's data.
      cache: "no-store",
    });
  } catch (err) {
    // The API being down should render a page saying so, not a stack trace.
    return { status: 503, data: { error: "the service is not reachable right now" } };
  }

  const text = await res.text();
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  return { status: res.status, data: isJson && text ? JSON.parse(text) : text };
}

/** The signed-in user, or null. */
export async function currentUser() {
  const { status, data } = await apiGet("/me");
  return status === 200 && data?.signedIn ? data : null;
}
