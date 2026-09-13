# Recall batteries

Probes for [the taxonomy](../SKILL.md#taxonomy), tuned during the 2026-08 purge. Every hit needs semantic judgment — the batteries over-match by design, and they under-match by nature: each review round of the purge found cases no battery caught, so pair them with an unpatterned read of the densest prose in scope.

## Invocation rules

- Add `--hidden --glob '!.git/**'` so dot-directories are searched; ripgrep skips them by default and the densest unread prose usually sits in one (`.dbg/` evidence, plugin directories).
- Exclusions go last so a later include cannot re-admit them: `--glob '!node_modules/**' --glob '!.dbg/**' --glob '!.corum-dev-home/**' --glob '!.corum-verify-home/**' --glob '!**/lib/**' --glob '!**/dist/**' --glob '!**/*.tsbuildinfo'` (this skill's own files quote leaked wording as calibration — add `--glob '!**/skills/dsh-trim-cot-leakage/**'` when the corpus includes the skill store). Evidence files under `.dbg/` self-hit through their quoted evidence; judge them as evidence, not usage.
- Natural-language lines carry `-i` so sentence-initial capitals hit ("This PR adds…", "Probably fine…"); the first line, which matches code patterns, stays case-sensitive — `-i` would turn `\bT\d\b` and `\bP-I\b` into noise.
- Bound complete phrases. `\bthis PR\b` must match "this PR adds" without matching "this project", "this process", or "this provider".
- A zero-hit pattern proves nothing until it matches a known positive, and a noisy pattern proves nothing until it rejects a near-miss negative. Calibrate both before trusting a corpus result.
- Target authoring-language probes at the opposite-language surface: search English residue in otherwise-Chinese documents (`docs/dev-conventions.md`, `docs/LESSONS.md`, `docs/HANDOFF-*.md` are Chinese; `AGENTS.md` and this skill store are English), and search Chinese change narration inside otherwise-English files. This repo has no `*.zh.md` pairs, so there is no counterpart to diff against: judge the addition on its own language surface instead.

## English battery

```sh
rg -n --hidden '\(decision \d|\(audit [A-Z]\d|design §|plan §|design ledger|\(B ruling|\bP-I\b|\bW\d\b|\bT\d\b' ...
rg -n --hidden -i '\bthis PR\b|\bthis branch\b|\bthis stack\b|\blater PRs?\b|\bprevious commits?\b|\bthis commit\b' ...
rg -n --hidden -i '\bused to\b|\bno longer\b|\bpreviously\b|\bthe old\b|\bwas renamed\b|\bwas moved\b' ...
rg -n --hidden -i '\bv1\b|this cut|\bcut \d|\btoday\b|\bfor now\b|roadmap' ...
rg -n --hidden -i 'rejected in review|review round|reviewer|as of v\d' ...
rg -n --hidden -i 'probably |should be enough|should suffice|it simply|is safe —|is safe --' ...
rg -n --hidden '§\d' ...
```

## Chinese batteries

```sh
# Change or review narration in the repo's Chinese documents.
rg -n --hidden '评审|上一?轮|旧版|老的|不再|以前|本版|遗留' --glob 'docs/**/*.md' ...

# Chinese authoring-language slips in English Markdown (AGENTS.md, the skill store, package READMEs).
rg -n --hidden '设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有|(^|[^a-zA-Z])端([^a-zA-Z]|$)' --glob '*.md' --glob '!docs/**' ...

# Chinese authoring-language slips in English code comments and JSDoc.
rg -n --hidden '(^[[:space:]]*(//|/\*|\*)|//|/\*)[^\r\n]*(设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有|端)' --glob '*.{ts,tsx,js,jsx,mjs,cjs,css}' ...
rg -n --hidden '#[^\r\n]*(设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有|端)' --glob '*.py' ...
```

## Known false-positive families

Judged and kept during the purge; expect them again:

- **Instrumental "used to"** — "the key used to sign requests" is instrumental, not temporal. The temporal form has a subject state before it ("colors used to come from…").
- **Runtime old/new** — "the old connection drains before the new one accepts" names live objects during handover, not repo states.
- **"This PR" in process docs** — documentation *about* PR workflow ("the PR body should…", templates, this repo's process notes) legitimately says "PR"; the ban is on a doc adopting one PR's vantage about the code.
- **`v1` as protocol or path segment** — `/v1/chat` endpoints and wire-format names are identifiers, not version stamps.
- **`§N` with a committed owner** — external standards (RFC 9110 §10.1.5) and committed docs that own their §-numbering stay citable by section.
- **Contrastive "actually" and noun "wait"** — ordinary English, not hedging; no committed line probes them, so they surface only when you extend the battery with broader hedging patterns.
- **Runtime "today" and recorded timestamps** — prompts or tests that ask for the current date use natural time, not a repository version stamp; recorded CLI output keeps its voice. Wording that reaches a model or user still follows the behavior-evidence rule before any edit.
- **本版本 in zh prose** — a legitimate rendering of "this release" in versioned-artifact contexts; the banned indexical is 本版 as a bare stamp mirroring "this cut".
- **Alternatives-considered sections** — "rejected" inside a genre slot that exists to record a rejected option is the sanctioned home, not review choreography. In this repo those slots are `docs/LESSONS.md` entries (root cause and the practice that follows) and `docs/audit/NEXT-PHASE-DEFERRED.md` (deferred or closed items and what would unblock them).
- **交接文档（`docs/HANDOFF-*.md`）的变更叙述** — 这一体裁的正文就是"这一轮改了什么、为什么"，属 sanctioned change story；但其中的索引式日期戳（"this cut"、"now"、"v1"）仍按索引戳规则处理。
