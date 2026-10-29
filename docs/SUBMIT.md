# Submitting Wheelcast to Squeekchain Genesis

For the repo owner. No prior blockchain experience assumed; every step is an
action you take in a browser or a commit you make. Budget about 15 minutes plus
the time it takes your demo host to build.

The submission has two passes on purpose:

1. you fill the form and save it, and Genesis gives you a **challenge line**;
2. you commit that line to the repo, then come back and let Genesis **verify** it.

The line proves you control the repository you submitted. Nothing is published
until verification passes.

> Wording in the Genesis interface changes from time to time. The labels below are
> what the form is expected to show; if a label reads slightly differently, pick the
> option that means the same thing. The order of the steps is stable.

## 0. Before you start

- [ ] The repository is **public** on GitHub. Verification reads it anonymously, so a
      private repo fails with a 403/404 no matter how good the code is.
- [ ] `README.md` renders on GitHub and `LICENSE` is present.
- [ ] You have a **demo URL** that opens without a login, over HTTPS, and actually
      loads data (not a blank page). GitHub Pages, Netlify or Vercel all work.
- [ ] `node verify.mjs` passes locally, so you know the demo is showing a green
      parity report rather than a wall of mismatches.
- [ ] A wallet you control, on a desktop browser, plus the X account you want
      associated with the submission.
- [ ] Node 22 if you want to run the verifier yourself (`node --version`).

Safety, before anything else: Genesis login is a **signature**, not a transaction.
It costs no gas and moves nothing. Nobody legitimate needs your seed phrase or
private key, and a request to "send" or "approve" a transfer during login is not a
login. If a prompt asks for a transaction, close it and start over.

## 1. Log in to Squeekchain Genesis

1. Open the Genesis site and choose to connect a wallet.
2. Pick your wallet, approve the connection, and select the network the page asks
   for. If it asks for Sepolia, switch to Sepolia first; the page usually offers a
   one-click switch.
3. Sign the login message. Read it before signing: it should be a plain text
   message from the site, with no gas, no value and no contract interaction.
4. **Link X.** Authorise the X account in the prompt and complete whatever
   confirmation the page shows. The account is part of your identity on Genesis;
   use one you can still post from later, because you may need it again if a
   submission is queried.
5. You should land on your dashboard with the wallet address and the linked handle
   visible. If either is missing, finish that step before continuing.

## 2. Go to the Code lane

From the dashboard, open the **Code** lane. This is the track for software built on
Squeekchain, as opposed to the other lanes (hardware, art, community, and so on).
Inside it you will see the available tracks for the current round.

## 3. Choose "Independent"

Pick **Independent**.

- *Independent* means the project is your own work, built against the public
  protocol, without being a fork of an official starter or a continuation of
  someone else's repository.
- If you are offered a choice between "Independent" and a guided/template track,
  take Independent: Wheelcast implements the protocol arithmetic itself, which is
  exactly what this track is for.

## 4. Fill the form

| Field | What to enter |
|---|---|
| Project name | `Wheelcast` |
| Public GitHub repo URL | `https://github.com/<your-account>/wheelcast` |
| Demo URL | `https://<your-account>.github.io/wheelcast/` (or your Netlify/Vercel URL) |
| How does this project use Squeekchain? | one of the three blurbs in section 8 |

Field notes:

- **Repo URL**: the canonical browser URL of the repository, no `.git` suffix, no
  `/tree/main` suffix, no trailing slash.
- **Demo URL**: the exact page a reviewer lands on. Open it in a private window
  first — if it asks for a login or shows a blank screen, fix that before saving.
- **The text field** needs at least 20 characters. All three blurbs are well over
  that, and all three are written for a protocol reviewer rather than for a
  marketing page.
- Do not paste a pitch. The reviewer is checking whether the project actually uses
  the protocol; specific claims about what your code does are worth more than
  adjectives.

## 5. Save, then copy the challenge

Save the submission. Genesis now shows:

- a **file path** inside your repository, for example `.squeekchain/challenge.txt`
  or a path of similar shape;
- a **single line** of text to put in that file.

Copy both somewhere safe — a note, a scratch file, anything. If the page offers a
copy button, use it; retyping the line by hand is the most common way to fail
verification.

If the tab is still open, you can also return to the submission later and the
challenge is shown again on its detail page.

## 6. Add the challenge line to the repo

1. In your local clone, create the file at **exactly** the path Genesis gave you.
   If the directory does not exist yet, create it. A leading dot in the path is
   normal and is not a typo.
2. Paste the line as the **last line** of that file. One line, no quotes, no
   indentation, no line wrapping, no "helpful" reformatting.
