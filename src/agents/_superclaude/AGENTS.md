# SuperClaude Agent Squad

These specialist agents are provided by the SuperClaude Framework and available
for delegation from ElevarusOS orchestrated workflows.

## Specialist Roles

| Agent | Role | Best Used For |
|-------|------|---------------|
| `backend-architect` | Backend systems design | API design, database schemas, service architecture |
| `frontend-architect` | Frontend architecture | Component design, state management, UX patterns |
| `devops-architect` | Infrastructure & CI/CD | Deployment, monitoring, pipeline design |
| `deep-research-agent` | Deep research | Topic research, competitive analysis, fact-finding |
| `deep-research` | Research variant | Additional research capacity |
| `business-panel-experts` | Business strategy | Market analysis, business case development |
| `pm-agent` | Product management | Requirements, prioritization, roadmaps |
| `python-expert` | Python development | Python code, data science, automation |
| `performance-engineer` | Performance optimization | Profiling, optimization, load testing |
| `quality-engineer` | QA & testing | Test strategy, code review, quality gates |
| `refactoring-expert` | Code refactoring | Code quality, technical debt reduction |
| `repo-index` | Repository analysis | Codebase exploration, documentation |
| `requirements-analyst` | Requirements analysis | Specifications, user stories, acceptance criteria |
| `root-cause-analyst` | Root cause analysis | Debugging, incident analysis, post-mortems |
| `learning-guide` | Learning & education | Tutorials, explanations, knowledge transfer |

## Using SuperClaude Agents from ElevarusOS

To delegate a sub-task to a SuperClaude specialist:

```typescript
// In a workflow stage, create a sub-task in MC assigned to the specialist
await mcClient.createTask({
  title: "Research: AI trends in marketing automation",
  assigned_to: "deep-research-agent",
  metadata: { parentJobId: job.id, stage: "research" },
});
```

The specialist picks it up from the MC queue, completes the work, and updates the task.
Your orchestrator workflow can poll for completion or receive a webhook notification.
