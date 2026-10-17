# Changelog

## [Unreleased]

### Added

- Persistent accounts with remembered sessions, legacy-session linking, and encrypted
  OpenRouter keys shared across devices.
- Topic-based task bank with permanent exposure history; each duel task is unseen
  by both players, including tasks previously opened in practice.
- One appeal per original verdict: a higher reviewed score is adopted; otherwise
  the attempt loses exactly one point. Provider failures leave the score unchanged.
- Light, dark, and system themes, shared account settings, and recoverable image drafts.
- Saved account model preference with a cached OpenRouter model catalog and manual
  provider/model fallback when the catalog is unavailable.
- Atomic submission with finalization, and bank practice grading using the saved key.

- `/solution` chat command that posts the reference solution once both players have
  finalized, even while grading is pending, with Markdown/LaTeX rendering and a round label.
- Same-session rematches with retained players, API-key cookies, chat, and invite link.
- Cumulative sandwiches (one per task win), round numbers, and private archived round history.
- Optional new-problem loading in the rematch lobby, with readiness reset on changes.
- Round-aware actions that reject delayed submissions, finalizations, and draft saves
  from earlier rounds; repeated rematch clicks start only one new round.
- Screenshot attachments in competition and practice submissions, with file upload,
  clipboard paste, previews, removal, and image-only solutions.
- Multimodal grading that evaluates typed text and attached screenshots together.
- Persistent competition screenshots with authenticated participant access and
  opponent images withheld until the round finishes.
- Validation for up to four PNG, JPEG, or WebP screenshots per submission, with
  per-image limits of 3 MiB and 20 megapixels.
- Grading lifecycle logs and visible finalization timestamps, with clearer messaging
  when finalizing without a submission or while grading is pending.

### Changed

- Appeals become available only after both players finalize and all original
  checks finish; the server rejects attempts to appeal during solving or grading.

- Room creation is now one action with no task or model questions. A permanent
  invitation URL and copy action lead the one-player lobby; task selection exists
  only in the room, and readiness becomes the primary action after joining.
- The configured default model appears independently of the model catalog.
  Missing provider keys no longer block invitations, readiness, or proof editing;
  key setup is requested in the context of checking a solution.
- Dark appearance uses Rosé Pine with translucent navigation/floating materials,
  opaque proof surfaces, and reduced-transparency fallbacks.
- State-specific home, lobby, editor, and results screens with equal Create/Join
  actions, consistent controls, separate authentication/preferences/appearance,
  accessible topic selection, and reduced-motion-aware transitions.
- Wide proof workspaces show the editor and live preview together; small screens
  retain view switching. Task upload is confined to task selection.
- Both players' submitted solutions and screenshots are revealed when a round
  finishes, including in previous-round history. Unsubmitted drafts remain private.
- Equal final scores now use the earlier finalization timestamp as the tie-break.
  Identical timestamps use server acceptance order, so new rounds always have a winner;
  automatic finalization uses the deadline.
- Successful appeals recalculate the current round winner and move its sandwich
  without changing finalization times. Pending appeals block the next round.
- Bank rematches select a fresh task, with topic and custom-task changes available
  in the same room before both players confirm readiness.
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
