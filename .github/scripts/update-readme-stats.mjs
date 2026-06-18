import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const API_ROOT = "https://api.github.com";
const token =
  process.env.GH_STATS_TOKEN ||
  process.env.STATS_GITHUB_TOKEN ||
  process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error("Missing GH_STATS_TOKEN, STATS_GITHUB_TOKEN, or GITHUB_TOKEN.");
}

const username = process.env.STATS_GITHUB_USERNAME || "jam3gw";
const owners = (process.env.STATS_REPO_OWNERS || "jam3gw,pedestal-ai,VoiceRun")
  .split(",")
  .map((owner) => owner.trim())
  .filter(Boolean);

const authorPattern =
  process.env.STATS_AUTHOR_PATTERN ||
  "Jake Moses\\|jam3gw\\|jake@pedestal.ai\\|mosesjake32@gmail.com\\|42848815+jam3gw@users.noreply.github.com";

const featuredProjects = [
  "jam3gw/deep-research-assistant",
  "jam3gw/agentic-service-bot",
  "jam3gw/anthropic-math-tutor",
  "jam3gw/jake-moses-com",
];

const statsCache = new Map();
const repoCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubJson(urlOrPath, allowedStatuses = [200]) {
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${API_ROOT}${urlOrPath}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jam3gw-readme-stats-updater",
    },
  });

  if (!allowedStatuses.includes(response.status)) {
    const body = await response.text();
    throw new Error(`${response.status} ${url}: ${body.slice(0, 300)}`);
  }

  if (response.status === 204) {
    return { data: null, headers: response.headers, status: response.status };
  }

  const text = await response.text();
  return {
    data: text ? JSON.parse(text) : null,
    headers: response.headers,
    status: response.status,
  };
}

function nextPageFromLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function paginate(urlOrPath) {
  const items = [];
  let next = urlOrPath;

  while (next) {
    const separator = next.includes("?") ? "&" : "?";
    const url = next.includes("per_page=") ? next : `${next}${separator}per_page=100`;
    const { data, headers } = await githubJson(url);
    items.push(...data);
    next = nextPageFromLink(headers.get("link"));
  }

  return items;
}

async function getAuthenticatedLogin() {
  try {
    const { data } = await githubJson("/user");
    return data.login;
  } catch {
    return null;
  }
}

async function listReposForOwner(owner, authenticatedLogin) {
  const { data: ownerInfo } = await githubJson(`/users/${owner}`);
  let repos = [];

  if (ownerInfo.type === "Organization") {
    repos = await paginate(`/orgs/${owner}/repos?type=all`);
  } else {
    repos = await paginate(`/users/${owner}/repos?type=owner`);

    if (authenticatedLogin?.toLowerCase() === owner.toLowerCase()) {
      const privateOwnedRepos = await paginate(
        "/user/repos?affiliation=owner&visibility=all",
      );
      repos.push(...privateOwnedRepos);
    }
  }

  return repos.filter((repo) => !repo.fork);
}

async function getContributorStats(fullName) {
  if (statsCache.has(fullName)) return statsCache.get(fullName);

  const attempts = Number(process.env.STATS_API_RETRIES || 6);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`${API_ROOT}/repos/${fullName}/stats/contributors`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jam3gw-readme-stats-updater",
      },
    });

    if (response.status === 200) {
      const data = await response.json();
      statsCache.set(fullName, data);
      return data;
    }

    if (response.status === 202) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep((retryAfter || Math.min(attempt * 2, 10)) * 1000);
      continue;
    }

    if ([204, 404, 409].includes(response.status)) {
      statsCache.set(fullName, null);
      return null;
    }

    const body = await response.text();
    throw new Error(
      `${response.status} ${fullName} stats/contributors: ${body.slice(0, 300)}`,
    );
  }

  statsCache.set(fullName, null);
  return null;
}

function sumContributorWeeks(contributor) {
  return contributor.weeks.reduce(
    (total, week) => ({
      additions: total.additions + week.a,
      deletions: total.deletions + week.d,
    }),
    { additions: 0, deletions: 0 },
  );
}

