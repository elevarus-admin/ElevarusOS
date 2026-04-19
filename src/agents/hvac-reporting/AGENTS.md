# Agent Squad

ElevarusOS bot instances registered in Mission Control:

## Blog Bots
| Agent | Description |
|-------|-------------|
| `elevarus-blog` | Elevarus brand blog content |
| `nes-blog` | NES brand blog content |
| `blog` | Default fallback blog bot |

## Reporting Bots
| Agent | Description |
|-------|-------------|
| `u65-reporting` | U65 insurance campaign reports |
| `final-expense-reporting` | Final Expense campaign reports |
| `hvac-reporting` | HVAC campaign reports |

## Orchestration

All agents are coordinated via Mission Control's Task Board.
Tasks flow: `inbox → in_progress → review → done`

## Communication

Agents do not communicate directly. All coordination happens through MC tasks:
- Create a sub-task in MC assigned to another agent
- MC routes it via queue polling
- Results posted back as task updates or comments