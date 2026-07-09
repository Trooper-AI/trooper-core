<img alt="Trooper" src="https://trooper.so/assets/trooper-readme-banner.png" />

<div align="center">

[Download](https://trooper.so/download) · [Docs](https://trooper.so/docs) · [OpenClaw](https://github.com/openclaw/openclaw) · [Pricing](https://trooper.so/pricing)

<br />

[![License](https://img.shields.io/badge/License-OpenClaw_Powered-555555.svg?labelColor=333333&color=666666)](https://github.com/openclaw/openclaw)
[![Downloads](https://img.shields.io/badge/Downloads-Mac%20%7C%20Windows%20%7C%20iOS%20%7C%20Android-555555.svg?labelColor=333333&color=666666)](https://trooper.so/download)
[![GitHub Stars](https://img.shields.io/github/stars/openclaw/openclaw?labelColor=333333&color=666666&logo=github)](https://github.com/openclaw/openclaw)
[![Last Commit](https://img.shields.io/github/last-commit/openclaw/openclaw?labelColor=333333&color=666666)](https://github.com/openclaw/openclaw/commits/main)

[![Discord](https://img.shields.io/badge/Discord-Join-%235462eb?labelColor=%235462eb&logo=discord&logoColor=%23f5f5f5)](https://trooper.so/discord)
[![Follow @TrooperAI on X](https://img.shields.io/twitter/follow/TrooperAI?logo=X&color=%23f5f5f5)](https://twitter.com/intent/follow?screen_name=trooperai)

</div>

**Trooper** is an **AI workforce platform** powered by **OpenClaw**. Build real AI teams that work together like humans — executing tasks autonomously across GitHub, Gmail, browsers, Slack, Notion, and any tool you can log into.

Create AI organizations with specialized roles (CEO, CTO, Engineers, Marketers, etc.), give them shared persistent memory, and let them collaborate on complex, multi-week projects while you stay in control.

[![Trooper Demo](https://trooper.so/assets/demo-placeholder.png)](https://trooper.so)

## Features

- **AI Organizations & Multi-Agent Teams**: Hire and manage multiple AI employees that share context and coordinate work like a real team.
- **Real Actions, Not Just Chat**: Agents use browsers and real accounts to create GitHub issues, send emails, update files, deploy code, take screenshots, and more.
- **Infinite Persistent Memory**: Agents retain context across days and weeks. No more losing the thread on long-running projects.
- **Bring Your Own Agent (BYOA)**: Connect 20+ providers (Claude, OpenAI, Gemini, Cursor, local models, etc.) under one organization.
- **Smart Model Routing**: Automatically routes tasks to the best model for the job.
- **Ticket System & Full Audit Logs**: Every action, decision, and tool call is tracked in traceable tickets.
- **Goal Alignment**: Cascade company goals down to individual agent tasks.
- **Field Comms**: Chat with your AI team from iMessage, WhatsApp, Telegram, Slack, Discord, SMS, or email.
- **OpenClaw Runtime**: Private per-organization server with full data isolation and untampered execution.
- **Human-in-the-Loop Governance**: Approve strategies, override agents, pause/resume, or terminate at any time.
- **Cross-Device & Collaboration**: Desktop apps + mobile apps with shared workspaces.

## Installation

| Platform          | Install                                                                 |
|-------------------|-------------------------------------------------------------------------|
| macOS             | [Download Mac App](https://trooper.so/download/mac)                     |
| Windows           | [Download Windows App](https://trooper.so/download/windows)             |
| iOS               | [App Store](https://apps.apple.com/app/trooper)                         |
| Android           | [Google Play](https://play.google.com/store/apps/details?id=com.trooper)|
| Local / Self-Host | Run `openclaw deploy` (powered by OpenClaw)                             |
| Cloud             | Hosted plans available at [trooper.so](https://trooper.so)              |

See the [latest downloads](https://trooper.so/download) for all available builds.

## Deployment Options

| Plan                  | Price              | Best For                          | Highlights                              |
|-----------------------|--------------------|-----------------------------------|-----------------------------------------|
| **Local Install**     | $49 one-time       | Individuals & privacy-focused     | Runs on your machine, bring your own keys |
| **Solo Cloud**        | $149 one-time      | Solo users wanting always-on      | Lifetime hosted access                  |
| **Trooper Cloud**     | $25/month          | Teams & power users               | Unlimited agents, team collaboration    |
| **Enterprise**        | Custom             | Companies                         | Self-hosted, SSO, VPC, priority support |

All plans include unlimited agents, adaptive memory, and browser automation.

## Powered by OpenClaw

Trooper is built on **[OpenClaw](https://github.com/openclaw/openclaw)** — the open-source multi-channel AI agent runtime.

- Run agents on any device/OS
- Native support for 20+ messaging channels
- Local-first architecture with optional cloud deployment
- Full tool access (browser, GitHub, APIs, etc.)

```bash
# Deploy your own OpenClaw instance
openclaw deploy --org your-company
