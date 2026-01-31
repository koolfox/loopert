Purpose

The Planner subsystem is the central reasoning engine of the agentic browser system.
Its job is to convert user goals and page context into structured, actionable plans that tools can execute.
Inspired by modern multimodal agent research (e.g., UI-TARS-1.5), the Planner supports think-then-act strategies that enable deep task reasoning and adaptive behavior.

Design Principles

Reason before action: Separate planning from execution.

Structured output: Plans must be unambiguous and machine-readable.

Multimodal foundation: Support reasoning over diverse inputs (text, structured UI context, vision/screen snapshots when available).

Flexible autonomy: Support a spectrum from manual to fully autonomous planning.

Tool abstraction: Planners recommend steps; tools perform them.

Architecture Overview
User Input
      ↓
Snapshot Collector
      ↓
Planner Engine(s)
      ↓
Tool Dispatcher
      ↓
Execution Drivers (Browser / OS / API)

Snapshot Collector captures structured UI context.

Planner Engine reasons about goals and context.

Tool Dispatcher invokes tools based on the plan.

Execution Drivers perform actions in the environment.

Planner Input Schema

Planners always receive structured data:

{
  "goal": "string",
  "context": {
    "page": {
      "url": "string",
      "origin": "string",
      "title": "string",
      "interactables": [
        {
          "id": "string",
          "role": "string",
          "type": "string",
          "label": "string",
          "locatorHint": "string"
        }
      ]
    },
    "visual": {
      "screenshot": "base64?",
      "visionFeatures": {}
    }
  },
  "capability_profile": "assisted|semi_auto|auto",
  "tool_catalog": [
    { "name": "string", "schema": "zod", "risk_level": "low|medium|high" }
  ]
}

Planners may optionally use vision/visual inputs to improve context understanding and grounding, inspired by multimodal agents that combine perception and action models.

Planner Output Schema

The Planner must ALWAYS return structured plans:

{
  "reasoning_summary": "string",
  "plan_id": "string",
  "autonomy_level": "assisted|semi_auto|auto",
  "steps": [
    {
      "tool": "string",
      "args": {},
      "explanation": "string",
      "estimated_risk": "low|medium|high",
      "confidence": "float(0–1)"
    }
  ]
}

reasoning_summary: free-text explanation of planner logic.

steps: ordered actions for the executor.

confidence: planner’s numerical confidence in this step.

Invalid outputs must be rejected and retried with repair logic.

Planner Engines

The system must support pluggable planners:

Ollama Adapter

Default local LLM engine.

OpenAI-compatible API shape.

Configurable host + model.

Future Adapter Hooks

OpenAI providers

Claude-compatible

Vision + multimodal models

Custom research agents

Each adapter must implement:

generatePlan(input) → Promise<PlannerOutput>

Validation and sanitization of outputs.

Retry logic for invalid responses.

Planner Execution Logic

Planners should follow a think-then-act strategy:

Perceive: Interpret structured snapshot + optional visuals.

Reason: Generate a high-level understanding of the goal and environment.

Plan: Propose a sequenced set of tool actions.

Explain: Provide natural-language explanation per step.

Estimate risks & confidence: Support adaptive execution.

This mirrors advanced agent designs that use reasoning traces before actions.

Tool Vocabulary

Planners may reference only registered tools:

Tool Purpose
navigate(url) Change page
click(id) Click element
type(id, text) Input text
scroll(deltaY) Scroll viewport
wait_for_idle(ms) Wait for idle
snapshot() Refresh context
click_point(point{x,y}) Click by screen coordinates (tap)
drag(from{ x,y }, to{ x,y }, durationMs?) Drag or swipe between coordinates
long_press(point{x,y}, durationMs?) Press-and-hold at a point
hotkey(keys[]) Send chorded keys
fetch(url, …) HTTP fetch with optional method/body/headers
read_file(path) Read local file
write_file(path, content) Write local file
shell(cmd) Run OS shell command (high risk; profile-gated)
Any future tool Registered via schema

Tools are registered with:

name

argument schema (e.g., zod)

metadata (risk level, description)

Planners must reference tools by name only.

Capability Profiles

Planner autonomy is controlled by profiles:

assisted: user confirms every step

semi_auto: batch confirmation allowed

auto: planner recommends, system may run autonomously
unleashed: high-autonomy; enables high-risk tools (shell/write_file) and coordinate actions by default

Planner outputs must include autonomy_level to communicate intended control behavior.

Vision & Visual Grounding (Optional)

Where supported, planners may receive:

screenshots

bounding box metadata

vision features extracted by a vision model

This allows higher fidelity reasoning over visual UI — similar to UI-TARS-style multimodal understanding.

Use visual data only when explicitly enabled via profile/config.

Failure & Retry Behavior

If a planner produces:

invalid JSON

references to unknown tools

steps outside current context

Then the system should:

Attempt prompt repair once

If still invalid, return a structured error

Optionally ask for clarification

Logging & Auditing

For every planning call, record:

input snapshot

planner output

reasoning summary

confidence scores

execution outcome mapping

This supports:

debugging

performance analysis

user trace

model evaluation

Plan Execution Loop

Execution must follow:

collect snapshot → planner → validate output → human review (if needed) → tool dispatch → result snapshot → next loop

This iterative “sense→reason→act” loop comes from advanced agent frameworks.

Encouraged Extensions

After the core planner implementation:

train vision–action grounding

add memory/replay buffers

allow plan optimization via feedback

support multimodal planner inputs

These extensions reflect current agent research trends.

Summary

Your Planner is a central reasoning engine that:

Converts goals + context → structured plans

Allows vision/multimodal inputs

Outputs structured, schema-validated steps

Supports multiple agents and planners

Provides rich reasoning summaries

Supports DOM-grounded and coordinate-level actions (for visual grounding)

Profiles range from assisted to unleashed; higher profiles unlock high-risk tools (shell/write_file) and coordinate actions

Coordinate safety: points are rescaled to current viewport and clipped; invalid coords are skipped with logging.

BBox fallback: executor will use interactable bounding boxes to target click/drag/long_press when IDs/coords are missing; bboxes include centers to improve hit accuracy.
