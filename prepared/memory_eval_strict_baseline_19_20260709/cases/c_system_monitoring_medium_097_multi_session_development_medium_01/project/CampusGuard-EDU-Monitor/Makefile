#------------------------------------------------------------------------------
# CampusGuard EDU Monitor - Top-Level Makefile
#
# This Makefile drives the build for the CampusGuard EDU Monitor project.
# It supports:
#   • Debug / Release builds
#   • Automatic dependency generation
#   • Unit-tests, documentation, install / uninstall
#   • Multiple front-ends (ncurses TUI, GTK GUI)
#
# Prerequisites (Ubuntu / Fedora names shown):
#   sudo apt install build-essential pkg-config libsqlite3-dev libncursesw5-dev \
#                    libgtk-3-dev gcovr doxygen
#
#------------------------------------------------------------------------------
# User-tunable section
#------------------------------------------------------------------------------

# Compiler / Linker -----------------------------------------------------------
CC              ?= gcc
AR              ?= ar
RANLIB          ?= ranlib

# Build type ------------------------------------------------------------------
DEBUG           ?= 0                # 1=Debug, 0=Release
OPTIM           ?= -O0              # Will be overridden for Release

ifeq ($(DEBUG),1)
    CFLAGS_BASE = -g -DDEBUG -D_GNU_SOURCE -Wall -Wextra -Wpedantic
    LTO_FLAG    =
    OPTIM       = -O0
    BUILD_TYPE  = debug
else
    CFLAGS_BASE = -DNDEBUG -D_GNU_SOURCE -Wall -Wextra -Werror -Wpedantic
    LTO_FLAG    = -flto
    OPTIM       = -O2
    BUILD_TYPE  = release
endif

# Directories -----------------------------------------------------------------
SRC_DIR         := src
BUILD_DIR       := build/$(BUILD_TYPE)
BIN_DIR         := bin
LIB_DIR         := lib
DOC_DIR         := docs

# Tools -----------------------------------------------------------------------
PKG_CONFIG      := pkg-config
DOXYGEN         := doxygen
GCOVR           := gcovr

# System libraries via pkg-config --------------------------------------------
PKGS_COMMON     := sqlite3
PKGS_TUI        := ncursesw
PKGS_GUI        := gtk+-3.0

CFLAGS_COMMON   := $(shell $(PKG_CONFIG) --cflags $(PKGS_COMMON))
LIBS_COMMON     := $(shell $(PKG_CONFIG) --libs $(PKGS_COMMON))

CFLAGS_TUI      := $(shell $(PKG_CONFIG) --cflags $(PKGS_TUI))
LIBS_TUI        := $(shell $(PKG_CONFIG) --libs $(PKGS_TUI))

CFLAGS_GUI      := $(shell $(PKG_CONFIG) --cflags $(PKGS_GUI))
LIBS_GUI        := $(shell $(PKG_CONFIG) --libs $(PKGS_GUI))

# Public targets --------------------------------------------------------------
.PHONY: all core tui gui agent tests install uninstall clean distclean docs

all: core tui gui agent

