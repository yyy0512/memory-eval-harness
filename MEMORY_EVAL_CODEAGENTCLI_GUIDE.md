# Memory Eval 对接 Code Agent CLI 使用指南

本文档说明如何使用本工程的 memory eval harness 对接 `codeagentcli`，完成 LoCoBench-Agent 多 session 软件开发任务的 memory backend 评测。

当前实现遵循 `MEMORY_EVAL_METRICS_REDESIGN_PLAN.md`：默认比较 `memory_off` 和 CodeAgent CLI 原生 memory；只有输入参数中包含 `openviking_on` run 时，才把 OpenViking 作为独立 backend 纳入对比。OpenViking 的 capture / recall / context injection / isolation 只作为 backend debug evidence，不作为核心质量指标。

## 1. 目标和核心约束

核心流程：

```text
raw LoCoBench scenario JSON
  -> prepared memory eval dataset
  -> single-case smoke test
  -> memory_off / native_memory_on / optional openviking_on batch runs
  -> score report + readable_report.md
```

约束：

- 每个 benchmark session 独立启动一次 `codeagentcli`；
- `native_memory_on` / `openviking_on` 默认在相邻 session 之间等待 10 秒，让后台 memory capture / auto memory 抽取 / 索引有时间完成；
- 主评测不使用 `--continue` / `--resume` 串起 CLI conversation context；
- `memory_off` 通过 `autoMemoryEnabled: false` 关闭 CodeAgent 原生 memory；
- `native_memory_on` / `memory_on` 通过 `autoMemoryDirectory` 开启 CodeAgent 原生 memory；
- `openviking_on` 通过 OpenViking plugin 接入 OpenViking Server，并关闭 CodeAgent 原生 memory；
- 不支持也不展示组合模式；正式 variant 只有 `memory_off`、`memory_on` / `native_memory_on`、可选 `openviking_on`；
- 不修改 LoCoBench-Agent 原始 scenario JSON；prepared dataset overlay 只写入当前输出目录。

## 2. 脚本

| 脚本 | 用途 |
| --- | --- |
| `scripts/prepare_memory_eval_dataset.py` | 从 LoCoBench scenario JSON 生成 prepared dataset |
| `scripts/smoke_codeagentcli_memory_eval.py` | 单 case / 单 session 快速验证 CLI、memory backend、OpenViking plugin 连通性 |
| `scripts/run_memory_eval.py` | 批量运行指定 memory variant |
| `scripts/score_memory_eval.py` | 汇总运行结果、核心质量指标、效率指标、可选 pairwise LLM judge，并生成 readable report |

## 3. 准备 prepared dataset

示例：

```bash
python3 scripts/prepare_memory_eval_dataset.py \
  --scenarios data/output/agent_scenarios \
  --generated data/generated \
  --category extended_development_projects \
  --output prepared/memory_eval_v1_smoke \
  --limit 1

python3 scripts/prepare_memory_eval_dataset.py \
  --scenarios data/output/agent_scenarios \
  --generated data/generated \
  --category extended_development_projects \
  --output prepared/memory_eval_v2_contracts_smoke \
  --limit 1 \
  --contract-overlay configs/memory_contracts.json
```

输出结构：

```text
prepared/<dataset>/
  manifest.jsonl
  summary.json
  cases/
    {scenario_id}/
      case.json
      metadata.json
      scoring_reference.json
      turns/session_N.jsonl
      prompts/session_N.txt
```

`summary.json` 会包含 `dataset_stats`，供 readable report 展示：

```json
{
  "dataset_stats": {
    "difficulty_distribution": {},
    "task_type_distribution": {},
    "programming_language_distribution": {},
    "contract_stats": {
      "contracts_per_case_distribution": {},
      "contract_id_distribution": {},
      "contract_category_distribution": {},
      "case_contracts": []
    },
    "test_availability_stats": {},
    "test_plan_stats": {},
    "test_environment_stats": {},
    "test_integrity_stats": {},
    "requirement_check_stats": {
      "checks_per_case_distribution": {},
      "status_distribution": {},
      "configured_cases": 0,
      "not_configured_cases": 0,
      "case_requirement_checks": []
    }
  }
}
```

统计口径：

