#------------------------------------------------------------------------------
# LambdaUtility Orchestrator – Makefile
#
# This Makefile orchestrates the build, package, test, and maintenance
# lifecycle of the LambdaUtility server-less automation suite.
#
# Highlights
#   • Automatic discovery of Lambda entrypoints (src/lambda_*.c)
#   • Dependency generation with -MMD/-MP
#   • Common library archive built from src/common
#   • Packaging into ZIP artifacts ready for AWS Lambda upload
#   • Unit-test compilation + execution via CMocka
#   • Static-analysis and code-coverage helpers
#------------------------------------------------------------------------------

# ------------------------
#  Tool-chain configuration
# ------------------------
UNAME_S          := $(shell uname -s)

# Optionally override from env, otherwise choose sensible default
CC               ?= gcc
AR               ?= ar
STRIP            ?= strip

# Musl is preferred for static glibc-independent binaries (optional)
MUSL_CC          ?= musl-gcc

# Change to "musl" to build fully-static lambda binaries
ifdef USE_MUSL
CC := $(MUSL_CC)
endif

# ------------------------
#  Directory layout
# ------------------------
SRC_DIR          := src
COMMON_DIR       := $(SRC_DIR)/common
BUILD_DIR        := build
OBJ_DIR          := $(BUILD_DIR)/obj
BIN_DIR          := $(BUILD_DIR)/bin
LIB_DIR          := $(BUILD_DIR)/lib
PKG_DIR          := $(BUILD_DIR)/pkg
TEST_BUILD_DIR   := $(BUILD_DIR)/test/bin

