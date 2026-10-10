# Changelog

## [Unreleased]

### Added

- Same-session rematches with retained players, API-key cookies, chat, and invite link.
- Cumulative player wins, draw counts, round numbers, and private archived round history.
- Optional new-problem loading in the rematch lobby, with readiness reset on changes.
- Round-aware actions that reject delayed submissions, finalizations, and draft saves
  from earlier rounds; repeated rematch clicks start only one new round.
- Screenshot attachments in competition and practice submissions, with file upload,
  clipboard paste, previews, removal, and image-only solutions.
- Multimodal grading that evaluates typed text and attached screenshots together.
- Persistent competition screenshots with authenticated author-only image access.
- Validation for up to four PNG, JPEG, or WebP screenshots per submission, with
  per-image limits of 3 MiB and 20 megapixels.
- Grading lifecycle logs and visible finalization timestamps, with clearer messaging
  when finalizing without a submission or while grading is pending.

### Changed

- Equal final scores now use the earlier finalization timestamp as the tie-break.
  Identical finalization timestamps are a draw; automatic finalization uses the deadline.
- Graceful server shutdown waits for accepted grading jobs to complete.

### Fixed

- Grading retries retain the original solution text and screenshots after invalid
  model output instead of sending the previous model response as the next submission.

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