- 难度分布：raw scenario 顶层 `difficulty`；
- 编程语言分布：`project_spec.language`；
- contract 注入统计：每个 case 注入几条 contract、分别是哪几个 contract id / category；
- 测试文件可用性：项目目录是否存在 test-like 文件；
- test plan 状态：prepared 阶段是否解析出可在 final workspace 上执行的 post-run test command；正式 batch 推荐通过 `--test-executor docker` 在容器中执行；
- test environment / integrity：runner 会记录 post-run test 环境是否 ready、是否缺系统依赖或 Docker 不可用，以及 final workspace 是否保留原始测试目标；这些状态用于计算 `test_runnable_rate`，并 gating `test_pass_rate` 的可运行可信分母；
- requirement check 统计：每个 case 配置了多少 deterministic requirement checks；v2 只对 explicit overlay 或 strong technical signal 自动生成 checks，普通泛词会被拒绝并显示为 `not_configured`。

### Requirement check overlay

Requirement checks 是 evaluator-owned correctness checks，不会写入 agent prompt。推荐优先通过 overlay 显式配置，支持 global / language / category / case scopes：

```json
{
  "requirement_checks": [],
  "language_requirement_checks": {
    "c": []
  },
  "category_requirement_checks": {
    "multi_session_development": []
  },
  "case_requirement_checks": {
    "c_api_gateway_easy_009": [
      {
        "id": "has_rate_limiter_module",
        "type": "file_exists",
        "path_glob": "**/rate_limiter.c",
        "strength": "explicit",
        "signal_kind": "path",
        "rationale": "The task should add a rate limiter implementation module."
      }
    ]
  }
}
```

如果没有 overlay，prepared 阶段只会从强结构化技术信号生成 checks，例如文件路径、HTTP status、error code、config key、CamelCase/snake_case 技术标识符或明确 domain feature。`context`、`correctly`、`agent`、`build` 这类泛词不会再生成 numeric requirement score；这种 case 会标记为 `not_configured` 并在 readable report 展示原因。

`task_type_distribution` 仍保留在 JSON 中兼容旧数据，但 readable report 只有在出现多个 task type 时才展示；当前 memory eval 数据集通常全是 `multi_session_development`，默认不展示这个低信息量统计。

### Contract overlay

Contract overlay 用来在不修改原始题目的前提下，给 prepared dataset 叠加 memory-specific 项目约定。当前 strict baseline 推荐使用 `configs/memory_contracts_v4.json`：这是一套语言无关的 TOMATO continuity contract，用精确 sentinel marker 检查跨 session 记忆是否被后续实现复用，并为 strict baseline cases 提供 evaluator-owned deterministic requirement checks。单题 smoke、10-case 和 19-case strict dataset 都应使用同一个 v4 overlay，避免不同配置版本导致指标不可比。

Contract 选择顺序是：全局 `memory_contracts` → `language_contracts[project_spec.language]` → `category_contracts[original_scenario.task_category]` → `case_contracts[scenario_id 或 case_id]`。相同 `id` 会去重，`selection.max_contracts_per_case` 会截断最终列表。v4 的主力是全局 `memory_contracts`，保证 10-case 和 19-case strict dataset 在不同语言上使用同一套 TOMATO 记忆准则。

`description` 会进入 session 1 最后一轮的 contract-tail follow-up，而不是 session 1 主任务开头；这样 session 1 的代码不会提前出现 TOMATO sentinel，后续 session 仍能通过 memory 看到 continuity contract。建议用 CodeAgentCLI 原生 memory 类别风格书写，并设置 `memory_type` 为 `project`、`feedback`、`user` 或 `reference`。`workspace_effective_from_session` 指定从哪个后续 session 开始检查。`expected_memory_fact` 只用于 `memory_content_quality`，检查 memory 文件或 OpenViking snapshot。`checks` 只保存在 `scoring_reference.json`；`contract_compliance` 仅扫描后续 session 新增或修改的 workspace 文件。缺少逐 session delta 或在引入 session 已满足的 check 不计分。不要使用任意 identifier、任意 README/test/config 这类泛 regex。

`expected_memory_fact.required_keywords` 可以写稳定关键词；可选 `anchor_sources` 会在 prepare 阶段解析成普通 `required_keywords`，让通用 C contract 自动带上当前 case 的 specific anchors。常用 source 包括 `prompt_paths`、`prompt_identifiers`、`prompt_routes`、`prompt_config_keys`、`project_headers`、`project_test_files`、`project_docs`、`project_config_files`。scoring 阶段不理解 `anchor_sources`，只读取 prepare 后落盘的 `required_keywords` / `required_regex`。同时，prepare 会从这些 contract-specific anchors 派生少量隐藏的 `checks`，用于在最终 workspace 中间接检查后续 session 是否复用/保留了关键 identifier、route、path 等行为证据。也就是说：`memory_content_quality` 检查 memory backend 是否写入该记的事实；`contract_compliance` 检查后续 session 产出的代码/文件是否 follow contract。没有任何后续行为 checks 的 contract 不进入 contract_compliance 分母。