# ------------------------
#  Source discovery
# ------------------------
LAMBDA_SRC       := $(wildcard $(SRC_DIR)/lambda_*.c)
LAMBDA_TARGETS   := $(patsubst $(SRC_DIR)/%.c,%,$(LAMBDA_SRC))           # lambda_foo
COMMON_SRC       := $(wildcard $(COMMON_DIR)/*.c)

# ------------------------
#  Build flags
# ------------------------
CSTD             := -std=c11
WARNINGS         := -Wall -Wextra -Werror -Wshadow -Wundef -pedantic
OPTIMISE         ?= -O2
DEBUG_FLAGS      ?=

CFLAGS           ?= $(CSTD) $(WARNINGS) $(OPTIMISE) $(DEBUG_FLAGS) \
                    -fPIC -pipe -MMD -MP

# Produce smaller, position-independent, stripped static binaries for Lambda
LDFLAGS          ?= -s -static

# For coverage builds: `make coverage` will inject these
COV_CFLAGS       =
COV_LDFLAGS      =

# ------------------------
#  Libraries
# ------------------------
COMMON_OBJ       := $(patsubst $(COMMON_DIR)/%.c,$(OBJ_DIR)/common/%.o,$(COMMON_SRC))
COMMON_LIB       := $(LIB_DIR)/libcommon.a

# ------------------------
#  Default target
# ------------------------
.DEFAULT_GOAL    := all

#------------------------------------------------------------------------------
#  High-level targets
#------------------------------------------------------------------------------
.PHONY: all package clean test lint coverage

all: $(LAMBDA_TARGETS:%=$(PKG_DIR)/%.zip)

package: all ## Alias

#------------------------------------------------------------------------------
#  Lambda packaging
#------------------------------------------------------------------------------
# 1. Compile:         src/lambda_foo.c -> build/bin/lambda_foo
# 2. Strip & Package: build/bin/lambda_foo -> build/pkg/lambda_foo.zip
#------------------------------------------------------------------------------

# Build rule for each Lambda ZIP
$(PKG_DIR)/%.zip: $(BIN_DIR)/% | $(PKG_DIR)
	@echo " [PKG]  $@"
	@cd $(BIN_DIR) && zip -q -9 ../pkg/$*.zip $*

# Build rule for each Lambda executable
$(BIN_DIR)/%: $(OBJ_DIR)/%.o $(COMMON_LIB) | $(BIN_DIR)
	@echo " [LD ]  $@"
	$(CC) $(CFLAGS) $< $(COMMON_LIB) $(LDFLAGS) $(COV_LDFLAGS) -o $@
	$(STRIP) $@

# Pattern rule: compile individual source files
$(OBJ_DIR)/%.o: $(SRC_DIR)/%.c | $(OBJ_DIR)
	@echo " [CC ]  $<"
	$(CC) $(CFLAGS) $(COV_CFLAGS) -c $< -o $@

#------------------------------------------------------------------------------
#  Common library
#------------------------------------------------------------------------------
$(COMMON_LIB): $(COMMON_OBJ) | $(LIB_DIR)
	@echo " [AR ]  $@"
	$(AR) rcs $@ $^

$(OBJ_DIR)/common/%.o: $(COMMON_DIR)/%.c | $(OBJ_DIR)/common
	@echo " [CC ]  $<"
	$(CC) $(CFLAGS) $(COV_CFLAGS) -c $< -o $@

#------------------------------------------------------------------------------
#  Unit testing
#------------------------------------------------------------------------------
TEST_SRC         := $(wildcard tests/test_*.c)
TEST_BINS        := $(patsubst tests/%.c,$(TEST_BUILD_DIR)/%,$(TEST_SRC))

test: $(TEST_BINS) ## Build & execute unit tests
	@echo "Running unit tests..."
	@set -e; for t in $(TEST_BINS); do \
		echo " • $$t"; \
		$$t || exit 1; \
	done
	@echo "All tests passed."

$(TEST_BUILD_DIR)/%: tests/%.c $(COMMON_LIB) | $(TEST_BUILD_DIR)
	@echo " [TST]  $<"
	$(CC) $(CFLAGS) -I$(COMMON_DIR) $< -o $@ $(COMMON_LIB) -lcmocka

#------------------------------------------------------------------------------
#  Static analysis
#------------------------------------------------------------------------------
lint: ## Run cppcheck on the codebase
	@echo "Running static analysis (cppcheck)…"
	cppcheck --enable=all --inconclusive --quiet --std=c11 \
	         --suppress=missingIncludeSystem \
	         --force $(SRC_DIR) $(COMMON_DIR) || true

#------------------------------------------------------------------------------
#  Code coverage
#------------------------------------------------------------------------------
ifdef COVERAGE
COV_CFLAGS  := -O0 -fprofile-arcs -ftest-coverage
COV_LDFLAGS := -lgcov
endif

coverage: clean ## Build code with coverage instrumentation
	$(MAKE) COVERAGE=1 CFLAGS="$(CFLAGS) $(COV_CFLAGS)" LDFLAGS="$(LDFLAGS) $(COV_LDFLAGS)" test
	@echo "Generating coverage report (gcov)…"
	@gcov $(LAMBDA_SRC) $(COMMON_SRC) > /dev/null
	@echo "Done. *.gcov files generated."

#------------------------------------------------------------------------------
#  House-keeping
#------------------------------------------------------------------------------
clean: ## Remove all build artefacts
	@echo "Cleaning build artifacts…"
	@rm -rf $(BUILD_DIR) *.gcda *.gcno *.gcov

#------------------------------------------------------------------------------
#  Directory creation (order-only prerequisites)
#------------------------------------------------------------------------------
$(BUILD_DIR) \
$(OBJ_DIR) \
$(OBJ_DIR)/common \
$(BIN_DIR) \
$(LIB_DIR) \
$(PKG_DIR) \
$(TEST_BUILD_DIR):
	@mkdir -p $@

#------------------------------------------------------------------------------
#  Dependency tracking
#------------------------------------------------------------------------------
DEPS            := $(shell find $(OBJ_DIR) -name '*.d' 2>/dev/null)
-include $(DEPS)

#------------------------------------------------------------------------------
#  Helpful descriptions
#------------------------------------------------------------------------------
help: ## Show this help
	@echo "Usage: make [target]"
	@echo
	@echo "Primary targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .+$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Variables:"
	@echo "  USE_MUSL=1       — compile fully-static binaries using musl-gcc"
	@echo "  COVERAGE=1       — enable gcov instrumentation for coverage reports"

# Default help on no args
.PHONY: help
ifneq ($(filter help,$(MAKECMDGOALS)),help)
ifeq ($(MAKECMDGOALS),)
.DEFAULT_GOAL := help
endif
endif