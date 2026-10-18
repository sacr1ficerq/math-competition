# Math Competition

Two-player mathematics duels with proof-based solutions, Markdown/LaTeX, screenshot
attachments, and OpenRouter grading. A room keeps its two players, sandwich score,
chat, and completed rounds while the players move on to fresh problems.

## Run locally

Requires Python 3.11 or newer:

```sh
uv sync --locked
uv run run.py
```

Open **http://127.0.0.1:9000**. Alternatively, install `requirements.txt` in a virtual
environment and run `python run.py`. `make run` and `make test` remain available.
Edit `config.yaml` for the address, SQLite database, grading model, timeout, and proxy.
The supplied configuration uses `http://127.0.0.1:12334` as its grading proxy; set
`grading.proxy` to `null` if no explicit proxy is needed.

On Linux with a user systemd session, keep the server running independently of
your terminal (with automatic restart on failure):

```sh
sh scripts/local-server.sh start
sh scripts/local-server.sh status
sh scripts/local-server.sh logs
# After changing Python code or config:
sh scripts/local-server.sh restart
# Stop explicitly:
sh scripts/local-server.sh stop
```

This is a local user service, not a deployment or a boot-time startup service.

## Play a duel

1. Register or sign in. Your identity and problem history follow your account across
   browsers and devices. Existing anonymous rooms in the current browser are linked
   when you register or sign in, unless that would merge the room's two opponents.
2. A grading model is already selected by default. You can replace the default in
   account settings for new rooms and practice; existing rooms retain their shared
   model. Your OpenRouter key is needed only when sending work for checking, not
   when creating, inviting, confirming readiness, or writing a proof.
3. Choose **Create duel** or **Join**. Creation immediately opens a room without
   asking for a topic, problem, or model. Joining accepts a code or room link.
4. Copy the visible invitation URL in the room and send it to your opponent. Task
   selection is always visible here before the first and every next round:
   **Random**, **By topic**, or **Custom task**. Both confirm readiness before the condition is revealed. A bank problem is
   selected at this point and is new to both.
5. Write a proof or attach screenshots, then submit for background grading. You can
   continue writing and submit a revised solution while checking is in progress.
6. Finish your work explicitly. If the editor contains a new version, **Submit and
   finish** accepts that submission and finalizes atomically. Finishing an unchanged,
   already-submitted version does not create another attempt. Surrendering sends no
   editor content; previously submitted work still counts.
7. The first finalization gives the opponent five minutes. Once both have finalized
   and all checks finish, the result reveals solutions and feedback. Appeals become
   available only at this point.
8. **Next problem** requires confirmation from both participants; either can
   withdraw before the other confirms. Submitting an appeal clears both
   confirmations, and its review must finish before confirming again.
   The transition keeps the room, players, invitation, chat, and cumulative score.
   In the lobby the creator can keep or change the topic, select any topic, or upload
   a custom problem. Both players confirm readiness again.

A task win awards **one sandwich**. Grades out of ten are separate from this match
counter. Equal final scores are resolved by earlier **final submission completion**,
not by when work was sent for grading. Identical clock readings use server acceptance
order, so new rounds do not draw. Automatic finalization uses the exact deadline.

The room creator can close a room with confirmation. Closing keeps saved drafts,
submitted work, chat, and results available for reading, but blocks joining and all
further play. Already accepted grading jobs can finish without reopening the room.

Each participant can remove a room from their own recent-room list and undo that
action. This preference does not close the shared room or erase results, messages,
or task-exposure history. A hidden room remains readable through its direct link.

Completed-round reviews have their own address, `/s/CODE?round=N`, with separate
work, grading, appeal, and reference views. Previous rounds open as read-only
archives; the current finished round retains its appeal window.

## Problems and practice

