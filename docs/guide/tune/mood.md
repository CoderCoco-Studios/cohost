---
title: Mood
description: How the co-host's mood moves, fades and shows up in its face, voice choices and chattiness, and how to nudge its resting mood.
track: simple
verified: f126b94
---

# Mood

The co-host has a mood. A good chat moment lifts it, something sad drags it down, and left alone it drifts back to its resting mood. This page explains how that works and how to change the resting mood, so you can have a sunny co-host or a deadpan one.

## What you need

- A running co-host. See [Try it with no accounts](../install/first-run.md).
- Optionally an [avatar](../connect/avatar.md), so you can see the mood on a face.

## How the mood works

A part of the co-host called [affect](../../start/glossary.md#affect) keeps the mood as two numbers, called [valence and arousal](../../start/glossary.md#valence-arousal):

- **Valence** is how good or bad it feels, from unhappy to happy.
- **Arousal** is how much energy it has, from flat to buzzing.

Every line of chat or speech nudges the pair a little. A subscriber's message, a change on screen and the co-host's own happy or sad lines each move it. The built-in appraiser (the `rules` kind) is plain heuristics and needs no model.

Then time pulls it back. A mood swing fades half way to the resting mood every `half_life_ms` (45000, so 45 seconds). The nearest of the co-host's emotions (neutral, happy, laugh, surprised, smug, sad, angry, confused, think) is published as the current mood.

The mood changes three things:

- **The face.** The avatar wears the current mood as its resting face between lines.
- **The words.** The [cortex](../../start/glossary.md#cortex) gets a one-line description of the mood in each prompt, so a cheerful co-host writes cheerful lines.
- **The chattiness.** A high arousal lowers the bar for speaking by up to `arousal_bias`; see [When it talks](talkativeness.md).

Mood is not remembered between runs and needs no database. Every start begins at the resting mood.

## Change the resting mood

The keys live under `brain.affect` in `config/config.yaml`; the dashboard's **Settings** screen edits them and keeps your comments.

| Key | Default | What it does |
| --- | --- | --- |
| `baseline_valence` | 0.15 | The resting happiness. Above 0 is sunny; below 0 is gloomy. |
| `baseline_arousal` | 0.1 | The resting energy, from 0 to 1. |
| `half_life_ms` | 45000 | How quickly a mood swing fades. Raise it for a co-host that sulks or gloats longer. |
| `nudge_sub_valence`, `nudge_sub_arousal` | 0.05 | The nudge from a subscriber's chat line. |
| `nudge_screen_arousal` | 0.08 | The nudge from a change on screen. |
| `nudge_said_valence`, `nudge_said_arousal` | 0.08, 0.05 | The nudge from the co-host's own line. |
| `publish_ms`, `republish_ms` | 2000, 15000 | How often the mood is announced while moving, and when it is unchanged. |

Settings take effect when the affect service restarts; after a save the page offers to restart it.

::: aside
A baseline of 0.15 means I am slightly pleased with everything. You can set it to negative. I will pretend not to notice.
:::

## Let a model judge the mood

By default the mood moves by simple rules. You can ask a model instead, which understands a joke better than a rule does. The appraiser is a [hook](../../start/glossary.md#hook): set `brain.affect.module.kind` to `llm` (one chat call to a model, optionally a small and fast one) or `http` (your own server). If the model fails, the co-host falls back to the rules, so a flaky hook never silences it. The [Brain hooks page](../../advanced/extend/hooks.md) has the details, and [Choose a model](model.md) shows how to give a hook a smaller model than the cortex.

## How you know it worked

- With an avatar connected, the face changes between lines. Without one, the **Avatar** card on the dashboard's Live screen shows the current emotion under the face.
- The [bus](../../start/glossary.md#bus) **Activity** feed on the **Live** screen shows the mood announcements. The [dashboard tour](../operate/dashboard.md) says where.

## If it didn't

- The face never changes: check that the avatar driver is set up ([Avatar](../connect/avatar.md)) and that `affect` is `up` on the [service health page](../operate/health.md).
- A setting seems ignored: it applies when affect restarts. See [Starting and stopping](../operate/start-stop.md), and [Troubleshooting](../troubleshooting.md).
