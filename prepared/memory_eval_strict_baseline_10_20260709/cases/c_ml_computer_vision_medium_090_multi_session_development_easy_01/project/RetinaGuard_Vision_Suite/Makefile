# =============================================================================
# RetinaGuard Vision Suite – Makefile
#
# This Makefile builds the entire RetinaGuard monolithic executable as well as
# auxiliary utilities (unit-tests, documentation, static-analysis, formatting,
# installation, etc.).  It is written for GNU Make ≥ 4.0 and assumes a POSIX
# shell, but it has been tested on Linux and macOS.  Windows users are advised
# to leverage WSL2 or MSYS2 for a consistent tool-chain.
#
# Author  : RetinaGuard Engineering
# License : Apache-2.0
# =============================================================================

# -----------------------------------------------------------------------------#
#  Tool-chain configuration                                                    #
# -----------------------------------------------------------------------------#
# The default compiler can be overridden from the command-line, e.g.:
#     $ make CC=clang
CC              ?= gcc
PKG_CONFIG       = pkg-config
AR               = ar
RM               = rm -f

# -----------------------------------------------------------------------------#
#  Project metadata                                                            #
# -----------------------------------------------------------------------------#
APP_NAME         = retinalguard
APP_VERSION      = 1.3.0
BUILD_DIR        = build
DIST_DIR         = dist
UNIT_TEST_DIR    = tests
DOC_DIR          = docs

# -----------------------------------------------------------------------------#
#  Source layout                                                               #
# -----------------------------------------------------------------------------#
SRC_DIRS         = src modules feature_engineering visualization mlops
INC_DIRS         = include third_party/include $(SRC_DIRS:%=%/include)

# Recursively collect all C sources
SRCS             = $(shell find $(SRC_DIRS) -type f -name '*.c' | sort)
OBJS             = $(SRCS:%=$(BUILD_DIR)/%.o)
DEPS             = $(OBJS:.o=.d)

# -----------------------------------------------------------------------------#
#  External libraries                                                          #
# -----------------------------------------------------------------------------#
# Pkg-config is used when available because it simplifies cross-platform builds
LIBS_PKGCONF     = opencv4 sqlite3 json-c
LIBS             = $(shell $(PKG_CONFIG) --libs $(LIBS_PKGCONF) 2>/dev/null)
INC_PKGCONF      = $(shell $(PKG_CONFIG) --cflags $(LIBS_PKGCONF) 2>/dev/null)

# Manual fallbacks
LIBS            += -lm -lpthread
INC_MANUAL       =

# -----------------------------------------------------------------------------#
#  Build flags                                                                 #
# -----------------------------------------------------------------------------#
COMMON_WARNINGS  = -Wall -Wextra -Wpedantic -Werror
COMMON_CFLAGS    = -std=c11 -fPIC $(COMMON_WARNINGS) -fvisibility=hidden \
                   -DAPP_VERSION=\"$(APP_VERSION)\"
COMMON_CPPFLAGS  = $(INC_PKGCONF) $(INC_MANUAL) $(INC_DIRS:%=-I%)

# Optimised release build
RELEASE_CFLAGS   = -O3 -DNDEBUG

# Debug build
DEBUG_CFLAGS     = -Og -g3 -fsanitize=undefined,address \
                   -fno-omit-frame-pointer -DDEBUG=1

# Test coverage
COVER_CFLAGS     = -Og --coverage
COVER_LDFLAGS    = --coverage

# Let the user decide
BUILD_TYPE      ?= release
ifeq ($(BUILD_TYPE),debug)
	CFLAGS  += $(COMMON_CFLAGS) $(DEBUG_CFLAGS)
else ifeq ($(BUILD_TYPE),coverage)
	CFLAGS  += $(COMMON_CFLAGS) $(COVER_CFLAGS)
	LDFLAGS += $(COVER_LDFLAGS)
else
	CFLAGS  += $(COMMON_CFLAGS) $(RELEASE_CFLAGS)
endif
CPPFLAGS        += $(COMMON_CPPFLAGS)