Keyboard controls: `Ctrl/⌘ K` opens action search, `?` shows shortcuts, and `Esc`
closes the current panel. Outside text fields, `C` toggles chat, `I` focuses the
solution, `G H` opens home, and `G B` opens the bank. In the bank, `J/K` selects
cards and `Enter` opens the selected task. `Ctrl/⌘ Enter` checks the solution
from its editor. Single-letter shortcuts can be disabled in the action menu.

The task bank is loaded from `problems/*.json`. Each task has a stable identity and
content revision. Topic selection excludes the union of both players' exposure
histories across every room and practice, including tasks merely opened without a
successful solution. Selection, both exposure records, and round start share one
SQLite transaction; retries cannot reveal a second task for the same round.

When no common unseen tasks remain, choose another topic or add tasks. There is no
automatic fallback to repeats. The elementary demonstration tasks have been retired; bank content is maintained
as separately reviewed problem files.

The bank contains 386 original SHAD-style problems: 77 algorithms, 72 linear algebra,
68 analysis, 64 probability, 53 data analysis, and 52 combinatorics. Every problem
has a reference proof and grading rubric, with independent review records in
`problems/reviews/`. These are preparation exercises, not official examination
questions. Research sources and verification caveats are recorded in
[`docs/shad-source-catalog.json`](docs/shad-source-catalog.json).

Check the published bank with:

```sh
uv run python scripts/validate_problem_bank.py --require-reviewed --verify-review-hashes --min-active 386
```

This checks release metadata, formatting, and exact content hashes against full independent
mathematical reviews; it does not automatically prove the mathematics. Archive task mappings
are in [`docs/source-task-analogy-matrix.json`](docs/source-task-analogy-matrix.json),
with syllabus coverage and its remaining limits in
[`docs/shad-syllabus-coverage.json`](docs/shad-syllabus-coverage.json).
Coverage of the reviewed public archive does not guarantee every future examination variant.

Account databases, sessions, passwords, saved provider keys, and installation encryption
keys are local runtime data and are excluded from the repository.

Practice is at `/practice`. Choose a topic and open a task; this records exposure.
Practice uses your saved key and default model and shows feedback immediately.
Drafts, including screenshots, are stored locally for recovery. Practice attempt
history currently lasts until the page reloads.

Custom problems can be entered directly in the lobby or practice form. JSON import
is optional (UTF-8, up to 150 KB); the form provides a downloadable template.
The reference solution is optional for custom problems and required for bank tasks.
Custom problem JSON contains:

```json
{
  "title": "Problem title",
  "statement": "Prove that $\\ldots$",
  "criterions": "Full and partial credit criteria.",
  "reference_solution": "A correct proof."
}
```

The author of a custom problem already knows its condition and reference solution.
Custom uploads are private room material, not automatically added to the shared bank.

To add a bank task, place its JSON in `problems/` with optional `id`, `topic`, and
`topic_label` metadata. Alternatively, add an entry to `problems/catalog.json`:

```json
{
  "problems": [
    {"file": "example.json", "id": "stable-example", "topic": "algebra", "topic_label": "Алгебра"}
  ]
}
```

Keep task IDs stable when correcting content. Old round snapshots remain unchanged;
revisions do not erase exposure history. Removed files retire their tasks. Restart
the server to synchronize an updated catalog.

## Grading and appeals

The room's model receives the original condition, grading criteria, reference, and
submitted text/screenshots. It returns validated reasoning, evidence, and a numeric
verdict between zero and ten. Alternative valid proofs are accepted by the prompt.
A request gets one initial attempt and up to five retries. Exhausted checks do not
count toward submission penalties.

The round score is:

```text
best effective submission verdict - max(0, successfully graded submissions - 1)
```

Scores may be negative. Failed checks do not incur a submission penalty. During play,
players see verdicts and their own submitted work; opponent solutions and detailed
feedback remain private until the round finishes. Unsubmitted drafts stay private.

After both participants finalize and all original checks finish, each participant
has **one decided appeal per problem in the round**, shared across all their
submissions. Additional grading attempts do not create additional appeal slots:

- Explain the grading error without editing or extending the submitted proof.
- The same model reviews the exact original work, verdict, and argument.
- A strictly higher reviewed verdict replaces the attempt's effective verdict.
- Otherwise that attempt loses exactly one point, including from zero to minus one.
- An appeal adds no submission-count penalty. Original and reviewed verdicts remain
  available in the audit history; an appeal verdict cannot itself be appealed.
- A technical failure leaves the score unchanged and permits a retry. Duplicate
  requests do not trigger additional reviews or score adjustments.

An appeal may change a completed current round's winner and move its one sandwich.
It never changes finalization timestamps. Pending reviews mark the result provisional
and block the next round. Archived rounds cannot be appealed.

## Editor and interface

- Simultaneous editor and preview on wide screens, with view switching on smaller
  screens; Markdown and KaTeX formulas (`$...$`, `$$...$$`,
  `\(...\)`, and `\[...\]`). Ctrl/Cmd+Enter sends a solution for checking.
- Up to four PNG/JPEG/WebP images per attempt, each at most 3 MiB and 20 megapixels.
  Upload or paste images; text is optional. The selected model must support images.
- Text drafts autosave to SQLite, with browser-local backups and explicit conflict
  handling between tabs. Screenshot drafts and accepted-payload metadata persist
  locally in IndexedDB so reloading does not cause duplicate submissions.
- Light, dark, and system appearance, remembered locally. The dark theme uses
  Rosé Pine colors; glass navigation, menus, and dialogs are separate from opaque
  proof surfaces. Reduced-transparency preference restores solid materials, and
  reduced-motion preference disables animations. Chat and archives are secondary views.
- `/solution` in chat reveals the reference after both players finalize, even while
  checks are still pending.

Rendering libraries currently load from jsDelivr, so initial rendering needs internet
access. The model catalog is fetched from OpenRouter without sending a user key;
results are cached, and provider/model can be entered manually if the catalog is
unavailable.

## Persistence and deployment

SQLite stores accounts, hashed sessions, room state, tasks, exposure history,
submissions, and appeals. OpenRouter keys are **encrypted at rest** with a separate
installation secret. The default secret file is
`$XDG_DATA_HOME/math-competition/account-key` or
`~/.local/share/math-competition/account-key`. Set `MATH_ACCOUNT_SECRET_FILE` to choose
another location. Back up the installation secret together with the database; do not
commit either. Explicitly deleting a key removes it; logout does not remove it.

Account sessions use opaque, hashed server-side tokens and HttpOnly, SameSite Strict
cookies, with Secure enabled over HTTPS. Passwords use salted scrypt hashes. API keys
are never returned through account responses or stored in localStorage. Logs omit
keys and submitted proof content.

Run a single server worker. Room changes use SQLite write transactions; polling is
currently every 1.2 seconds, with deadlines enforced by server time and a background
ticker. Graceful shutdown waits for accepted checks. A forced restart marks interrupted
checks and appeals failed without a score penalty; completed data remains available.

## Code and checks

| Module | Responsibility |
| --- | --- |
| `app/accounts.py`, `app/account_api.py` | Accounts, sessions, preferences, encrypted keys |
| `app/problem_bank.py`, `app/problem_api.py` | Catalog, exposure history, unseen selection |
| `app/competition.py` | Atomic duel transitions, scoring, appeals, round history |
| `app/api.py`, `app/main.py` | HTTP routes and grading lifecycle |
| `app/grading.py`, `app/solutions.py` | Provider requests, validated verdicts and images |
| `static/` | Shared components, accounts, themes, duel and practice interfaces |

```sh
uv run python -m unittest discover -s tests -v
```

Provider calls are mocked in backend tests. Coverage includes identity and privacy,
legacy migration, encryption, task exclusion, transaction retries, finalization,
appeals, failures/restarts, score recalculation, and model preferences. API reference
is available at `/docs`. Release history is in [CHANGELOG.md](CHANGELOG.md).