################################################################################
# Core static library
################################################################################
CORE_SRC        := $(wildcard $(SRC_DIR)/core/*.c) \
                   $(wildcard $(SRC_DIR)/model/*.c) \
                   $(wildcard $(SRC_DIR)/controller/*.c)
CORE_OBJ        := $(patsubst $(SRC_DIR)/%.c,$(BUILD_DIR)/%.o,$(CORE_SRC))
CORE_LIB        := $(LIB_DIR)/libcampusguard-core.a

core: $(CORE_LIB)

$(CORE_LIB): $(CORE_OBJ) | $(LIB_DIR)
	$(AR) rcs $@ $^
	$(RANLIB) $@

################################################################################
# TUI Front-End (ncurses)
################################################################################
TUI_SRC         := $(wildcard $(SRC_DIR)/view/tui/*.c)
TUI_OBJ         := $(patsubst $(SRC_DIR)/%.c,$(BUILD_DIR)/%.o,$(TUI_SRC))
TUI_BIN         := $(BIN_DIR)/edu-monitor-tui

tui: $(TUI_BIN)

$(TUI_BIN): $(TUI_OBJ) $(CORE_LIB) | $(BIN_DIR)
	$(CC) $(OPTIM) $(LTO_FLAG) $(TUI_OBJ) -o $@ \
	      -L$(LIB_DIR) -lcampusguard-core \
	      $(LIBS_COMMON) $(LIBS_TUI) -lpthread

################################################################################
# GUI Front-End (GTK+ 3.0)
################################################################################
GUI_SRC         := $(wildcard $(SRC_DIR)/view/gtk/*.c)
GUI_OBJ         := $(patsubst $(SRC_DIR)/%.c,$(BUILD_DIR)/%.o,$(GUI_SRC))
GUI_BIN         := $(BIN_DIR)/edu-monitor-gui

gui: $(GUI_BIN)

$(GUI_BIN): $(GUI_OBJ) $(CORE_LIB) | $(BIN_DIR)
	$(CC) $(OPTIM) $(LTO_FLAG) $(GUI_OBJ) -o $@ \
	      -L$(LIB_DIR) -lcampusguard-core \
	      $(LIBS_COMMON) $(LIBS_GUI) -lpthread

################################################################################
# Micro-agent (service-mesh node)
################################################################################
AGENT_SRC       := $(wildcard $(SRC_DIR)/agent/*.c)
AGENT_OBJ       := $(patsubst $(SRC_DIR)/%.c,$(BUILD_DIR)/%.o,$(AGENT_SRC))
AGENT_BIN       := $(BIN_DIR)/edu-agent

agent: $(AGENT_BIN)

$(AGENT_BIN): $(AGENT_OBJ) $(CORE_LIB) | $(BIN_DIR)
	$(CC) $(OPTIM) $(LTO_FLAG) $(AGENT_OBJ) -o $@ \
	      -L$(LIB_DIR) -lcampusguard-core \
	      $(LIBS_COMMON) -lpthread

################################################################################
# Unit-tests (Unity + CMock or similar)
################################################################################
TEST_SRC        := $(wildcard tests/*.c)
TEST_BIN        := $(BIN_DIR)/unit-tests
tests: $(TEST_BIN)

$(TEST_BIN): $(TEST_SRC) $(CORE_LIB) | $(BIN_DIR)
	$(CC) $(CFLAGS_BASE) $(OPTIM) $^ -o $@ \
	      -L$(LIB_DIR) -lcampusguard-core \
	      $(LIBS_COMMON) -lpthread

################################################################################
# Dependency generation and pattern rules
################################################################################
# Create build dir structure on demand
$(BUILD_DIR):
	@mkdir -p $@

# Pattern rule: .c -> .o and .d
# Every .o file resides in build/<type>/<subdir>/.
$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS_BASE) $(OPTIM) \
	      $(CFLAGS_COMMON) $(CFLAGS_TUI) $(CFLAGS_GUI) \
	      -MMD -MP -c $< -o $@

# Include auto-generated dependency files
-include $(CORE_OBJ:.o=.d) $(TUI_OBJ:.o=.d) $(GUI_OBJ:.o=.d) $(AGENT_OBJ:.o=.d)

################################################################################
# Documentation (Doxygen)
################################################################################
docs:
	@echo "Generating API documentation..."
	$(DOXYGEN) Doxyfile

################################################################################
# Install / Uninstall
################################################################################
PREFIX ?= /usr/local
BINDIR := $(PREFIX)/bin
LIBDIR := $(PREFIX)/lib
INCDIR := $(PREFIX)/include/campusguard

install: all
	install -d $(DESTDIR)$(BINDIR) $(DESTDIR)$(LIBDIR) $(DESTDIR)$(INCDIR)
	install -m 755 $(TUI_BIN) $(GUI_BIN) $(AGENT_BIN) $(DESTDIR)$(BINDIR)
	install -m 644 $(CORE_LIB) $(DESTDIR)$(LIBDIR)
	cp -r $(SRC_DIR)/core/*.h $(DESTDIR)$(INCDIR)

uninstall:
	@echo "Removing installed files..."
	@rm -f $(addprefix $(DESTDIR)$(BINDIR)/, $(notdir $(TUI_BIN)) \
	                                         $(notdir $(GUI_BIN)) \
	                                         $(notdir $(AGENT_BIN)))
	@rm -f $(DESTDIR)$(LIBDIR)/$(notdir $(CORE_LIB))
	@rm -rf $(DESTDIR)$(INCDIR)

################################################################################
# Cleaning targets
################################################################################
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf build/$(BUILD_TYPE) $(TEST_BIN)

distclean: clean
	@echo "Removing all generated files..."
	@rm -rf $(BIN_DIR) $(LIB_DIR) $(DOC_DIR) \
	        build debug release *.gcda *.gcno

################################################################################
# Convenience
################################################################################
$(BIN_DIR) $(LIB_DIR):
	@mkdir -p $@

help:
	@echo "CampusGuard EDU Monitor Makefile"
	@echo "Targets:"
	@echo "  all (default)    – Build everything (core, tui, gui, agent)"
	@echo "  core             – Build static core library"
	@echo "  tui              – Build ncurses front-end"
	@echo "  gui              – Build GTK front-end"
	@echo "  agent            – Build service-mesh agent"
	@echo "  tests            – Build unit-tests"
	@echo "  docs             – Generate HTML documentation"
	@echo "  install          – Install to $(PREFIX)"
	@echo "  uninstall        – Remove installed files"
	@echo "  clean / distclean"
	@echo ""
	@echo "Variables:"
	@echo "  DEBUG=1          – Enable debug build"
	@echo "  PREFIX=/path     – Installation prefix (default /usr/local)"
	@echo ""

.DEFAULT_GOAL := all