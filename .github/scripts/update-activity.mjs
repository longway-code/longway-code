#!/usr/bin/env node
/**
 * Rewrites the activity section of a README with the latest public GitHub events.
 *
 * Everything between
 *   <!--START_SECTION:activity-->
 *   <!--END_SECTION:activity-->
 * is replaced, so the number of rendered lines always follows MAX_LINES.
 *
 * Why this exists: jamesgeorge007/github-activity-readme only rewrites lines that
 * already exist in the README (it assigns to readmeContent[startIdx + idx]), so
 * once the section has N lines it can never grow. Raising MAX_LINES from 10 to 20
 * therefore has no effect. This script always rewrites the whole section.
 *
 * Env:
 *   GITHUB_TOKEN   required (actions: use ${{ secrets.GITHUB_TOKEN }})
 *   GH_USERNAME    required, defaults to the repo owner in the workflow
 *   MAX_LINES      max entries to render          (default 20)
 *   TARGET_FILE    file to update                 (default README.md)
 *   FILTER_EVENTS  comma separated event types    (default PullRequestEvent,IssuesEvent,IssueCommentEvent,ReleaseEvent)
 *   SKIP_WHEN_EMPTY  keep the previous list when no events are found (default true)
 *   EVENTS_FILE    optional: read events JSON from a local file instead of the API (for local testing)
 */

import fs from "node:fs";

const {
  GITHUB_TOKEN,
  GH_USERNAME,
  MAX_LINES = "20",
  TARGET_FILE = "README.md",
  FILTER_EVENTS = "PullRequestEvent,IssuesEvent,IssueCommentEvent,ReleaseEvent",
  SKIP_WHEN_EMPTY = "true",
  EVENTS_FILE,
} = process.env;

const START_MARKER = "<!--START_SECTION:activity-->";
const END_MARKER = "<!--END_SECTION:activity-->";
const maxLines = Number.parseInt(MAX_LINES, 10);
const filterEvents = FILTER_EVENTS.split(",")
  .map((event) => event.trim())
  .filter(Boolean);

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const capitalize = (str) => (str ? str[0].toUpperCase() + str.slice(1) : str);

/** Markdown link for the issue / PR / release the event is about. */
const toUrlFormat = (item) => {
  if (typeof item === "string") {
    return `[${item}](https://github.com/${item})`;
  }
  const payload = item.payload ?? {};
  if (payload.comment) {
    return `[#${payload.issue.number}](${payload.comment.html_url})`;
  }
  if (payload.issue) {
    return `[#${payload.issue.number}](${payload.issue.html_url})`;
  }
  if (payload.pull_request) {
    const number = payload.pull_request.number;
    return `[#${number}](https://github.com/${item.repo.name}/pull/${number})`;
  }
  if (payload.release) {
    return `[${payload.release.name || payload.release.tag_name}](${payload.release.html_url})`;
  }
  return "";
};

const serializers = {
  IssueCommentEvent: (event) =>
    `🗣 Commented on ${toUrlFormat(event)} in ${toUrlFormat(event.repo.name)}`,

  IssuesEvent: (event) => {
    let emoji = "ℹ️";
    if (event.payload.action === "opened") emoji = "❗";
    if (event.payload.action === "reopened") emoji = "🔓";
    if (event.payload.action === "closed") emoji = "🔒";
    return `${emoji} ${capitalize(event.payload.action)} issue ${toUrlFormat(event)} in ${toUrlFormat(event.repo.name)}`;
  },

  PullRequestEvent: (event) => {
    const action = event.payload.action;
    // The public events API reports merges either as action "merged",
    // or as action "closed" with payload.pull_request.merged === true
    const merged = action === "merged" || (action === "closed" && event.payload.pull_request?.merged === true);
    let emoji = "ℹ️";
    let actionText = capitalize(action);
    if (merged) {
      emoji = "🎉";
      actionText = "Merged";
    } else if (action === "opened") {
      emoji = "💪";
    } else if (action === "closed") {
      emoji = "❌";
    }
    return `${emoji} ${actionText} PR ${toUrlFormat(event)} in ${toUrlFormat(event.repo.name)}`;
  },

  ReleaseEvent: (event) =>
    `🚀 ${capitalize(event.payload.action)} release ${toUrlFormat(event)} in ${toUrlFormat(event.repo.name)}`,
};

const fetchEvents = async () => {
  if (!GITHUB_TOKEN) fail("GITHUB_TOKEN is required to fetch activity.");
  if (!GH_USERNAME) fail("GH_USERNAME is required to fetch activity.");

  const response = await fetch(
    `https://api.github.com/users/${GH_USERNAME}/events/public?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${GITHUB_TOKEN}`,
        "user-agent": "update-activity-readme",
        "x-github-api-version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    fail(`GitHub API responded with ${response.status}: ${await response.text()}`);
  }
  return response.json();
};

const main = async () => {
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    fail(`MAX_LINES must be a positive integer, got "${MAX_LINES}"`);
  }

  const events = EVENTS_FILE
    ? JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8"))
    : await fetchEvents();

  console.log(`${events.length} public events fetched for ${GH_USERNAME ?? "local file"}`);

  const entries = events
    .filter((event) => Object.hasOwn(serializers, event.type) && filterEvents.includes(event.type))
    .slice(0, maxLines)
    .map((event) => serializers[event.type](event));

  console.log(`${entries.length} of ${maxLines} requested entries selected`);

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

  // GitHub only serves ~90 days of events. With no events at all, keep the
  // previous list instead of blanking the section.
  if (nextBody.length === 0 && SKIP_WHEN_EMPTY !== "false") {
    console.log(`Found no activity. Leaving ${TARGET_FILE} unchanged with previous activity`);
    return;
  }

  if (currentBody.join("\n").trim() === nextBody.join("\n").trim()) {
    console.log(`No changes detected in ${TARGET_FILE}`);
    return;
  }

  const next = [...lines.slice(0, startIdx + 1), ...nextBody, ...lines.slice(endIdx)];
  fs.writeFileSync(TARGET_FILE, next.join(eol));
  console.log(`Wrote ${nextBody.length} entries between the activity markers in ${TARGET_FILE}`);
};

await main();
