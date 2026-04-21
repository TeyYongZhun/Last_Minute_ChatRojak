# Last Minute ChatRojak - System Planning

## Overview

This system is designed as a full workflow loop:

**New Messages -> Understand -> Plan -> Execute -> Monitor -> Re-plan**

It is intentionally **stateful, adaptive, and decision-driven**, not a static summarizer.

---

## Core Architecture (3 Task Modules)

### Task 1: Intelligent Message Understanding

#### Goal
Transform unstructured chat messages (e.g., WhatsApp exports) into structured task objects.

#### Input
- Raw text messages
- Chat exports

#### Output (Structured)
```json
{
  "tasks": [
    {
      "id": "t1",
      "task": "Submit Assignment 2",
      "deadline": "Friday 11:59pm",
      "assigned_by": "Lecturer",
      "priority": "high",
      "confidence": 0.94,
      "missing_fields": []
    }
  ]
}
```

#### AI responsibilities
- Detect actionable tasks
- Extract fields:
  - task description
  - deadline/time
  - assigned_by/source
  - urgency/priority
- Ignore irrelevant/noise messages

#### Edge-case handling
- Ambiguous message -> flag for clarification
- Missing deadline/time -> mark incomplete
- Low confidence extraction -> ask user to confirm

---

### Task 2: Multi-Step Workflow Planning & Decision Engine

#### Goal
Convert extracted tasks into actionable plans with priorities, conflict handling, and re-planning.

#### Planner I/O Contract

##### Input schema
```json
{
  "planning_input": {
    "now": "ISO_DATETIME",
    "tasks": [
      {
        "id": "t1",
        "task": "Submit Assignment 2",
        "deadline": "2026-04-24T23:59:00+08:00",
        "assigned_by": "Lecturer",
        "priority": "high",
        "confidence": 0.94,
        "missing_fields": []
      }
    ]
  }
}
```

##### Output schema
```json
{
  "planning_output": {
    "plans": [
      {
        "task_id": "t1",
        "priority_score": 92,
        "decision": "do_now",
        "steps": [
          "Check submission requirements",
          "Prepare final files",
          "Submit via portal",
          "Verify confirmation receipt"
        ],
        "conflicts": [],
        "missing_info_questions": [],
        "status": "pending"
      }
    ],
    "global_conflicts": [],
    "replan_events": []
  }
}
```

#### Decision engine pipeline
1. `ingest_tasks`
2. `normalize_time`
3. `score_priority`
4. `detect_conflicts`
5. `generate_steps`
6. `check_missing_info`
7. `emit_plan`

#### Priority scoring model
- **Urgency score**: based on deadline proximity
- **Importance score**: source + explicit priority + task semantics
- **Effort score**: estimated complexity/step count
- **Priority score**: weighted sum of urgency + importance + effort

#### Decision policy
- `priority_score >= 80` -> `do_now`
- `50-79` -> `schedule`
- `< 50` -> `defer`
- missing critical info -> `ask_user` + `blocked_waiting_info`

#### Conflict handling
- Detect overlapping time windows and same due slots
- Emit recommendation with rationale
- Example: "You have a clash. Recommend prioritizing assignment due earlier."

#### Missing information strategy
- For each missing critical field, generate one clear question
- Keep task in blocked status until response arrives
- Resume planning after information is provided

#### Dynamic re-planning
- Triggered whenever new tasks/messages arrive
- Recompute:
  - priority scores
  - conflict graph
  - step plans
  - decisions
- Emit `replan_events` for traceability

#### Planner pseudocode
```pseudo
function plan_workflows(input):
    now = input.now
    tasks = normalize_tasks(input.tasks)

    for task in tasks:
        task.urgency_score = score_urgency(task.deadline, now)
        task.importance_score = score_importance(task.assigned_by, task.priority, task.task)
        task.effort_score = estimate_effort(task.task)
        task.priority_score = weighted_sum(urgency, importance, effort)

        task.steps = generate_steps(task.task)
        task.missing_info_questions = build_missing_info_questions(task)
        if task.missing_info_questions not empty:
            task.decision = "ask_user"
            task.status = "blocked_waiting_info"

    conflicts = detect_conflicts(tasks)
    resolve_conflicts_with_recommendations(tasks, conflicts)

    for task in tasks:
        if task.status != "blocked_waiting_info":
            task.decision = pick_decision(task.priority_score, conflicts)

    return {
        plans: tasks_to_plan_objects(tasks),
        global_conflicts: conflicts,
        replan_events: []
    }
```

---

### Task 3: Workflow Execution & Action Management

#### Goal
Execute planned actions and maintain system state across time.

#### Simulated actions
- Add/update task in task store
- Set reminders
- Generate checklists
- Update task status (`pending`, `in_progress`, `blocked`, `done`)

#### Stateful memory
The system should persist:
- ongoing tasks
- completed tasks
- blocked tasks / pending clarifications
- latest decisions and replan events

#### Dashboard output example
```text
HIGH PRIORITY
- Submit Assignment 2 (Friday 11:59pm)

UPCOMING
- Meeting (Tomorrow 3pm)

NEED INFO
- Volunteer event (no date)
```

#### Failure handling
- Action/API failure -> retry with backoff
- Task incomplete -> notify user and keep open
- Missing info -> pause execution for that task

---

## End-to-End Loop for Demo/Judging

1. New message enters system
2. Task 1 extracts structured tasks
3. Task 2 builds plan + decisions
4. Task 3 executes/schedules actions
5. Monitor state and outcomes
6. Re-plan when new data arrives

This demonstrates:
- unstructured understanding
- multi-step reasoning
- dynamic orchestration
- adaptive behavior under uncertainty/failure

---

## Real-World Constraints

- No direct WhatsApp API integration
- Use chat export or manual input
- Reminders/calendar/notifications can be simulated APIs for demo purposes

---

## Why AI Is Essential

Without AI, the system loses:
- robust extraction from messy text
- adaptive prioritization and conflict resolution
- dynamic workflow coordination under changing context