3. If the file already has content (for example a previous challenge), append the
   new line rather than replacing the old one, unless Genesis explicitly says to
   replace it.
4. Commit and push to the branch the repository shows by default (usually `main`):

   ```sh
   git add .squeekchain/challenge.txt
   git commit -m "Add Squeekchain Genesis challenge"
   git push
   ```

5. If the demo is hosted on GitHub Pages and the build is triggered by pushes,
   wait for the deployment to finish before you verify.

Check the file in the GitHub web UI after pushing. If GitHub shows the line
wrapped across two visual lines that is only the viewer; what matters is that the
file has a single newline-terminated line.

## 7. Verify

1. Return to the Genesis submission and choose **Verify** (or **Check**).
2. Genesis reads the file at the path it gave you, on the public default branch.
3. On success the submission moves to verified/submitted and you are done.

What the checks mean when they fail:

| Message | What actually happened | Fix |
|---|---|---|
| 404 / not found | Repo is private, the branch is wrong, or the path has a typo | Make the repo public, push to the default branch, re-copy the path |
| Line not found | The line was edited, wrapped, quoted, or committed to a different file | Paste the exact string again on its own line |
| Not yet visible | Pages/build not finished, or GitHub cache | Wait a minute, hard-refresh, verify again |
| Signature expired | The challenge has a validity window | Re-open the submission and generate a fresh challenge |
| Demo URL unreachable | Host is down, or the page requires login | Open it in a private window and fix hosting first |

Do not open a second submission to work around a failed verification. Fix the
first one; duplicate submissions are usually rejected or merged by hand.

## 8. Three candidate blurbs for "How does this project use Squeekchain?"

Pick one. They differ in emphasis, not in claims. All three are 60-140 words.

**A. Parity first (recommended for a protocol reviewer)**

```text
Wheelcast is an independent verifier for Squeekchain's on-chain record. On load it
reads /v1/core for the current SqueekCore address, deployment block and initial
difficulty, pulls every RoundRecorded event with eth_getLogs, decodes the logs by
hand, and replays the whitepaper's integer rules: blockUnits += floor(w * 10^12 / D),
the one-thirtieth difficulty update, and height = floor(blockUnits / 10^9). Each
round's derived cumulativeBlockUnits and workPerThousandBlocks is compared against
the value SqueekCore actually emitted. The result is a public parity report rather
than a dashboard: 71 rounds checked, 0 mismatches at the time of writing. Because the
arithmetic is implemented from the paper and not called from the contract, a
mismatch means the deployment and the document disagree.
```

**B. Live view and forecast**

```text
Wheelcast turns Squeekchain's public API and Sepolia logs into a live instrument
panel: current wheel activity, the open round, settled rounds, cumulative work,
block units, height and the difficulty in force. It keeps the whole event history in
the browser, so it can also forecast: it resamples observed per-round work in a Monte
Carlo loop to estimate when the next Squeek block completes and how difficulty will
drift as a result. Every number on screen is tied to the round that produced it, and
the same page shows the replay that reproduces the contract's totals, so the forecast
sits next to the evidence rather than on top of it.
```

**C. Trust argument**

```text
For a protocol reviewer, the interesting part of Wheelcast is what it refuses to
trust. It does not import the contract's ABI, does not call a helper view for block
units, and does not take settlement totals from the API as given. It decodes
RoundRecorded logs itself, starts from the deployment's initialWorkPerThousandBlocks,
and recomputes cumulative block units and difficulty with the whitepaper's exact
integer expressions, in BigInt, one round at a time. Divergence is reported per round,
not smoothed away. The same check runs outside the browser: node verify.mjs, no
dependencies, exits non-zero on any mismatch. When SqueekCore is redeployed, the tool
follows the new address from /v1/core and replays it again.
```

## 9. What a reviewer will do, and where the evidence is

| They will check | Where it lives |
|---|---|
| The check is real and reproducible | `node verify.mjs` prints `PARITY OK n/n rounds, height h` and exits 0 |
| Nothing is hardcoded to one deployment | the core address and deployment block come from `/v1/core` at runtime |
| The arithmetic matches the paper | `README.md`, "The parity check", including the pre/post-round difficulty ordering |
| The demo loads without an account | your demo URL in a private window |
| The licence is permissive | `LICENSE`, MIT |

## 10. Final checklist

- [ ] Repo public, default branch pushed, demo URL loads
- [ ] Submission saved in the Code lane, Independent track
- [ ] Challenge line committed at the exact path, one line, unmodified
- [ ] Verification passed on Genesis
- [ ] You kept the challenge path and the submission link in your notes
