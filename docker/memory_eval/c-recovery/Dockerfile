FROM locobench-memory-eval:c

# Generated C/C++ projects frequently use unconditional CMake FetchContent
# declarations.  Keep the final evaluator offline by mirroring the exact
# upstream repositories in the image and rewriting only those Git URLs to the
# local mirrors.  Each project still selects its own declared GIT_TAG.
RUN mkdir -p /opt/git-mirrors \
    && git clone --mirror https://github.com/civetweb/civetweb.git /opt/git-mirrors/civetweb.git \
    && git clone --mirror https://github.com/DaveGamble/cJSON.git /opt/git-mirrors/cjson.git \
    && git clone --mirror https://git.cryptomilk.org/projects/cmocka.git /opt/git-mirrors/cmocka.git \
    && git clone --mirror https://github.com/cpm-cmake/CPM.cmake.git /opt/git-mirrors/cpm-cmake.git \
    && git clone --mirror https://github.com/fmtlib/fmt.git /opt/git-mirrors/fmt.git \
    && git clone --mirror https://github.com/gabime/spdlog.git /opt/git-mirrors/spdlog.git \
    && git clone --mirror https://github.com/mfontanini/cppkafka.git /opt/git-mirrors/cppkafka.git \
    && git clone --mirror https://github.com/skypjack/entt.git /opt/git-mirrors/entt.git \
    && git clone --mirror https://github.com/catchorg/Catch2.git /opt/git-mirrors/catch2.git \
    && git clone --mirror https://github.com/yhirose/cpp-httplib.git /opt/git-mirrors/cpp-httplib.git \
    && git clone --mirror https://github.com/nlohmann/json.git /opt/git-mirrors/nlohmann-json.git \
    && git config --system protocol.file.allow always \
    && git config --system url.file:///opt/git-mirrors/civetweb.git.insteadOf https://github.com/civetweb/civetweb.git \
    && git config --system url.file:///opt/git-mirrors/cjson.git.insteadOf https://github.com/DaveGamble/cJSON.git \
    && git config --system url.file:///opt/git-mirrors/cmocka.git.insteadOf https://git.cryptomilk.org/projects/cmocka.git \
    && git config --system url.file:///opt/git-mirrors/cpm-cmake.git.insteadOf https://github.com/cpm-cmake/CPM.cmake.git \
    && git config --system url.file:///opt/git-mirrors/fmt.git.insteadOf https://github.com/fmtlib/fmt.git \
    && git config --system url.file:///opt/git-mirrors/spdlog.git.insteadOf https://github.com/gabime/spdlog.git \
    && git config --system url.file:///opt/git-mirrors/cppkafka.git.insteadOf https://github.com/mfontanini/cppkafka.git \
    && git config --system url.file:///opt/git-mirrors/entt.git.insteadOf https://github.com/skypjack/entt.git \
    && git config --system url.file:///opt/git-mirrors/catch2.git.insteadOf https://github.com/catchorg/Catch2.git \
    && git config --system url.file:///opt/git-mirrors/cpp-httplib.git.insteadOf https://github.com/yhirose/cpp-httplib.git \
    && git config --system url.file:///opt/git-mirrors/nlohmann-json.git.insteadOf https://github.com/nlohmann/json.git
