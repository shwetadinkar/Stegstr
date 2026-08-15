# Engineering log

The detailed engineering log for this work — every platform measurement, what
was tried and rejected and why, and the reasoning behind each shipped default —
is kept in a separate private repository rather than here.

Code comments reference it by section, as "the engineering log §17.3".

**Why it is not in this repository.** It is a working document: contest terms,
priorities, competitive assessment, and blunt notes on what failed. Some of that
should not be published under this account while the contest is running, and
none of it is needed to build, run or evaluate the software.

**What is public, and is enough to evaluate the work:**

- [`CHANGES.md`](CHANGES.md) — what this fork changes against upstream, with the
  measurements behind each decision
- [`benchmarks/results/RESULTS.md`](benchmarks/results/RESULTS.md) — reproducible
  via `npm run bench`
- The code comments, which carry the reasoning at the point it applies

Nothing about the technique is withheld. The platform geometry, the step sizes,
the failure modes and the limitations are all documented in `CHANGES.md`.
