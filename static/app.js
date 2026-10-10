"use strict";

const $ = (id) => document.getElementById(id);
let config;
let customProblem = null;
let pending = false;
const submissions = [];
let solutionImages;

const render = window.renderMarkdown;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function updateButton() {
  $("submit").disabled = !config || pending || solutionImages.busy || (!$("solution").value.trim() && !solutionImages.value.length) || !$("api-key").value.trim();
  solutionImages.setDisabled(pending || !config);
}

function updateScore() {
  const grades = submissions.filter((s) => s.counted && s.grade);
  const penalty = Math.max(0, grades.length - 1);
  const best = grades.length ? Math.max(...grades.map((s) => s.grade.verdict)) : 0;
  $("score").querySelector("strong").textContent = Number((best - penalty).toFixed(2));
  $("score-help").textContent = `Best verdict: ${best}. Counted submissions: ${grades.length}. Penalty: ${penalty}.`;
}

function addSubmission(result, solution, images) {
  submissions.push(result);
  $("history-empty").hidden = true;
  const entry = document.createElement("details");
  entry.className = "submission";
  entry.open = true;
  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.textContent = `Submission ${submissions.length}`;
  const time = document.createElement("time");
  time.dateTime = result.submitted_at;
  time.textContent = new Date(result.submitted_at).toLocaleTimeString();
  time.title = new Date(result.submitted_at).toLocaleString();
  const verdict = document.createElement("span");
  verdict.className = "verdict";
  verdict.textContent = result.grade ? `${result.grade.verdict} / 10` : "Failed · no penalty";
  summary.append(label, time, verdict);
  const feedback = document.createElement("div");
  feedback.className = "feedback";
  const section = (title, text) => {
    const heading = document.createElement("h3");
    heading.textContent = title;
    const body = document.createElement("div");
    body.className = "rendered";
    render(body, text);
    feedback.append(heading, body);
  };
  if (result.grade) {
    section("Reasoning", result.grade.reasoning);
    section("Evidence", result.grade.evidence);
  } else {
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = result.error;
    feedback.append(error);
  }
  section("Submitted solution", solution || "Solution provided in screenshots.");
  window.appendSolutionImages(feedback, images);
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${result.attempts} grading attempt${result.attempts === 1 ? "" : "s"} · ${result.counted ? "Counts toward score" : "Excluded from submission count"}`;
  feedback.append(meta);
  entry.append(summary, feedback);
  $("history").prepend(entry);
  updateScore();
}

async function submit(event) {
  event.preventDefault();
  if ($("submit").disabled) return;
  const solution = $("solution").value;
  const images = solutionImages.value;
  pending = true;
  updateButton();
  $("submit").textContent = "Grading…";
  $("problem-file").disabled = true;
  status("Grading your solution. Invalid responses and inference errors are retried up to five times; this can take several minutes.");
  try {
    const response = await fetch("/api/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: $("api-key").value.trim(), solution, images, problem: customProblem }),
    });
    const result = await response.json();
    if (!response.ok) {
      const detail = typeof result.detail === "string" ? result.detail : result.detail?.map((error) => error.msg).join("; ");
      throw new Error(detail || `Request failed (${response.status}). Check the input and try again.`);
    }
    addSubmission(result, solution, images);
    status(result.counted ? "Grading complete. Your feedback is below." : result.error, !result.counted);
  } catch (error) {
    status(`${error.message} No submission penalty was applied.`, true);
  } finally {
    pending = false;
    $("submit").textContent = "Submit solution ↗";
    $("problem-file").disabled = false;
    updateButton();
  }
}

async function loadProblem(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 150_000) throw new Error("Problem JSON must be smaller than 150 KB.");
    const problem = JSON.parse(await file.text());
    const fields = { title: 300, statement: 30000, criterions: 30000, reference_solution: 30000 };
    if (!problem || Array.isArray(problem) || typeof problem !== "object") throw new Error("Expected a JSON object.");
    if (Object.keys(problem).some((key) => !(key in fields))) throw new Error("Problem JSON contains unknown fields.");
    for (const [key, max] of Object.entries(fields)) {
      if (typeof problem[key] !== "string" || !problem[key].trim() || problem[key].length > max) {
        throw new Error(`Provide a nonempty ${key} string (at most ${max} characters).`);
      }
    }
    customProblem = problem;
    $("problem-title").textContent = problem.title;
    render($("problem-statement"), problem.statement);
    submissions.length = 0;
    $("history").replaceChildren();
    $("history-empty").hidden = false;
    $("solution").value = "";
    solutionImages.clear();
    render($("preview"), "Your proof takes shape here.");
    updateScore();
    updateButton();
    $("problem-error").hidden = true;
    status("Problem loaded. A fresh practice run is ready.");
  } catch (error) {
    $("problem-error").textContent = error.message;
    $("problem-error").hidden = false;
  } finally {
    event.target.value = "";
  }
}

async function init() {
  if (!window.marked || !window.DOMPurify || !window.katex) {
    status("Rendering libraries could not load. Check your internet connection and reload the page.", true);
    return;
  }
  solutionImages = new window.SolutionImages($("solution-images"), $("image-attachments"), $("solution"), updateButton, status);
  solutionImages.setDisabled(true);
  $("solution").addEventListener("input", () => {
    render($("preview"), $("solution").value || "Your proof takes shape here.");
    updateButton();
  });
  $("api-key").addEventListener("input", updateButton);
  $("toggle-key").addEventListener("click", () => {
    const visible = $("api-key").type === "password";
    $("api-key").type = visible ? "text" : "password";
    $("toggle-key").textContent = visible ? "Hide" : "Show";
    $("toggle-key").setAttribute("aria-pressed", String(visible));
    $("toggle-key").setAttribute("aria-label", visible ? "Hide API key" : "Show API key");
  });
  $("submit-form").addEventListener("submit", submit);
  $("solution").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submit(event);
  });
  $("problem-file").addEventListener("change", loadProblem);
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Unable to load the problem. Reload to try again.");
    config = await response.json();
    $("problem-title").textContent = config.problem.title;
    render($("problem-statement"), config.problem.statement);
    $("model").textContent = config.model;
    updateButton();
  } catch (error) {
    status(error.message, true);
  }
}

init();