async function getRepo(fullName) {
  if (repoCache.has(fullName)) return repoCache.get(fullName);
  const { data } = await githubJson(`/repos/${fullName}`);
  repoCache.set(fullName, data);
  return data;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

function sanitizedGitError(stderr) {
  return stderr
    .replaceAll(token, "<redacted>")
    .replaceAll(encodeURIComponent(token), "<redacted>")
    .replace(/https:\/\/x-access-token:[^@]+@/g, "https://x-access-token:<redacted>@");
}

async function gitFallbackStats(repo) {
  if (process.env.STATS_ENABLE_GIT_FALLBACK === "false") {
    return { commits: 0, additions: 0, deletions: 0 };
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "readme-stats-"));
  const target = path.join(tempRoot, repo.full_name.replace("/", "__"));
  const cloneUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo.full_name}.git`;

  try {
    const cloneArgs = ["clone", "--quiet"];
    if (repo.default_branch) {
      cloneArgs.push("--branch", repo.default_branch, "--single-branch");
    }
    cloneArgs.push(cloneUrl, target);

    let clone = spawnSync("git", cloneArgs, {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });

    if (clone.status !== 0 && repo.default_branch) {
      await rm(target, { recursive: true, force: true });
      clone = spawnSync("git", ["clone", "--quiet", cloneUrl, target], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
    }

    if (clone.status !== 0) {
      console.warn(
        `Skipping git fallback for ${repo.full_name}: ${sanitizedGitError(
          clone.stderr.trim(),
        )}`,
      );
      return { commits: 0, additions: 0, deletions: 0 };
    }

    const hasHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    });

    if (hasHead.status !== 0) {
      return { commits: 0, additions: 0, deletions: 0 };
    }

    const commits = Number(
      runGit(["rev-list", "--count", "HEAD", `--author=${authorPattern}`], target).trim() ||
        0,
    );

    const numstat = runGit(
      ["log", "HEAD", `--author=${authorPattern}`, "--numstat", "--pretty=tformat:"],
      target,
    );

    const lines = numstat.split("\n").reduce(
      (total, line) => {
        const [added, deleted] = line.split("\t");
        if (/^\d+$/.test(added) && /^\d+$/.test(deleted)) {
          total.additions += Number(added);
          total.deletions += Number(deleted);
        }
        return total;
      },
      { additions: 0, deletions: 0 },
    );

    return { commits, ...lines };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function getUserStatsForRepo(repo) {
  const contributors = await getContributorStats(repo.full_name);

  if (contributors) {
    const contributor = contributors.find(
      (entry) => entry.author?.login?.toLowerCase() === username.toLowerCase(),
    );

    if (!contributor) {
      return { commits: 0, additions: 0, deletions: 0 };
    }

    const weeks = sumContributorWeeks(contributor);
    return {
      commits: contributor.total,
      additions: weeks.additions,
      deletions: weeks.deletions,
    };
  }

  return gitFallbackStats(repo);
}

async function getDefaultBranchCommitCount(fullName) {
  const contributors = await getContributorStats(fullName);

  if (contributors) {
    return contributors.reduce((total, contributor) => total + contributor.total, 0);
  }

  const repo = await getRepo(fullName);
  const sha = encodeURIComponent(repo.default_branch || "HEAD");
  const response = await fetch(
    `${API_ROOT}/repos/${fullName}/commits?sha=${sha}&per_page=1`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jam3gw-readme-stats-updater",
      },
    },
  );

  if (response.status === 409) return 0;
  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(`${response.status} ${fullName} commits: ${body.slice(0, 300)}`);
  }

  const link = response.headers.get("link");
  const lastPage = link?.match(/[?&]page=(\d+)>;\s*rel="last"/)?.[1];
  if (lastPage) return Number(lastPage);

  const commits = await response.json();
  return commits.length;
}

function floorTo(value, unit) {
  return Math.floor(value / unit) * unit;
}

function formatCommits(value) {
  return `${floorTo(value, 10).toLocaleString("en-US")}+`;
}

function formatLines(value) {
  if (value >= 1_000_000) {
    return `${(Math.floor(value / 10_000) / 100).toFixed(2)}M+`;
  }

  if (value >= 1_000) {
    return `${Math.floor(value / 1_000)}K+`;
  }

  return `${value}+`;
}

function parseDisplayedNumber(value) {
  const cleaned = value.replace(/[,+]/g, "").trim();
  if (cleaned.endsWith("M")) return Number(cleaned.slice(0, -1)) * 1_000_000;
  if (cleaned.endsWith("K")) return Number(cleaned.slice(0, -1)) * 1_000;
  return Number(cleaned);
}

function currentDisplayedStats(readme) {
  const commitMatch = readme.match(/│\s*([0-9,.KM+]+)\s+commits \(personal \+ work\)\s*│/);
  const additionsMatch = readme.match(/│\s*([0-9,.KM+]+)\s+lines of code added\s*│/);
  const touchedMatch = readme.match(/│\s*([0-9,.KM+]+)\s+total lines touched\s*│/);

  return {
    commits: commitMatch ? parseDisplayedNumber(commitMatch[1]) : 0,
    additions: additionsMatch ? parseDisplayedNumber(additionsMatch[1]) : 0,
    touched: touchedMatch ? parseDisplayedNumber(touchedMatch[1]) : 0,
  };
}

function statsBoxLine(value, label) {
  return `  │${`${value.padStart(8)}  ${label}`.padEnd(42)}│`;
}

function updateProjectCount(readme, fullName, count) {
  const repoLink = `](https://github.com/${fullName})`;
  const start = readme.indexOf(repoLink);
  if (start === -1) {
    console.warn(`Could not find featured project link for ${fullName}`);
    return readme;
  }

  const end = readme.indexOf("</td>", start);
  if (end === -1) {
    console.warn(`Could not find featured project cell for ${fullName}`);
    return readme;
  }

  const before = readme.slice(0, start);
  const projectCell = readme.slice(start, end);
  const after = readme.slice(end);

  return `${before}${projectCell.replace(
    /\*\*[\d,]+ commits\*\*/,
    `**${count.toLocaleString("en-US")} commits**`,
  )}${after}`;
}

