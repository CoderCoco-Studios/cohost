---
title: Contributing
description: How to send a change to cohost, from signing the contributor agreement to opening a pull request.
track: project
---

# Contributing

Contributions are welcome. By contributing you offer your work to the public
under [AGPL-3.0-only](license.md).

## Sign the CLA

Before a pull request can merge, everyone who authored a commit in it must have
accepted the
[Individual Contributor License Agreement](https://github.com/CoderCoco-Studios/cohost/blob/main/CLA.md).
You keep the copyright in your work. The agreement gives CoderCoco a licence to
it, including the right to relicense, which is what makes the commercial licence
possible.

1. Open your pull request. The `cla` check comments on it and fails until every
   author has signed.
2. Read the CLA, then post this exact comment on the pull request:
   `I have read the CLA Document and I hereby sign the CLA`
3. The check records your signature and passes. Comment `recheck` if it does not
   re-run on its own.

You sign once; later pull requests from the same GitHub account pass. Commit
with an email address linked to your GitHub account, because commits are matched
by author email. Co-authors named only in a `Co-authored-by:` trailer are not
checked automatically, so ask each of them to sign on the pull request too.

The CLA is for individuals. If you are contributing for an employer or another
organisation, open an issue first so a suitable agreement can be arranged.

## Make the change

- Work on a branch, never on `main`, and open a pull request against `main`.
- Changes start from the design: read [How specs work](spec-driven.md), then walk
  the arrow of intent (design, specs, tests, code) for the part you are changing.
- Mark code and tests with `@spec` comments naming the spec lines they cover.
- Run the tests with `pnpm test` before you push.

The terms themselves are in
[CONTRIBUTING.md](https://github.com/CoderCoco-Studios/cohost/blob/main/CONTRIBUTING.md).
