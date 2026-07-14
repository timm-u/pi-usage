# pi-usage

> [!IMPORTANT]
> **This repository is archived and no longer maintained.**
>
> Please use the actively maintained successor:
> **[mtrojnar/pi-usage](https://github.com/mtrojnar/pi-usage)**

## Continued development

[Michał Trojnara](https://github.com/mtrojnar) took the original `pi-usage` project forward and evolved it into a substantially more advanced, capable, secure, and useful extension.

The maintained successor adds support for more providers, a modular architecture, extensive tests, safer authentication and network handling, passive usage updates, and numerous reliability and user-experience improvements.

I am sincerely grateful to Michał for investing the time and care to continue the project, preserve its history and attribution, and turn it into something far beyond the original implementation. Thank you also to everyone who starred, forked, contributed to, or used this repository.

## Installation

Install the maintained version:

```bash
pi install git:github.com/mtrojnar/pi-usage
```

Or add it to your pi `settings.json`:

```json
{
  "packages": ["git:github.com/mtrojnar/pi-usage"]
}
```

For documentation, support, issues, and future contributions, visit:

**https://github.com/mtrojnar/pi-usage**

## About this repository

This repository contains the original implementation of `pi-usage`, a usage-limit checker extension for the [pi coding agent](https://github.com/badlogic/pi-mono). It displayed Codex and OpenCode Go usage limits at startup.

It remains available as a read-only historical record under the MIT License. Existing users should migrate their installation URL to `git:github.com/mtrojnar/pi-usage`.