async function main() {
  const authenticatedLogin = await getAuthenticatedLogin();
  const repoMap = new Map();

  for (const owner of owners) {
    console.log(`Listing repos for ${owner}`);
    const repos = await listReposForOwner(owner, authenticatedLogin);
    for (const repo of repos) {
      repoMap.set(repo.full_name, repo);
      repoCache.set(repo.full_name, repo);
    }
  }

  let totals = { commits: 0, additions: 0, deletions: 0 };
  let activeRepos = 0;

  for (const repo of [...repoMap.values()].sort((a, b) =>
    a.full_name.localeCompare(b.full_name),
  )) {
    const stats = await getUserStatsForRepo(repo);
    totals.commits += stats.commits;
    totals.additions += stats.additions;
    totals.deletions += stats.deletions;

    if (stats.commits || stats.additions || stats.deletions) {
      activeRepos += 1;
      console.log(
        `${repo.full_name}: ${stats.commits} commits, ${stats.additions} additions, ${stats.deletions} deletions`,
      );
    }
  }

  const touched = totals.additions + totals.deletions;
  console.log(
    `Totals from ${activeRepos} active repos: ${totals.commits} commits, ${totals.additions} additions, ${touched} touched`,
  );

  let readme = await readFile("README.md", "utf8");
  const current = currentDisplayedStats(readme);

  if (
    process.env.STATS_ALLOW_DECREASE !== "true" &&
    (totals.commits < current.commits ||
      totals.additions < current.additions ||
      touched < current.touched)
  ) {
    console.warn(
      "Computed totals are lower than the README. Leaving README unchanged; the token may not have access to private/work repos.",
    );
    return;
  }

  readme = readme
    .replace(
      /^  │.*commits \(personal \+ work\).*│$/m,
      statsBoxLine(formatCommits(totals.commits), "commits (personal + work)"),
    )
    .replace(
      /^  │.*lines of code added.*│$/m,
      statsBoxLine(formatLines(totals.additions), "lines of code added"),
    )
    .replace(
      /^  │.*total lines touched.*│$/m,
      statsBoxLine(formatLines(touched), "total lines touched"),
    );

  for (const fullName of featuredProjects) {
    const count = await getDefaultBranchCommitCount(fullName);
    readme = updateProjectCount(readme, fullName, count);
  }

  await writeFile("README.md", readme);
}

await main();
