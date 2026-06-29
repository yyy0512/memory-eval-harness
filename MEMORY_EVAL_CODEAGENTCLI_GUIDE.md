# Memory Eval 对接 Code Agent CLI 使用指南

本文档说明如何使用本工程新增的 memory eval harness 对接 `codeagentcli`，完成 LoCoBench-Agent 多 session 任务的 memory_on / memory_off 对比评测。

## 1. 目标

Memory eval harness 的目标是验证 Code Agent CLI 的持久化 memory 能否在多 session 软件开发任务中带来收益。

核心流程：

```text
raw LoCoBench scenario JSON
  -> prepared memory eval dataset
  -> single-case smoke test
  -> memory_on batch run
  -> memory_off batch run
  -> score report
```

第一阶段只做最小可落地链路：

- 准备 multi-session development cases；
- 每个 session 独立启动一次 `codeagentcli`；
- 不使用 `--continue` 或 `--resume` 串起上下文；
- memory_on 通过 `autoMemoryDirectory` 开启持久化 memory；
- memory_off 通过 `autoMemoryEnabled: false` 关闭 memory；
- 保存 stream-json 日志、final result、token metrics、workspace diff、memory snapshot；
- 生成 memory_on vs memory_off 的轻量对比报告。

## 2. 相关脚本

```text
scripts/prepare_memory_eval_dataset.py
scripts/smoke_codeagentcli_memory_eval.py
scripts/run_memory_eval.py
scripts/score_memory_eval.py
```

对应职责：

| 脚本 | 用途 |
| --- | --- |
| `prepare_memory_eval_dataset.py` | 从 LoCoBench scenario JSON 生成 prepared dataset |
| `smoke_codeagentcli_memory_eval.py` | 单 case / 单 session 快速验证 `codeagentcli` 连通性和 result 解析 |
| `run_memory_eval.py` | 批量运行 memory_on / memory_off variant |
| `score_memory_eval.py` | 汇总 token、cost、duration、error profile、确定性质量指标，并可选运行 LLM judge 计算语义质量评分 |

## 3. 准备 prepared dataset

示例命令：

```bash
python3 scripts/prepare_memory_eval_dataset.py \
  --scenarios data/output/agent_scenarios \
  --generated data/generated \
  --category extended_development_projects \
  --output prepared/memory_eval_v1_smoke \
  --limit 1
```

输入：

- `--scenarios`：LoCoBench-Agent scenario JSON 目录；
- `--generated`：已生成项目目录；
- `--category`：默认 `extended_development_projects`；
- `--output`：prepared dataset 输出目录；
- `--limit`：可选，只准备前 N 个 case，适合 smoke。

输出结构：

```text
prepared/memory_eval_v1_smoke/
  manifest.jsonl
  summary.json
  cases/
    {scenario_id}/
      case.json
      metadata.json
      scoring_reference.json
      turns/
        session_1.jsonl
        session_2.jsonl
      prompts/
        session_1.txt
        session_2.txt
```

注意：`scoring_reference.json`、`metadata.json`、`prompts/` 是 harness / reviewer 使用的资料，不会被复制进 agent-visible workspace。

## 4. Smoke：单 case 连通性验证

在正式 batch 前，建议先跑 smoke。

### memory_on smoke

```bash
python3 scripts/smoke_codeagentcli_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode on \
  --session 1 \
  --output runs/smoke/memory_on \
  --timeout-sec 1800
```

### memory_off smoke

```bash
python3 scripts/smoke_codeagentcli_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode off \
  --session 1 \
  --output runs/smoke/memory_off \
  --timeout-sec 1800
```

Smoke 会验证：

1. 能读取 `manifest.jsonl` 和目标 `case.json`；
2. 能读取指定 session 的 `turns/session_N.jsonl`；
3. 能复制独立 workspace；
4. 能初始化 git baseline；
5. 能启动 `codeagentcli`；
6. 能写入 stream-json stdout log；
7. 能解析最终 `type == "result"` event；
8. 能提取 `usage`、`modelUsage`、`total_cost_usd`、`duration_ms` 等字段；
9. 能捕获 workspace diff；
10. 能保存 memory snapshot；
11. 能写出 `smoke_result.json`。

Smoke 输出示例：

```text
runs/smoke/memory_on/
  agent_root/
    workspace/
    memory/
  harness/
    logs/
      session_1.stream.jsonl
      session_1.result.json
      session_1.stderr
    metrics/
      session_1.tokens.json
    snapshots/
      session_1.diff
      session_1_memory/
    result.json
    smoke_result.json
```

判断 smoke 是否成功，优先查看：

```text
runs/smoke/memory_on/harness/smoke_result.json
runs/smoke/memory_on/harness/logs/session_1.result.json
runs/smoke/memory_on/harness/logs/session_1.stderr
```

## 5. 正式 batch 运行

Smoke 通过后，再分别跑 memory_on 和 memory_off。

### memory_on batch

```bash
python3 scripts/run_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode on \
  --output runs/memory_eval_001/memory_on \
  --timeout-sec 1800
```

