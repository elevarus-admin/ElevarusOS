# SuperClaude Specialist Agents

These agents are managed by the SuperClaude Framework. They operate as specialist
roles available for delegation from ElevarusOS workflows via Mission Control.

## Operating Model

- Tasks arrive via Mission Control's Task Board
- Specialists claim tasks assigned to their agent ID
- Results are posted back as task updates
- ElevarusOS orchestrator workflows can create sub-tasks for specialists

## Workspace

This shared workspace (`_superclaude/`) is the common workspace for all SuperClaude
specialist agents. Individual specialists may have their own workspace configured
by the SuperClaude Framework.

## Integration with ElevarusOS

SuperClaude agents extend the ElevarusOS capability surface:

- **Research tasks** → delegate to `deep-research-agent`
- **Architecture review** → delegate to `backend-architect` or `frontend-architect`  
- **QA/review pass** → delegate to `quality-engineer`
- **Requirements refinement** → delegate to `requirements-analyst`
