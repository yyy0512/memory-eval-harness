# Strict baseline memory-eval dataset

## Ready datasets

- 10-case subset: `prepared/memory_eval_strict_baseline_10_20260709`
- Full strict set: `prepared/memory_eval_strict_baseline_19_20260709`
- Single-case contract-tail smoke set: `prepared/memory_eval_strict_baseline_1_contract_tail_v1_20260710`

The 10 cases are a subset of the 19 cases. Every case has more than one session. The raw generated inputs used to materialize these datasets are intentionally not committed.

## Admission gate

A case is admitted only when its complete original test plan passes in the pinned per-language Docker image with `--network none`:

- pristine baseline status is `passed`;
- environment status is `ready`;
- post-run integrity status is `passed`;
- only whole-file fence cleanup and invalid XML-comment cleanup are allowed;
- no assertion, expected value, business code, or test-file subset is changed.

The 19-case set passed the initial language scan and two later formal post-run validations: `19/19` on all three runs. Go and C# produced no admitted cases. The final language mix is C 4, C++ 2, Java 3, JavaScript 2, PHP 1, Python 3, Rust 1, and TypeScript 3.

## 2026-07-10 recovery audit

A second strict recovery pass kept the same admission gate and tried additional syntax-only and environment-only fixes:

- complete and opener-only Markdown fence cleanup, including normalized manifest discovery;
- safe Maven XML entity/comment repair and parent-version property resolution;
- pinned Node/Python/PHP dependencies, PHP 8.3, Rust 1.85, and global test-tool bootstraps;
- offline C/C++ Git mirrors for unconditional CMake `FetchContent` repositories;
- online Maven/Rust discovery scans only to distinguish dependency failures from invalid projects; online results were not eligible for admission.

The result remains 19 strict cases. No additional case passed its complete original test plan, so no replacement prepared dataset was created. The recovery attempts mainly converted environment failures into concrete baseline defects such as missing project modules/files, nonexistent test paths, invalid manifests/configuration, or failing tests. The local audit output was intentionally not committed because `output/` is treated as generated evidence.

## Three comparable runs

Do not pass a global `--docker-image`: each case already carries its pinned language image.

```bash
PREPARED=prepared/memory_eval_strict_baseline_10_20260709

python3 scripts/run_memory_eval.py \
  --prepared "$PREPARED" --agent-bin codeagentcli --memory-mode off \
  --output runs/strict10/memory_off --timeout-sec 1800 \
  --test-executor docker --docker-network none

python3 scripts/run_memory_eval.py \
  --prepared "$PREPARED" --agent-bin codeagentcli --memory-mode native \
  --output runs/strict10/native_memory_on --timeout-sec 1800 \
  --test-executor docker --docker-network none

python3 scripts/run_memory_eval.py \
  --prepared "$PREPARED" --agent-bin codeagentcli --memory-mode openviking \
  --plugin-dir /abs/path/to/codeagent-openviking-plugin \
  --openviking-url http://127.0.0.1:1933 \
  --openviking-account memory-eval --openviking-user-prefix strict10 \
  --openviking-peer-prefix strict10 \
  --output runs/strict10/openviking_on --timeout-sec 1800 \
  --test-executor docker --docker-network none
```

For the full set, change `PREPARED` to `prepared/memory_eval_strict_baseline_19_20260709` and use separate output directories.

Infrastructure or integrity failures should invalidate/rerun the affected evaluation; they must not silently change the test-rate denominator between memory modes.
