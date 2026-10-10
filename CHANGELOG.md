# Changelog

## [1.0.0] - 2026-10-10

### Added

- Two-player competitions created from problem JSON, with invite links and codes,
  account-free joining, and remembered player identities.
- Shared model selection in the lobby and problem reveal after both players are ready.
- Markdown and LaTeX solution editors with live previews, private autosaved drafts,
  offline recovery, and cross-tab conflict resolution.
- OpenRouter grading through the OpenAI SDK, with Pydantic-validated reasoning,
  verdicts, and evidence; up to five retries after the initial attempt.
- Background grading, shared submission histories, private opponent solutions,
  and detailed feedback withheld until the competition ends.
- Submission penalties, negative scores, timestamp-based tie-breaks, and draws
  for identical timestamps or when neither player has a successful submission.
- Manual finalization, server-enforced five-minute deadlines, and results that
  wait for all eligible pending submissions to finish grading.
- Shared chat and SQLite persistence for sessions, drafts, submissions, and results.
- HttpOnly API-key cookies, with keys excluded from server-side persistence.
- End-of-competition reveal of grading criteria and the reference solution.
- Responsive dark Rosé Pine interface with animated hover details.
- Single-player practice mode at `/practice` with immediate feedback and in-memory keys.
- A sample quadratic equation problem in `problems/quadratic.json`.
- Makefile commands, uv project metadata and lockfile, setup documentation,
  and backend tests covering grading and competition rules.

### Defaults

- App address: `http://127.0.0.1:9000`.
- Grading model: GLM 5.3 Flash (`z-ai/glm-5.3-flash`).
- OpenRouter HTTP proxy: `http://127.0.0.1:12334`.