### memory_off batch

```bash
python3 scripts/run_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode off \
  --output runs/memory_eval_001/memory_off \
  --timeout-sec 1800
```

常用参数：

```bash
--limit 1
--scenario-id c_api_gateway_easy_009_multi_session_development_expert_01
--resume
```

含义：

- `--limit`：只跑前 N 个 case；
- `--scenario-id`：只跑指定 scenario；
- `--resume`：如果某个 case 已经有 `harness/result.json`，则跳过。

## 6. 评分和报告

完成 memory_on / memory_off 后运行：

```bash
python3 scripts/score_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --runs runs/memory_eval_001/memory_on runs/memory_eval_001/memory_off \
  --output reports/memory_eval_report.json
```

输出：

```text
reports/memory_eval_report.json
reports/memory_eval_report.md
```

报告包含：

- 每个 variant 的 case 数；
- session 数；
- error session 数；
- input tokens；
- output tokens；
- cache creation / cache read tokens；
- total cost USD；
- duration；
- 确定性质量指标：`final_task_completion`、`cross_session_continuity`、`memory_write_quality`、`memory_usage_evidence`；
- 可选 LLM judge 质量指标：`task_completion`、`fix_correctness`、`output_quality`、`overall`；
- memory_off - memory_on delta。

评分脚本会打印进度，例如：

```text
Scoring variant memory_on: collecting cases
Scoring variant memory_on: 10 case(s)
Scoring variant memory_on: case 1/10 c_api_gateway_easy_009_multi_session_development_expert_01
Writing report to reports/memory_eval_report.json
```

### 可选：启用 LLM judge

默认评分只运行确定性指标，不会调用额外模型。如果要让外部 LLM judge 根据 evaluator-only `scoring_reference.json` 做语义评分，显式追加 `--llm-judge`：

```bash
python3 scripts/score_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --runs runs/memory_eval_001/memory_on runs/memory_eval_001/memory_off \
  --output reports/memory_eval_report_llm.json \
  --llm-judge
```

LLM judge 相关参数：

```bash
--llm-judge
--judge-command "codeagentcli --dangerously-skip-permissions -p --output-format stream-json --verbose"
--judge-timeout-sec 300
--judge-max-chars 12000
```

含义：

- `--llm-judge`：启用 command-backed LLM judge；未传时完全禁用；
- `--judge-command`：judge 命令，prompt 会通过 stdin 传入，stdout 需要返回 JSON 或 Code-Agent-style `stream-json`；
- `--judge-timeout-sec`：单个 case 的 judge 超时；
- `--judge-max-chars`：judge prompt 最大字符数，用于截断 diff / memory / reference 上下文。

LLM judge 输出会聚合到 report 的 `llm_metrics` 和 `llm_*_delta` 字段。Delta 仍然沿用 `memory_off - memory_on`，因此质量指标的负数表示 memory_on 更好。

安全约束：`ground_truth`、`expected_approach`、`evaluation_criteria` 只会进入 judge prompt，不会写入 JSON/Markdown 报告；报告只保存 reference fingerprint、分数、状态和已脱敏的 rationale/evidence。

Delta 的方向是：

```text
memory_off - memory_on
```

因此：

- `input_token_delta > 0` 表示 memory_on 使用了更少 input tokens；
- `cost_delta_usd > 0` 表示 memory_on 成本更低；
- `duration_delta_ms > 0` 表示 memory_on 更快。

## 7. Code Agent CLI 调用方式

Harness 每个 session 都会启动一个独立进程：

```bash
codeagentcli \
  -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose
```

### memory_on

memory_on 会追加：

```bash
--settings '{"autoMemoryDirectory": "/abs/path/to/agent_root/memory"}'
```

等价语义：让 Code Agent CLI 使用指定 memory 目录。

### memory_off

memory_off 会追加：

```bash
--settings '{"autoMemoryEnabled": false}'
```

等价语义：关闭自动 memory。

### bare

可选 `bare` 模式会追加：

```bash
--bare
```

用于更干净地绕开默认配置影响，但主评测建议优先比较 `on` 和 `off`。

## 8. 隔离模型

每个 case / variant 都会有独立目录：

```text
runs/memory_eval_001/memory_on/{case_id}/
  agent_root/
    workspace/
    memory/
  harness/
    logs/
    metrics/
    snapshots/
    home/
    xdg_config/
    xdg_cache/
```

Agent 进程的 cwd 是：

```text
agent_root/workspace
```

Agent 可见：

```text
agent_root/workspace
agent_root/memory
```

Harness-only：

```text
prepared dataset
harness/logs
harness/metrics
harness/snapshots
harness/result.json
reports
other variants
```

每次 CLI 运行也会设置隔离环境变量：

```text
HOME={case_root}/harness/home
XDG_CONFIG_HOME={case_root}/harness/xdg_config
XDG_CACHE_HOME={case_root}/harness/xdg_cache
```

## 9. 评测完整性约束

必须遵守以下约束，否则 memory eval 结果会被污染。

