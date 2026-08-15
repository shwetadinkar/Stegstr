# Documents

Historical working documents. The current, maintained documentation is:

- [`../README.md`](../README.md) — how to use the app
- [`../CHANGES.md`](../CHANGES.md) — what this fork changes against upstream, with the measurements
- [`../REVIEW.md`](../REVIEW.md) — what to check when reviewing changes here
- [`../skill/stegstr/SKILL.md`](../skill/stegstr/SKILL.md) — using Stegstr from an AI agent
- [`../IDENTITY_AND_EMBED.md`](../IDENTITY_AND_EMBED.md) — how identities and embedding interact
- [`../CI.md`](../CI.md) — workflows and what they build

## What is in here

| Document | Status |
|---|---|
| [WHATSAPP_PLAN.md](WHATSAPP_PLAN.md) | Upstream's plan for surviving WhatsApp. **Historical.** Its own log records QIM passing the simulator and failing on a real phone — the cause was the simulator using a quantization table whose *shape* differed from WhatsApp's. That finding is why this fork extracts real tables from returned files. |
| [robust_stego_options.md](robust_stego_options.md) | Survey of embedding methods considered. **Historical**, and describes options not taken, including LSB. |
| [robust_comparison.md](robust_comparison.md) | Encoder × channel pass/fail matrix from the simulator. **Historical**; superseded by real-device measurement, which is what the shipped profiles are built from. See CHANGES.md §1. |

These are kept because they record what was tried and why it was rejected,
which is often more useful than the conclusion. They are **not** descriptions of
what the app does now.

> This folder previously also held ~3,700 lines of
> [actionlint](https://github.com/rhysd/actionlint)'s own manual, inherited from
> upstream and unrelated to this project. Removed — it is maintained by its own
> authors, and finding a Go linter's documentation in a steganography repository
> is a poor use of a reader's attention.
