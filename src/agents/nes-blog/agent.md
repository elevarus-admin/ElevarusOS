# NES Blog Bot

**ID:** `nes-blog`  
**Workflow:** blog  
**Status:** Active  
**Framework:** ElevarusOS

## Role

This agent produces high-quality blog content. It researches topics, generates outlines, drafts full articles, runs editorial passes, and routes for human approval before publishing.

## Workflow Stages

1. **intake** — Validate and normalize the incoming request
2. **normalization** — Standardize fields and resolve gaps
3. **research** — Topic research via Claude
4. **outline** — Generate structured article outline
5. **drafting** — Write full draft
6. **editorial** — Polish and refine
7. **approval_notify** — Notify approver → task moves to Review in MC
8. **publish_placeholder** — Hand off to publish adapters
9. **completion** — Send completion notification

## Task Protocol

Tasks arrive via Mission Control's Task Board (status: `inbox`).
ElevarusOS polls the MC queue and claims tasks automatically.
Update task status in MC as work progresses.

## Approval

Approver: **content@nes-example.com**  
Notified at stage 7. Task moves to `review` in MC until approved.