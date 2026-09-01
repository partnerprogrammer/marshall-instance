# Marshall — Partner Programmer's AI team member

**This repository is a fork of [NanoClaw](https://github.com/nanocoai/nanoclaw).** Almost everything in it is upstream code, not ours. This file exists to orient anyone landing here for the first time.

## What this repo actually is

This is the *running code* for Marshall, PP's AI team member (Slack, ClickUp, GitHub, etc.). It's a fork, not our own project, kept this way on purpose: it lets us see and review any change we make to the core code, instead of that code changing invisibly with no history.

**What's actually ours here** (everything else is untouched NanoClaw):
- `src/modules/thread-nudge/` and `thread-nudge-feedback/` — a custom moderation feature (public replies that point a stray message toward the thread it should have been in).
- The `.claude/skills/add-thread-nudge*` skills that install the above.
- Small fixes and conformance work layered on top over time.

## Where the rest of Marshall lives

This repo is only the core engine. Marshall's actual behavior — persona, skills, ClickUp/GitHub/Slack tooling, everything that makes it *Marshall* and not just a bare NanoClaw install — lives in a separate repo:

**[`pp-brain/projects/marshall-assistant`](https://github.com/partnerprogrammer/pp-brain/tree/main/projects/marshall-assistant)** — start there for anything about what Marshall does or says. Its `CLAUDE.md` has the full picture, including:
- How to check if Marshall is responding, and how to restart it
- How updates flow from that recipe into this running instance
- **How updates flow into *this* repo specifically** — see its "NanoClaw core updates" section

## The short version, if you only read one thing

- To change what Marshall *does* (skills, persona, tools) → go to `marshall-assistant`, not here.
- To change NanoClaw's *core* (rare) → this repo, but read `marshall-assistant/CLAUDE.md`'s update section first — there's a step that's easy to miss and it will take Marshall offline if skipped.
- Don't edit the root `README.md` here — that's upstream's, keeping it untouched avoids merge conflicts on every future sync.