# -----------------------------------------------------------------------------#
#  Helpers                                                                     #
# -----------------------------------------------------------------------------#
# Automatically create output directories
$(BUILD_DIR)/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

# -----------------------------------------------------------------------------#
#  Targets                                                                     #
# -----------------------------------------------------------------------------#
.PHONY: all default debug coverage run clean distclean install uninstall \
        format lint docs test analysis

default: all
all: $(DIST_DIR)/$(APP_NAME)

debug:
	$(MAKE) BUILD_TYPE=debug

coverage:
	$(MAKE) BUILD_TYPE=coverage

# Link the main executable
$(DIST_DIR)/$(APP_NAME): $(OBJS)
	@mkdir -p $(DIST_DIR)
	$(CC) $(OBJS) $(LDFLAGS) $(LIBS) -o $@

# -----------------------------------------------------------------------------#
#  Unit tests (Criterion)                                                      #
# -----------------------------------------------------------------------------#
TEST_BIN        = $(BUILD_DIR)/$(UNIT_TEST_DIR)/unit_tests

TEST_SRCS       = $(shell find $(UNIT_TEST_DIR) -type f -name '*_test.c')
TEST_OBJS       = $(TEST_SRCS:%=$(BUILD_DIR)/%.o)

ifeq ($(strip $(TEST_SRCS)),)
# No tests
else
$(TEST_BIN): $(TEST_OBJS) $(filter-out $(BUILD_DIR)/main.o,$(OBJS))
	@mkdir -p $(dir $@)
	$(CC) $^ $(LDFLAGS) $(LIBS) -lcriterion -o $@

test: $(TEST_BIN)
	$< --reporter=compact
endif

# -----------------------------------------------------------------------------#
#  Static analysis & linting                                                   #
# -----------------------------------------------------------------------------#
CPPCHECK        = cppcheck
CLANG_TIDY      = clang-tidy

analysis:
	@echo "→ Running cppcheck..."
	@$(CPPCHECK) --enable=all --inconclusive --quiet --std=c11 \
	             --error-exitcode=1 $(SRC_DIRS) $(UNIT_TEST_DIR)
	@echo "→ Running clang-tidy..."
	@$(CLANG_TIDY) $(SRCS) -- -std=c11 $(COMMON_CPPFLAGS)

# -----------------------------------------------------------------------------#
#  Code formatting                                                             #
# -----------------------------------------------------------------------------#
CLANG_FORMAT    = clang-format
FORMAT_EXTS     = c h

format:
	@echo "→ Formatting source files..."
	@find $(SRC_DIRS) $(UNIT_TEST_DIR) $(INC_DIRS) -type f \( \
	      -name '*.[ch]' \) -exec $(CLANG_FORMAT) -i {} +

# -----------------------------------------------------------------------------#
#  Documentation                                                               #
# -----------------------------------------------------------------------------#
DOXYGEN         = doxygen
docs:
	$(DOXYGEN) Doxyfile

# -----------------------------------------------------------------------------#
#  Installation                                                                #
# -----------------------------------------------------------------------------#
PREFIX          ?= /usr/local
BINDIR           = $(PREFIX)/bin
MANDIR           = $(PREFIX)/share/man

install: $(DIST_DIR)/$(APP_NAME)
	@echo "→ Installing $(APP_NAME) to $(BINDIR)"
	@install -d $(BINDIR)
	@install -m 0755 $(DIST_DIR)/$(APP_NAME) $(BINDIR)/$(APP_NAME)

uninstall:
	@echo "→ Removing installed binary"
	@$(RM) $(BINDIR)/$(APP_NAME)

# -----------------------------------------------------------------------------#
#  Convenience targets                                                         #
# -----------------------------------------------------------------------------#
run: all
	./$(DIST_DIR)/$(APP_NAME) $(RUN_ARGS)

clean:
	$(RM) -r $(BUILD_DIR) $(DIST_DIR)

distclean: clean
	$(RM) -r $(DOC_DIR) *.gc* *.info

# -----------------------------------------------------------------------------#
#  Dependency management                                                       #
# -----------------------------------------------------------------------------#
-include $(DEPS)

# End of Makefile
