# Build modes: hybrid, reuse, craft

How the agent decides whether to write code or import it.

Switch from the model menu (**Build**, per project) or **Dual Agent: Set Build Mode**.

- **Hybrid** (the default) decides part by part:
  1. Use what the project already has.
  2. Use a well-known library for anything security-sensitive.
  3. Add a package for big or fast-moving needs.
  4. Write small pieces.
  5. Import medium ones through the vetted code tool when that's clearly cheaper.
  6. Write the core logic itself.
- **Reuse** looks for established open-source code first. A new file over about 30 lines is refused until the agent has searched.
- **Craft** writes everything.

The agent asks before bringing code in, and every import is vetted:

- **Before fetching:**
  - The license must allow copying. Copyleft code goes only into a project with a compatible license, per file for MPL-2.0, and unlicensed code never. Non-commercial, no-derivatives, source-available and unreviewed licenses are refused. A file's own header overrides the project's.
  - Archived projects, forks, very new projects and accounts, and lookalike names are refused.
  - A trust score, shown on the card, weighs maintenance, OpenSSF Scorecard, contributors, tests, CI, adoption and issue activity; suspected star inflation lowers it. There is no minimum: the findings decide.
- **Fetching:** a source archive (up to 30 MB) pinned to one commit, fetched anonymously into a git-ignored folder. Nothing in it is installed or run. Path escapes, links to outside files, executables and archive bombs are refused.
- **Malware scan:** every file is checked for install hooks, editor tasks that run on open, decode-then-execute, hidden Unicode, credential theft and planted secrets. Critical findings block the import; medium and high ones need your approval on the card.
- **Untrusted input:** the agent reads fetched code only with read-only tools, so instructions hidden in it can't steer the agent.
- **Your approval:** you approve each import on a card showing the license and the findings.
  - Imported files get a license header comment.
  - The license goes into `THIRD_PARTY_NOTICES.md`, and the project, commit and file hashes into `THIRD_PARTY_PROVENANCE.json`.
  - In Bypass mode, imports with findings are refused.

Searching uses web search plus deps.dev, and GitHub's search API only when those find nothing. Vetting makes about 7 GitHub requests per project (the archive itself isn't rate-limited). Without a token, GitHub allows 60 requests an hour; past that, vetting falls back to deps.dev and accepts only well-known projects (100+ stars), and the card says "limited vetting". A `GITHUB_TOKEN=…` line in the credentials file raises the limit to 5,000 an hour.
