// Creates or updates one pull-request comment, found by a hidden marker, using
// the REST API directly (no dependencies). Returns a short status string.

export async function upsertComment({ body, marker, token, repo, pr, api = "https://api.github.com", create = true, fetchImpl = fetch }) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cu-guard",
  };
  const base = `${api}/repos/${repo}/issues/${pr}/comments`;

  let existing = null;
  for (let page = 1; !existing; page++) {
    const res = await fetchImpl(`${base}?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new HttpError(res.status, `listing comments failed: ${res.status}`);
    const comments = await res.json();
    existing = comments.find((c) => typeof c.body === "string" && c.body.startsWith(marker) && trusted(c)) ?? null;
    if (comments.length < 100) break;
  }

  if (!existing && !create) return "skipped";
  const url = existing ? `${api}/repos/${repo}/issues/comments/${existing.id}` : base;
  const res = await fetchImpl(url, {
    method: existing ? "PATCH" : "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new HttpError(res.status, `${existing ? "updating" : "creating"} the comment failed: ${res.status}`);
  return existing ? "updated" : "created";
}

// Anyone can paste the marker into a comment, so only edit comments written by a
// bot (the default token) or by someone with write access (a personal token).
const trusted = (c) => c.user?.type === "Bot" || ["OWNER", "MEMBER", "COLLABORATOR"].includes(c.author_association);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
