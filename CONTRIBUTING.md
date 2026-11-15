# Contributing to Engine Sound Lab

Thanks for taking an interest. This project is developed inside a private
mono repo and published here, which shapes a couple of the rules below —
please read the last section before opening a PR.

## Getting set up

**Stack:** static HTML, CSS and JavaScript (ES modules and an AudioWorklet), with no build
step and no runtime dependencies. The checks and tooling need Node.js 22; the recording
analysis and the preset generator need Python 3.

```bash
git clone https://github.com/geoffmyers/engine-sound-lab.git
cd engine-sound-lab
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Any static file server works.

## Checks

<!-- CHECKS:START -->
Every push and pull request runs these checks in GitHub Actions
([`.github/workflows/checks.yml`](.github/workflows/checks.yml)), and every release has passed them.
To run one yourself, use the same commands from the directory shown.

**site** (Node.js 22, from the repository root):

Every local file a page refers to exists, every script (inline or not) parses, and the Worker configuration deploys in a dry run with `npx wrangler@4 deploy --dry-run`; the script is in the workflow.

**engine, drivetrain and calibration** (Node.js 22, from the repository root):

```bash
npm run check
```

<!-- CHECKS:END -->

Before pushing, also open the page in a desktop browser and on a phone, start an engine, rev
it, drive it through the gears and listen. No check can tell you whether it sounds right.

## Changing the real-vehicle presets

The 42 real presets in `engine-data.json` (marked `"real": true`) are **generated**: edit the
sourced research in `research/2026-11-15-*.json` or the modelling choices and labelled
estimates in `research/preset-modelling.json`, then run:

```bash
python3 scripts/build-real-presets.py          # rewrite them
python3 scripts/build-real-presets.py --check  # exit 1 if engine-data.json is stale
```

A new figure needs a source you have actually read; anything estimated goes in `estimates`
with its reason, and the page will say it is estimated.

## Before you open a pull request

- Keep the change focused. One concern per PR is much easier to review.
- Match the surrounding style rather than introducing a new one. There is no
  separate style guide; the existing code is the guide.
- Keep numbers in `engine-data.json`, not in the code.
- Keep the site dependency-free unless there is a strong reason. No build step
  is part of the design.
- Update the README if you change behaviour a user can see.
- Explain **why** in the commit message, not just what. The diff already says
  what changed.

## Reporting a bug

Open an issue with what you did, what you expected, and what happened instead.
The browser, its version and the device help more than anything else. For a sound that is
wrong, the preset and settings, and a WAV from **Render WAV**, help most.

## Security

Please do **not** open a public issue for a security problem. Report it
privately through GitHub's *Report a vulnerability* button on the Security tab.

## How this repo is published

This project lives in a private mono repo. Each publish adds **one commit** on
top of the history here, so the history grows with every release, but one
commit here can stand for many upstream changes. As a result, pull requests
are reviewed here and applied upstream, then arrive back in the next published
commit, which credits your authorship in its message. The pull request is
closed with a link to that commit rather than merged, because the next publish
is built from the upstream tree and would undo a change made only here.

## Licence

By contributing you agree that your contribution is licensed under the same
terms as this project — see [LICENSE.md](LICENSE.md).