最小格式：

```json
{
  "memory_contracts": [
    {
      "id": "api_error_envelope",
      "introduced_in_session": 1,
      "description": "All new API errors must use { error: { code, message } }.",
      "checks": [
        {
          "type": "require_regex",
          "path_glob": "src/**/*.ts",
          "pattern": "error\\s*:\\s*\\{\\s*code\\s*:"
        },
        {
          "type": "forbid_regex",
          "path_glob": "src/**/*.ts",
          "pattern": "res\\.status\\([^)]*\\)\\.json\\(\\{\\s*message\\s*:"
        }
      ]
    }
  ]
}
```

如果 overlay 改变了 prepared prompts 或派生出的 `expected_memory_facts`，应对所有待比较 variant 重新跑；例如切到 `configs/memory_contracts_v4.json` 后，必须重新 prepare，再分别跑 `memory_off`、`native_memory_on`、`openviking_on`，不能复用旧 prepared dataset。如果只是新增 scoring-only checks 且不改变 prompt/workspace/hidden tests，可以直接重 score 旧 run。

## 4. Memory mode / backend

`--memory-mode` 支持：

| mode | 归一化 variant | backend | 语义 |
| --- | --- | --- | --- |
| `off` | `memory_off` | `off` | 关闭 CodeAgent 原生 memory，不加载 OpenViking plugin |
| `memory_off` | `memory_off` | `off` | 同 `off` |
| `on` | `memory_on` | `native` | 兼容旧模式：开启 CodeAgent 原生 memory |
| `memory_on` | `memory_on` | `native` | 同 `on` |
| `native` | `native_memory_on` | `native` | 开启 CodeAgent 原生 memory，推荐新名称 |
| `native_memory_on` | `native_memory_on` | `native` | 同 `native` |
| `openviking` | `openviking_on` | `openviking` | 关闭 CodeAgent 原生 memory，加载 OpenViking plugin |
| `openviking_on` | `openviking_on` | `openviking` | 同 `openviking` |
| `bare` | `bare` | `bare` | 使用 `--bare`，用于排除默认配置影响 |

默认正式对比：

```text
memory_off
native_memory_on  # 或旧 alias memory_on
```

如需评测 OpenViking backend，再额外跑：

```text
openviking_on
```

## 5. Smoke 和 batch 示例

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

### native memory smoke

```bash
python3 scripts/smoke_codeagentcli_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode native \
  --session 1 \
  --output runs/smoke/native_memory_on \
  --timeout-sec 1800
```

### OpenViking smoke

```bash
python3 scripts/smoke_codeagentcli_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode openviking \
  --plugin-dir /home/yyy/projects/CodeAgent/packages/codeagent-openviking-plugin \
  --openviking-url http://127.0.0.1:1933 \
  --openviking-account memory-eval-smoke \
  --openviking-user-prefix smoke001 \
  --openviking-peer-prefix smoke001 \
  --session 1 \
  --output runs/smoke/openviking_on \
  --timeout-sec 1800
```

OpenViking mode 必须传 `--plugin-dir`。API key 如有需要只从外部环境继承，不写入 run result 或 report。

### Batch

```bash
python3 scripts/run_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode off \
  --output runs/memory_eval_001/memory_off \
  --timeout-sec 1800

python3 scripts/run_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode native \
  --output runs/memory_eval_001/native_memory_on \
  --timeout-sec 1800

python3 scripts/run_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode openviking \
  --plugin-dir /home/yyy/projects/CodeAgent/packages/codeagent-openviking-plugin \
  --openviking-url http://127.0.0.1:1933 \
  --openviking-account memory-eval \
  --openviking-user-prefix run001 \
  --openviking-peer-prefix run001 \
  --output runs/memory_eval_001/openviking_on \
  --timeout-sec 1800
```

正式 batch 建议启用 Dockerized post-run tests，避免 host 缺系统依赖导致测试可运行性和通过率误判：

```bash
python3 scripts/run_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode off \
  --output runs/memory_eval_001/memory_off \
  --timeout-sec 1800 \
  --test-executor docker \
  --docker-image locobench-memory-eval:c \
  --docker-network none
```


Docker 不可用、镜像不存在、缺系统依赖、测试计划不可解析或测试目标被 agent 弱化时，runner 会写入结构化 `harness/test_result.json`；scoring 会用 `test_runnable_rate` 展示这类 case 是否可进入测试分母，并把不可运行/不可信 case 的 `test_pass_rate` 记为 N/A，在 readable report 展示原因。