### 不要把 evaluator-only 信息暴露给 agent

不要让 agent 看到：

```text
scoring_reference.json
ground_truth
expected_approach
evaluation_criteria
future session 的 turns/session_2.jsonl、turns/session_3.jsonl
future session 的 prompts/session_2.txt、prompts/session_3.txt
prepared dataset 根目录
harness logs / snapshots / reports
其他 variant 的 workspace 或 memory
```

### 不要用一个长会话跑完整 case

每个 benchmark session 必须是独立 CLI 进程。

不要使用：

```bash
--continue
--resume
```

主评测的目的就是验证在 conversation context 不可用时，persistent memory 是否有帮助。

### 不要假设不存在的 CLI flag

不要使用这些未确认存在的 flag：

```bash
--memory-dir /path/to/memory
--no-memory
--memory-read-log /path/to/memory_queries.jsonl
--memory-write-log /path/to/memory_writes.jsonl
```

当前实现只使用：

```bash
--settings '{"autoMemoryDirectory": "..."}'
--settings '{"autoMemoryEnabled": false}'
```

## 10. 常见问题

### `codeagentcli` 找不到

确认本机 PATH 中能找到：

```bash
codeagentcli --help
```

如果不在 PATH 中，可以传绝对路径：

```bash
--agent-bin /abs/path/to/codeagentcli
```

如果传相对路径，harness 会尽量解析为绝对路径，避免因为 subprocess 的 cwd 切到 isolated workspace 后找不到文件。

### stream log 中没有 `type=result`

查看：

```text
harness/logs/session_N.stream.jsonl
harness/logs/session_N.stderr
```

常见原因：

- CLI 启动失败；
- 权限或认证失败；
- 输入 stream-json 格式不被当前 CLI 接受；
- 运行超时；
- CLI 输出了非 JSON 内容。

### smoke 失败但 workspace 有改动

仍然查看：

```text
harness/snapshots/session_N.diff
harness/snapshots/session_N_memory/
```

这可以判断 agent 是否已经执行了部分操作。

### prepared dataset 为空

检查：

```text
data/output/agent_scenarios
data/generated
```

当前 worktree 可能没有未跟踪的数据目录。如果数据不在 worktree 中，需要在有完整 `data/` 的环境下运行 prepare。

### pytest 无法运行

如果环境缺少 pytest：

```text
/usr/bin/python3: No module named pytest
```

需要在有依赖的环境中安装并运行：

```bash
python3 -m pytest \
  tests/test_memory_eval_io.py \
  tests/test_memory_eval_prepare.py \
  tests/test_memory_eval_runner.py \
  tests/test_memory_eval_scoring.py \
  -q
```

如果当前环境没有 `pip`，只能先用以下轻量验证替代：

```bash
python3 -m compileall -q locobench scripts tests
python3 scripts/prepare_memory_eval_dataset.py --help
python3 scripts/smoke_codeagentcli_memory_eval.py --help
python3 scripts/run_memory_eval.py --help
python3 scripts/score_memory_eval.py --help
```

## 11. 推荐最小验证顺序

```bash
# 1. 准备 1 个 case
python3 scripts/prepare_memory_eval_dataset.py \
  --scenarios data/output/agent_scenarios \
  --generated data/generated \
  --category extended_development_projects \
  --output prepared/memory_eval_v1_smoke \
  --limit 1

# 2. smoke memory_on
python3 scripts/smoke_codeagentcli_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode on \
  --session 1 \
  --output runs/smoke/memory_on

# 3. smoke memory_off
python3 scripts/smoke_codeagentcli_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode off \
  --session 1 \
  --output runs/smoke/memory_off

# 4. batch memory_on
python3 scripts/run_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode on \
  --output runs/memory_eval_001/memory_on \
  --limit 1

# 5. batch memory_off
python3 scripts/run_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode off \
  --output runs/memory_eval_001/memory_off \
  --limit 1

# 6. score
python3 scripts/score_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --runs runs/memory_eval_001/memory_on runs/memory_eval_001/memory_off \
  --output reports/memory_eval_report.json

# 7. score with optional LLM judge
python3 scripts/score_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --runs runs/memory_eval_001/memory_on runs/memory_eval_001/memory_off \
  --output reports/memory_eval_report_llm.json \
  --llm-judge
```

## 12. 产物检查清单

完成一次一 case on/off 评测后，应至少检查：

```text
prepared/memory_eval_v1_smoke/manifest.jsonl
runs/smoke/memory_on/harness/smoke_result.json
runs/smoke/memory_off/harness/smoke_result.json
runs/memory_eval_001/memory_on/run_summary.json
runs/memory_eval_001/memory_off/run_summary.json
runs/memory_eval_001/memory_on/{case_id}/harness/result.json
runs/memory_eval_001/memory_off/{case_id}/harness/result.json
reports/memory_eval_report.json
reports/memory_eval_report.md
```

如果这些文件都存在，且 `failed_cases == 0`，说明第一阶段 memory eval harness 已经完成基本闭环。
