#!/usr/bin/env node
/**
 * Rewrites the contribution section of a README with the author's pull requests
 * and issues on other, public (open source) repositories.
 *
 * Everything between
 *   <!--START_SECTION:activity-->
 *   <!--END_SECTION:activity-->
 * is replaced, so the number of rendered lines always follows MAX_LINES.
 *
 * Why the search API and not the events API:
 *   - /users/{user}/events/public only covers the last ~90 days, so a quiet
 *     month empties the section.
 *   - that feed returns 0 events for this account anyway: nearly all of its
 *     recent activity happens in private repositories, which are never
 *     published there.
 * The search API instead returns contributions of any age, and comments
 * (IssueCommentEvent) are simply never queried.
 *
 * Env:
 *   GITHUB_TOKEN       required (actions: use ${{ secrets.GITHUB_TOKEN }})
 *   GH_USERNAME        required, defaults to the repo owner in the workflow
 *   MAX_LINES          max entries to render      (default 20)
 *   TARGET_FILE        file to update             (default README.md)
 *   INCLUDE            merged-pr,open-pr,issue    (default all three)
 *   INCLUDE_OWN_REPOS  also list the author's own repositories (default false)
 *   SKIP_WHEN_EMPTY    keep the previous list when nothing is found (default true)
 */

import fs from "node:fs";

const {
  GITHUB_TOKEN,
  GH_USERNAME,
  MAX_LINES = "20",
  TARGET_FILE = "README.md",
  INCLUDE = "merged-pr,open-pr,issue",
  INCLUDE_OWN_REPOS = "false",
  SKIP_WHEN_EMPTY = "true",
} = process.env;

const START_MARKER = "<!--START_SECTION:activity-->";
const END_MARKER = "<!--END_SECTION:activity-->";
const maxLines = Number.parseInt(MAX_LINES, 10);
const include = INCLUDE.split(",").map((kind) => kind.trim()).filter(Boolean);
const includeOwnRepos = INCLUDE_OWN_REPOS === "true";

const log = (message) => console.log(message);
const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const api = async (path) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${GITHUB_TOKEN}`,
      "user-agent": "update-contributions",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    fail(`GitHub API ${response.status} for ${path}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
};

/** Search returns newest-updated first, and at most 1000 results (10 pages). */
const search = async (query) => {
  const items = [];
  for (let page = 1; page <= 3; page++) {
    const data = await api(
      `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=100&page=${page}`,
    );
    items.push(...data.items);
    if (data.items.length < 100) break;
  }
  return items;
};

const repoOf = (item) => item.repository_url.replace("https://api.github.com/repos/", "");
const repoOwner = (item) => repoOf(item).split("/")[0];
const repoLink = (item) => `[${repoOf(item)}](https://github.com/${repoOf(item)})`;

const kinds = {
  "merged-pr": {
    noun: "Merged PR",
    emoji: "🎉",
    query: (user) => `author:${user} type:pr is:merged${ownFilter(user)}`,
    // merged_at is the moment the contribution landed
    date: (item) => item.pull_request?.merged_at ?? item.closed_at ?? item.updated_at,
  },
  "open-pr": {
    noun: "Opened PR",
    emoji: "💪",
    query: (user) => `author:${user} type:pr is:open${ownFilter(user)}`,
    date: (item) => item.created_at,
  },
  issue: {
    noun: "Opened issue",
    emoji: "❗",
    query: (user) => `author:${user} type:issue${ownFilter(user)}`,
    date: (item) => item.created_at,
  },
};

function ownFilter(user) {
  return includeOwnRepos ? "" : ` -user:${user}`;
}

const render = (kind, item) => `${kinds[kind].emoji} ${kinds[kind].noun} [#${item.number}](${item.html_url}) in ${repoLink(item)}`;

/** Only public repositories may end up in a public README. */
const visibility = new Map();
const isPublicRepo = async (repo) => {
  if (!visibility.has(repo)) {
    try {
      const data = await api(`/repos/${repo}`);
      visibility.set(repo, data.private === false);
    } catch {
      visibility.set(repo, false);
    }
  }
  return visibility.get(repo);
};

const collect = async (kind) => {
  const definition = kinds[kind];
  const items = await search(definition.query(GH_USERNAME));
  const accepted = [];

  for (const item of items) {
    if (!includeOwnRepos && repoOwner(item) === GH_USERNAME) continue;
    if (!(await isPublicRepo(repoOf(item)))) continue;
    accepted.push({ kind, item, date: definition.date(item) });
  }

  log(`${kind}: ${items.length} found, ${accepted.length} kept (public repositories only)`);
  return accepted;
};

const main = async () => {
  if (!GITHUB_TOKEN) fail("GITHUB_TOKEN is required.");
  if (!GH_USERNAME) fail("GH_USERNAME is required.");
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    fail(`MAX_LINES must be a positive integer, got "${MAX_LINES}"`);
  }

  const unknown = include.filter((kind) => !Object.hasOwn(kinds, kind));
  if (unknown.length) fail(`Unknown INCLUDE value(s): ${unknown.join(", ")}`);

  const collected = (await Promise.all(include.map(collect))).flat();
  const seen = new Set();
  const entries = collected
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .filter((entry) => {
      if (seen.has(entry.item.html_url)) return false;
      seen.add(entry.item.html_url);
      return true;
    })
    .slice(0, maxLines)
    .map((entry) => render(entry.kind, entry.item));

  log(`${entries.length} of ${maxLines} requested entries selected`);

  const original = fs.readFileSync(TARGET_FILE, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);

  const startIdx = lines.findIndex((line) => line.trim() === START_MARKER);
  const endIdx = lines.findIndex((line) => line.trim() === END_MARKER);

  if (startIdx === -1) fail(`Couldn't find ${START_MARKER} in ${TARGET_FILE}`);
  if (endIdx === -1) fail(`Couldn't find ${END_MARKER} in ${TARGET_FILE}`);
  if (endIdx < startIdx) fail(`${END_MARKER} appears before ${START_MARKER} in ${TARGET_FILE}`);

  const currentBody = lines.slice(startIdx + 1, endIdx);
  const nextBody = entries.map((entry, index) => `${index + 1}. ${entry}`);

  if (nextBody.length === 0 && SKIP_WHEN_EMPTY !== "false") {
    log(`Found no contributions. Leaving ${TARGET_FILE} unchanged with previous entries`);
    return;
  }

  if (currentBody.join("\n").trim() === nextBody.join("\n").trim()) {
    log(`No changes detected in ${TARGET_FILE}`);
    return;
  }

  const next = [...lines.slice(0, startIdx + 1), ...nextBody, ...lines.slice(endIdx)];
  fs.writeFileSync(TARGET_FILE, next.join(eol));
  log(`Wrote ${nextBody.length} entries between the activity markers in ${TARGET_FILE}`);
};

await main();