`--resume` 是 harness 自己的断点续跑参数：跳过已有 `harness/result.json` 的 case；它不是传给 `codeagentcli` 的 `--resume`。

### Session 间 memory settle 等待

Batch runner 默认会在 `native_memory_on` / `openviking_on` 的相邻 session 之间等待 10 秒，避免上一个 session 刚结束、memory backend 还没完成自动抽取 / capture / indexing，下一个 session 就已经启动。

`memory_off` 不等待；最后一个 session 后也不等待。可通过 `--memory-settle-sec` 调整，设为 `0` 可关闭：

```bash
python3 scripts/run_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --agent-bin codeagentcli \
  --memory-mode native \
  --output runs/memory_eval_001/native_memory_on \
  --timeout-sec 1800 \
  --memory-settle-sec 10
```

等待结果会写入每个非最后 session 的 `memory_settle` 字段；`run_summary.json` 和 `harness/result.json` 的 `run_environment` 会记录本次使用的 `memory_settle_sec`。这是评测运行稳定性设置，不进入核心质量指标。


## 6. 评分和 readable report

推荐输出目录形式，让每次 score 生成时间戳子目录：

```bash
python3 scripts/score_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --runs \
    runs/memory_eval_001/memory_off \
    runs/memory_eval_001/native_memory_on \
    runs/memory_eval_001/openviking_on \
  --output reports/memory_eval_001
```

输出：

```text
reports/memory_eval_001/{YYYYMMDD_HHMMSS}/
  score_report.json
  score_report.md
  readable_report.md
```

`readable_report.md` 是 score 环节最后一步必须生成的可读报告，结构包括：

1. 本次运行的产物；
2. 数据集基础统计：难度分布、编程语言分布、contract 注入统计、test plan 状态、requirement check 统计、测试文件可用性；
3. 运行完成情况；
4. 核心质量指标；
5. 可选 Blind LLM 辅助判断；
6. 效率指标：token、cost、duration、tool calls；
7. 可选 OpenViking backend debug evidence；
8. 指标解释；
9. 中立总结。

核心质量指标：

| Metric | 含义 |
| --- | --- |
| `contract_compliance` | 检查 session 1 引入的 memory-dependent contract suite 是否出现在后续 session 新增/修改的代码或文件中；session HOME/XDG 未隔离、引入 session 已存在证据或缺少逐 session delta 的旧 run 不进入分母 |
| `test_runnable_rate` | runner 是否在最终 workspace 上得到可运行且 integrity 可信的 post-run test；不可解析测试计划、Docker/系统依赖不可用、网络依赖不可用、timeout 或测试目标被弱化都计为不可运行 |
| `test_pass_rate` | 只在 `test_runnable_rate` 判定可运行可信的 case 分母中计算测试是否通过；通过为 1.0，真实测试失败为 0.0，不可运行/不可信为 N/A 并在报告中展示原因 |
| `requirement_rule_coverage` | 用 evaluator-owned deterministic requirement checks 补充任务正确性判断；prepared 阶段会优先使用 overlay checks，否则保守提取可验证 identifier/keyword rules |
| `memory_content_quality` | 检查 memory backend 是否记录 expected memory facts；prepared 会从 contract overlay 派生基础 expected memory facts；`memory_off` 为 N/A |

已删除的旧 proxy 指标不会进入新版核心质量表：运行完成情况只在运行章节展示；changed-file overlap 和 snapshot overlap 不再被包装成 memory 使用证据。

### Delta / comparison 方向

`comparisons` 命名是：

```text
baseline_vs_candidate
```

例如：

```text
memory_off_vs_native_memory_on
memory_off_vs_openviking_on
native_memory_on_vs_openviking_on
```

所有 delta 统一按：

```text
candidate - baseline
```

解释：

- 质量指标 delta > 0：candidate 更高；
- token/cost/duration/tool calls delta < 0：candidate 更省或更快。

### 默认 pairwise blind LLM judge

CLI 评分默认运行 pairwise blind LLM judge。也就是说不再需要 `--llm-judge` 参数：

```bash
python3 scripts/score_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --runs \
    runs/memory_eval_001/memory_off \
    runs/memory_eval_001/native_memory_on \
  --output reports/memory_eval_001
```

如果只想跑 deterministic 指标，可以显式关闭：

