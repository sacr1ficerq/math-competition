# Math Competition

A website where two players compete to solve the same math problem, writing their solutions in Markdown and LaTeX. An LLM grades submitted solutions and returns a verdict.

## Run the proof of concept

Requires Python 3.11 or newer.

With Make installed:

```sh
make install
make run
```

Use `make test` to run the backend tests, or `make help` to list commands.
You can also set up and run the app manually:

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

Open **http://127.0.0.1:9000**. Write a solution, enter your OpenRouter API key,
and click **Submit solution** (or press Ctrl/⌘ + Enter). Markdown and LaTeX render
live, including `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`. Rendering libraries are
loaded from jsDelivr, so the browser needs an internet connection.

The single-player implementation includes immediate reasoning, verdict, and evidence,
submission history, and the scoring formula below. Grading makes at most six attempts
with SDK retries disabled. Failed grading is excluded from the submission penalty.
The API key is held only in the current page and the grading request; it is not
saved in cookies, browser storage, or server files. Drafts and history are also
in-memory and reset on reload.

The default grading model is **GLM 5.3 Flash** (`z-ai/glm-5.3-flash`) via OpenRouter.
Grading requests use the HTTP proxy at `http://127.0.0.1:12334`, configured as
`grading.proxy` in `config.yaml`. Set it to `null` to disable the explicit proxy.
Edit `config.yaml` to set the model, timeout, retry delay, server address, and default
problem. Restart the server after configuration changes. The model must support
OpenRouter's `json_schema` structured output. Alternatively, use **Load problem JSON**
to start a fresh practice run with your own problem:

```json
{
  "title": "Your problem",
  "statement": "Prove that $\\ldots$",
  "criterions": "Describe full and partial credit.",
  "reference_solution": "A correct proof."
}
```

The default problem's grading criteria and reference solution are kept on the backend.
An uploaded JSON document is supplied by the player and sent with each grading request.
Only the title and statement appear in the problem panel.

Run the backend tests (mocked OpenRouter calls; no key needed):

```sh
python -m unittest discover -s tests -v
```

API documentation is available at `/docs`. Two-player sessions, readiness/finalization,
deadlines, chat, delayed feedback, and reconnection are future work described below.

## Competition flow

1. One player creates a session by supplying a JSON document containing the math problem definition, then shares an invite link or code with the other player.
2. Both players use the same grading model, selected in the lobby settings.
3. Both players click **Ready** before the problem is revealed and submissions become available.
4. Each player writes a solution using Markdown and LaTeX, then submits it for LLM grading.
5. A player explicitly clicks **Finalize** to lock further submissions and start the other player's five-minute submission deadline.
6. The other player finalizes manually or is automatically finalized when the deadline expires.
7. Once both players are finalized, wait for all eligible submissions to finish grading, then determine the result.

## Problem definition

The session creator supplies a JSON document with these fields:

- `title`: The problem title.
- `statement`: The problem statement.
- `criterions`: Free-form text describing the grading criteria, hidden from players until the competition ends.
- `reference_solution`: The reference solution for grading.

## Scoring and timing

- The LLM returns a numeric verdict from 0 to 10 points. A fully correct solution earns 10 points.
- The first submission is free. Each additional submission costs 1 point.
- A player's final score is their highest submission verdict minus the total submission penalty: `best_verdict - max(0, counted_submission_count - 1)`. Submissions that exhaust all grading retries are excluded from the penalty count.
- A player who never submits receives 0 out of 10 points.
- Scores can be negative, so a player with 0 points can beat a player with a negative score.
- Submission timestamps record when the solution is submitted, not when grading completes. Deadline eligibility is based on the submission timestamp.
- Players can finalize while grading is pending. Finalization uses submission timestamps rather than LLM response times; eligible pending submissions are still graded before the result is determined.
- If final scores are equal, compare each player's last submission timestamp. The earlier timestamp wins.
- Grading uses structured output validated with Pydantic, including a verdict constrained to the 0–10 range.
- Inference errors and invalid grading responses (such as malformed JSON or out-of-range verdicts) receive up to five retries after the initial attempt. If all retries fail, the submission incurs no penalty.

## Features

- **Shared sessions:** Both players can join the same session without an account. “Logging in” means joining a competition session.
- **API keys:** Players enter an OpenRouter API key after joining a session. The key is stored in cookies for later use.
- **Submission visibility:** Players can see each other's submission history, including verdicts and timestamps, but not the solutions themselves.
- **Chat:** Provide a shared chat where both players can exchange messages.
- **Delayed feedback:** LLM comments on solutions are hidden until the competition ends.
- **Reconnection:** Reconnecting preserves the player's identity, draft solution, submission history, chat, and competition state.

## Design

- Use the dark Rosé Pine theme.
- Reveal additional information on hover, with an animation for the reveal.
- Only use hover animations for elements that respond to hovering or clicking.
- Keep the page structure simple and minimal. Avoid elements that add no value, such as repetitive headings describing the page.

## Tech stack

- **Backend:** FastAPI.
- **LLM integration:** The OpenAI Python SDK calling the OpenRouter API.
- **Data validation:** Pydantic, including validation of structured LLM grading output.
- **Configuration:** YAML.
- **Frontend:** Any suitable framework; a build step is acceptable.
- **Rendering:** KaTeX for LaTeX and a Markdown rendering library.

## Proof of concept

Start with a single-player page for writing and grading solutions. Two-player sessions and chat will be added later.

### Solution editor

- Provide a solution input field.
- Render previously entered LaTeX lines and Markdown as a preview.
- Include a working submit button and an API key field.
- For the proof of concept, do not store the API key in cookies or persist it between sessions.

### Grading

- On submission, send the solution and problem statement to the LLM.
- Request structured JSON output containing `reasoning`, `verdict`, and `evidence`, and validate it with Pydantic.
- The `verdict` field is a numeric score from 0 to 10.
- Allow up to five retries after the initial attempt for inference errors or invalid grading responses. If all retries fail, do not apply a submission penalty.
- Display all three fields immediately in the proof of concept.

## Unresolved questions

### Competition rules and session setup

- How are ties handled if a player has no submissions or both last-submission timestamps are identical? Do submissions that exhaust all retries count for the tie-break?
- When is the reference solution revealed to players?

## Backlog

- **Image solutions:** Allow players to upload images as solutions for LLM grading.

### Appeals

Allow players to appeal a grading verdict for either their own solution or their opponent's submission.

Unresolved questions:

- How does a player submit an appeal, and what information must they provide?
- Does an appeal trigger another LLM review? If so, should it use the same model or a different one?
- Can players appeal during the competition, or only after solutions and feedback are revealed?
- How does a successful appeal affect verdicts, scores, and the competition result?
