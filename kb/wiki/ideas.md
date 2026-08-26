---
name: ideas
description: Things considered but not built, with enough of the reasoning that picking one up does not start from scratch.
type: reference
---

# Ideas

Not a backlog and not a promise. Things said out loud that are worth not losing, each with
whatever was already worked out about it. Newest first.

---

## Theme music for the JRPG skin — muted by default (Evan, 2026-08-26)

**His words:** *"I have half a mind to make it have a default muted JRPG theme when you choose
that theme."*

Status: **an idea he is weighing, not a decision.** Nothing built.

Two things already known that a future session should not have to rediscover:

- **Muted-by-default is not just courtesy, it is the only shape that works.** Every browser
  blocks audio that starts on its own without a user gesture; a page that tries is either
  silenced or, worse, silently not-silenced on the one machine with the permission granted.
  Starting muted with a control to unmute is the only version that behaves the same
  everywhere — so his instinct and the constraint happen to agree.
- **It cannot be inlined the way everything else is.** A tour has to open from `file://` with
  no network, so CSS, scripts and skins are all embedded. Audio is far too large for that: a
  minute of even modest ogg is hundreds of kilobytes against a page that is already ~3.8MB of
  source. It would have to be an asset the app serves (like the hero photograph) and simply be
  absent from a static export — which makes it a feature of the app, not of a saved tour.

The licensing question is the same one the hero photograph answered: downloaded, attributed
in `assets/*/credits.json`, never hotlinked.

