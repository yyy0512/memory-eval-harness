# Memory Eval C Docker Image

This image is the default post-run test environment for C LoCoBench memory-eval cases.

Build:

```bash
docker build -t locobench-memory-eval:c -f docker/memory_eval/c/Dockerfile .
```

The image intentionally pins Ubuntu 22.04 for reproducible package versions. The Docker host may be a different Ubuntu/WSL version; test dependencies come from this container image, not the host root filesystem.

Known optional gaps:

- `prometheus-c-client` may require a per-case/per-family image if a generated CMake project requires it.
- Some generated projects reference domain-specific in-repo package names in `find_package()`/`pkg-config` probes. Those should be treated as project/test-plan issues unless fresh logs prove they map to a stable system dependency.

The image source-builds a pinned `libgraphqlparser` release because Ubuntu 22.04 does not provide a stable development package for the `graphqlparser` / `libgraphqlparser` metadata names used by the generated GraphQL cases.

The runner records `harness/docker_preflight.json` for Docker post-run tests and classifies missing pkg-config packages or build-system dependency probes as `missing_system_dependency`.
