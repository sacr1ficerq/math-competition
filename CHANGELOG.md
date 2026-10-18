# Changelog

## [Unreleased]

### Fixed

- Corrected mathematical notation in 217 task statements; all 240 original conditions
  pass KaTeX rendering checks. Historical rounds receive exact presentation-only
  corrections without changing grading inputs.
- Removed competing width limits from the task condition workspace.

### Added

- Expanded the independently reviewed bank to 386 tasks with full solutions and
  rubrics, public archive traceability, and bounded syllabus-gap additions.
- Exact full-review hash validation rejects content modified after review.
- Light sandwich-themed copy on the home page, score tooltips, and results.

- Keyboard action search, discoverable shortcuts, and optional single-letter
  navigation that stays inactive while typing.
- An illustrated victory podium with a one-time award animation, name-only
  participants, translucent surfaces, and coordinated hover/focus states.

- Personal room-list removal with undo, preserving shared results and exposure history.
- Dedicated completed-round review addresses, including read-only archived rounds.

- Persistent accounts with remembered sessions, legacy-session linking, and encrypted
  OpenRouter keys shared across devices.
- Topic-based task bank with permanent exposure history; each duel task is unseen
  by both players, including tasks previously opened in practice.
- One appeal per participant and problem round: a higher reviewed score is adopted; otherwise
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

- Advancing rounds requires both participants to confirm. Either can withdraw;
  submitting an appeal resets both confirmations. Appeal drafts survive reload,
  block their author's confirmation, and withdraw it when editing resumes.

- Rebuilt the home artwork with four independent pointer-responsive layers;
  reduced-motion and touch devices keep a static composition.
- Reorganized the duel lobby around both players, the series score, and one
  connected task/readiness area, including the guest view of subsequent rounds.
- Restored whole-card problem selection without redundant action text.
- Moved custom duel authoring into a separate dialog, kept editor layout stable
  when opening the reserved desktop chat column, and separated review sections
  into dedicated views instead of a combined inline archive.
- Review shows the current appealed verdict, with the original verdict retained
  as history. Catalog metadata now includes localized subtopics without exposing
  unseen conditions or marking tasks as viewed.

- Appeal eligibility shares one per-player round budget across every submission;
  technical failures allow retry. Result labels distinguish appeal reductions
  from repeat-submission penalties without subtracting either twice.
- Desktop chat reserves a nonmodal side column; mobile uses a dedicated screen.
  The round deadline has a readable countdown with subdued urgency thresholds.

- Published 240 independently reviewed SHAD-style problems, 40 per subject, with
  reference proofs, scoring rubrics, and per-file audit records. A read-only
  validator checks publication metadata and formatting; preparation sources are
  recorded separately from authored exercises.
- Custom problems support direct form input and an optional reference solution;
  JSON import remains available with a downloadable template.

- Retired the four elementary demonstration problems from new bank selections;
  existing round snapshots and participant exposure records remain intact.

- Pointer feedback is limited to the home artwork; button press states and
  result reveals respect reduced-motion preferences and avoid polling replays.

- Active rounds use one compact shared scoreboard and a rebuilt proof workspace,
  with proportional text, tonal editor/preview surfaces, and consistent controls.
- Room creators can close a room with confirmation while preserving read-only
  history. Accepted checks can finish, but no new actions or rounds can start.

- A local systemd user-service helper keeps the development server independent
  of terminal/tool sessions, with restart-on-failure and journal-based logs.

- The home screen introduces a native vector mathematical arena with paired
  foam/iris materials, a glass action panel, and a finite entrance animation.
  The lobby and winner podium share its spatial surfaces; reduced-motion and
  reduced-transparency preferences preserve a stable, readable interface.

- Shared visual direction across the home, lobby, editor, task catalog, and
  account sheets: open layouts, paired participant identities, grouped tasks,
  and a two-place winner podium with a once-per-round motion reveal.

- Submission history uses a compact attempt navigator and one reading surface
  instead of stacked cards. Submitted work is visible immediately; final feedback
  and appeals appear after the round finishes.

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