```bash
python3 scripts/score_memory_eval.py \
  --prepared prepared/memory_eval_v1_smoke \
  --runs \
    runs/memory_eval_001/memory_off \
    runs/memory_eval_001/native_memory_on \
  --output reports/memory_eval_001 \
  --no-llm-judge
```

LLM judge 现在是 pairwise blind judge。每次只比较同一个 case 的两个匿名 submission：

```text
Submission A
Submission B
```

输出只接受：

```text
A_better
B_better
tie
both_bad
judge_uncertain
```

真实 variant 只在聚合阶段恢复。Prompt 不包含 `memory_on` / `memory_off` / `openviking_on`、`variant` 字段、memory snapshot 或 memory excerpts。

安全约束：`ground_truth`、`expected_approach`、`evaluation_criteria` 只会进入 judge prompt，不写入 JSON/Markdown 报告；报告只保存 reference fingerprint、pairwise verdict、状态和脱敏 rationale/evidence。

## 7. Code Agent CLI 调用方式

Harness 每个 session 都会启动一个独立进程：

```bash
codeagentcli \
  -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose
```

每个 session 进程使用独立的 `HOME`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME`。同一 case 内只共享 workspace，以及该 variant 明确启用的 native/OpenViking memory；CLI project history 不跨 session 复用。

### native / memory_on

```bash
--settings '{"autoMemoryDirectory": "/abs/path/to/agent_root/memory"}'
```

### memory_off

```bash
--settings '{"autoMemoryEnabled": false}'
```

### openviking / openviking_on

```bash
--settings '{"autoMemoryEnabled": false}'
--plugin-dir /abs/path/to/codeagent-openviking-plugin
```

OpenViking 环境变量：

```text
OPENVIKING_MEMORY_ENABLED=1
OPENVIKING_URL=http://127.0.0.1:1933
OPENVIKING_ACCOUNT=memory-eval
OPENVIKING_USER={prefix}-openviking_on-{case_id}
OPENVIKING_PEER_ID={prefix}-openviking_on-{case_id}
OPENVIKING_DEBUG=1
```

### bare

```bash
--bare
```

## 8. 隔离模型

每个 case / variant 都有独立目录：

```text
runs/memory_eval_001/openviking_on/{case_id}/
  agent_root/
    workspace/
    memory/
  harness/
    logs/
    metrics/
    session_envs/session_N/  # 每个 session 独立 HOME/XDG
    snapshots/
    home/
    xdg_config/
    xdg_cache/
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

OpenViking snapshot：

```text
harness/snapshots/session_N_openviking/
harness/snapshots/final_openviking/
```

典型结构：

```text
session_N_openviking/
  state/
    last-capture.json
    last-recall.json
    last-session-event.json
  logs/
    codeagent-hooks.log
  server/
    health.json
    system_status.json
    search_probe.json
    session_context.json
```

这些只用于 backend debug evidence。

## 9. 评测完整性约束

不要让 agent 看到：

```text
scoring_reference.json
ground_truth
expected_approach
evaluation_criteria
memory_contracts[].checks
future session 的 turns/session_2.jsonl、turns/session_3.jsonl
future session 的 prompts/session_2.txt、prompts/session_3.txt
prepared dataset 根目录
harness logs / snapshots / reports
其他 variant 的 workspace 或 memory
```

不要使用未确认存在的 CLI flag：

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
--plugin-dir /abs/path/to/codeagent-openviking-plugin
--bare
```

## 10. 常见问题

### `openviking` mode 报缺少 `--plugin-dir`

`openviking` / `openviking_on` 需要 CodeAgent OpenViking plugin：

```bash
--plugin-dir /home/yyy/projects/CodeAgent/packages/codeagent-openviking-plugin
```

### OpenViking Server 不可用

先确认服务可达：

```bash
curl http://127.0.0.1:1933/health
```

再查看：

```text
harness/snapshots/session_N_openviking/server/health.json
harness/snapshots/session_N_openviking/server/system_status.json
harness/snapshots/session_N_openviking/server/search_probe.json
```

### OpenViking 没有召回内容

查看：

```text
harness/snapshots/session_N_openviking/state/last-recall.json
harness/snapshots/session_N_openviking/logs/codeagent-hooks.log
harness/snapshots/session_N_openviking/server/search_probe.json
```

常见原因：capture 未成功、identity 不一致、plugin 未加载、OpenViking Server 未启用对应 account/user 的搜索。

### pytest 无法运行

如果环境缺少 pytest，需要在有依赖的环境中安装后运行：

```bash
python3 -m pytest tests/test_memory_eval_prepare.py tests/test_memory_eval_scoring.py
```
