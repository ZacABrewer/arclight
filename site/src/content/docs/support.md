---
title: Support
description: How to get help with Arclight and its companion apps, report a bug, or reach the project.
editUrl: false
tableOfContents: false
---

Arclight is a free, self-hosted, community project. Help comes from the documentation and from the issue tracker on GitHub. There is no paid support.

## 1. Search the docs

Most questions are already answered. Use the search box at the top of every page (press <kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>K</kbd>), or start with:

- [Troubleshooting](/docs/troubleshooting/): organised by symptom, with a section for every health check the app can raise.
- [FAQ](/docs/faq/): short answers to the most common questions.
- [Install guides](/docs/getting-started/install-other-platforms/) and the [first-run wizard](/docs/getting-started/first-run-wizard/).
- [Known limitations](/docs/qa/99-known-limitations/).

## 2. Open a GitHub issue

Bugs, problems and feature requests go to **[GitHub Issues](https://github.com/ZacABrewer/arclight/issues)**. Search the existing issues first; if yours is new, open one and include:

- the Arclight version (System > Status) and how you installed it (Docker on Linux, Synology, Unraid, the mobile app, ...);
- what you did, what you expected and what happened instead;
- relevant lines from the logs (System > Logs), or the debug report from System > Debugging.

Remove API keys, passwords, tracker passkeys, private addresses and anything else personal before you post. Issues are public.

## 3. Email

If you cannot use GitHub, or the question is about the website or the mobile apps' store listings, email **[support@moviemethat.com](mailto:support@moviemethat.com)**. Replies are best effort. Privacy questions and data requests go to **[privacy@moviemethat.com](mailto:privacy@moviemethat.com)**.

## Security vulnerabilities

Please do not report security problems in a public issue. Follow the [security policy](/legal/security/) for private disclosure.

## Mobile apps

The Arclight apps for iOS and Android (coming soon: Arclight Admin, the companion app, and later the Arclight player) are companions to your own server: they connect to the address you enter and show the Arclight interface it serves. Most app problems are server problems, so check that the server is reachable from your phone's network first ([Exposing it outside your home](/docs/getting-started/exposing-outside-home/)). For anything else, open an issue and mention the app, its version and your phone's OS version.
