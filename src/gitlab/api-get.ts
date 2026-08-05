/**
 * Low-level authenticated GET against the GitLab REST API.
 *
 * Replaces `(api as any).requester.get(path)`, which in @gitbeaker/rest 42 does
 * NOT prepend `/api/v4`. A call like `/projects/…/merge_requests/…/changes`
 * therefore hit GitLab's web route, got redirected to /users/sign_in and came
 * back as a Cloudflare 403 — never reaching the API at all.
 *
 * This builds the real API URL and sends the token exactly the way
 * GitLabProvider.createComment does (Bearer for glpat-/gloas- tokens, otherwise
 * PRIVATE-TOKEN). Errors carry `.response.status` so existing 404 checks keep
 * working.
 */
export async function gitlabApiGet<T>(
  host: string,
  token: string,
  path: string,
): Promise<T> {
  const base = host.replace(/\/+$/, "");
  const url = `${base}/api/v4${path.startsWith("/") ? path : `/${path}`}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token.startsWith("glpat-") || token.startsWith("gloas-")) {
    headers["Authorization"] = `Bearer ${token}`;
  } else {
    headers["PRIVATE-TOKEN"] = token;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(
      `GitLab API GET ${path} failed: ${response.status} ${response.statusText}`,
    ) as Error & { response?: { status: number; body: string } };
    error.response = { status: response.status, body };
    throw error;
  }

  return (await response.json()) as T;
}
