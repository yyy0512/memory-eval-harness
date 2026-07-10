FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        make \
        cmake \
        ninja-build \
        pkg-config \
        ca-certificates \
        curl \
        git \
        bash \
        clang \
        bison \
        flex \
        nodejs \
        npm \
        jest \
        python3 \
        libmicrohttpd-dev \
        libcurl4-openssl-dev \
        libssl-dev \
        check \
        libjson-c-dev \
        libcjson-dev \
        libsqlite3-dev \
        uuid-dev \
        libpq-dev \
        libhiredis-dev \
        uthash-dev \
        libjansson-dev \
        libevent-dev \
        libpcre2-dev \
        zlib1g-dev \
        libuv1-dev \
        libsodium-dev \
        libzmq3-dev \
        librdkafka-dev \
        libyaml-cpp-dev \
        libglib2.0-dev \
        libgtk-3-dev \
        libgtk-4-dev \
        libsdl2-dev \
        libprotobuf-dev \
        protobuf-compiler \
        protobuf-c-compiler \
        libprotobuf-c-dev \
        libgrpc-dev \
        libgrpc++-dev \
        protobuf-compiler-grpc \
        libcmocka-dev \
        libcriterion-dev \
        doxygen \
        libcairo2-dev \
        libfftw3-dev \
        libjson-glib-dev \
        libbson-dev \
        libmaxminddb-dev \
        libmosquitto-dev \
        libsoup-3.0-dev \
        libxml2-dev \
        libzstd-dev \
        libonig-dev \
        libopencv-dev \
        libsdl2-image-dev \
        libsdl2-mixer-dev \
        libsndfile1-dev \
        portaudio19-dev \
        libpng-dev \
        libjpeg-dev \
        libopenblas-dev \
        liblapack-dev \
        libglfw3-dev \
        libglm-dev \
        libbullet-dev \
        libopenal-dev \
        nlohmann-json3-dev \
        libfmt-dev \
        libboost-all-dev \
        libspdlog-dev \
        librocksdb-dev \
        libnats-dev \
        libunity-dev \
        libutf8proc-dev \
        libmemcached-dev \
    && rm -rf /var/lib/apt/lists/*

# libgraphqlparser is required by multiple GraphQL C cases but is not packaged
# as a stable Ubuntu 22.04 development package. Build a pinned upstream release
# and expose both pkg-config names observed in generated projects.
RUN git clone --depth 1 --branch v0.7.0 https://github.com/graphql/libgraphqlparser.git /tmp/libgraphqlparser \
    && python3 -m lib2to3 -w /tmp/libgraphqlparser/ast >/dev/null \
    && python3 -c "from pathlib import Path; p=Path('/tmp/libgraphqlparser/CMakeLists.txt'); s=p.read_text(); s=s.replace('FIND_PACKAGE(PythonInterp 2 REQUIRED)\\nIF (NOT PYTHON_VERSION_MAJOR EQUAL 2)\\n  MESSAGE(FATAL_ERROR \\\"Python 2 is required.\\\")\\nENDIF()\\n', 'FIND_PACKAGE(PythonInterp 3 REQUIRED)\\n'); p.write_text(s)" \
    && cmake -S /tmp/libgraphqlparser -B /tmp/libgraphqlparser/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
    && cmake --build /tmp/libgraphqlparser/build --parallel 2 \
    && cmake --install /tmp/libgraphqlparser/build \
    && cp /usr/local/lib/pkgconfig/libgraphqlparser.pc /usr/local/lib/pkgconfig/graphqlparser.pc \
    && mkdir -p /usr/local/lib/cmake/graphqlparser \
    && printf '%s\n' \
        'add_library(graphqlparser SHARED IMPORTED)' \
        'set_target_properties(graphqlparser PROPERTIES' \
        '  IMPORTED_LOCATION "/usr/local/lib/libgraphqlparser.so"' \
        '  INTERFACE_INCLUDE_DIRECTORIES "/usr/local/include/graphqlparser"' \
        ')' \
        'set(graphqlparser_FOUND TRUE)' \
        > /usr/local/lib/cmake/graphqlparser/graphqlparserConfig.cmake \
    && ldconfig \
    && rm -rf /tmp/libgraphqlparser

# Some optional project-family dependencies such as prometheus-c-client are not
# available as stable Ubuntu 22.04 development packages. The runner classifies
# their absence as missing_system_dependency so those cases do not pollute
# executable test_pass_rate.
