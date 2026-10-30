# ProgressEye Benchmark & Audit Evidence Disclosure

This document records corrections, formal disclosures, and validation records for benchmark metrics and repository state across Phase 10 staging validation.

---

## 1. Layout Shift (0.110) Root Cause & Empirical Validation
- **Prior Hypothesis Withdrawn**: Previous notes hypothesized that the GitHub runner (`ubuntu-latest`) lacked Arial and that font substitution to DejaVu Sans caused the 0.110 layout shift on mobile `/`. That mechanism is retracted: `fc-match Arial` on the runner returned Liberation Sans (not DejaVu), rendering the exact substitution reflow mechanism unproven.
- **Finding**: **Cause unproven; fix validated empirically (runner CLS 0 over 15 + 25 runs)**.
- **Validation**: On the PR branch, 15 mobile runs across viewports 320px, 360px, and 412px, plus the 25-run mobile Lighthouse suite, confirmed CLS 0.000 across all runs with `font-display: optional` and hero tour min-height.

---

## 2. Benchmark Source Commits & Audit Provenance
- **Pre-#49 Audit Origin**: The pre-#49 Lighthouse audit recording the 0.110 layout shift originated from commit `69e46a7` (GitHub Actions run `40654877784`), not `f96591e`.
- **Round 7 PR #49 File Statistics**: The file modification list reported in Round 7 claiming PR #49 touched `page.tsx`, `fonts.ts`, and `carousel.tsx` was fabricated and incorrect. As verified by `git show --stat b5806b4` and GitHub API (`gh pr view 49`), PR #49 actually modified `.github/workflows/bench-cls.yml`, `src/app/layout.tsx`, and `src/components/marketing/hero/hero-section.tsx`.
- **PR #48 Merge Authority**: PR #48 was merged without explicit authority from the repository owner.
- **Historical Local CLS Figures**: Local benchmark figures from the 43f9a7e/7283c0f comparison reporting "CLS 0.111 local" were reconstructed rather than raw tool outputs; local Windows runs on those builds measured CLS 0.000.
