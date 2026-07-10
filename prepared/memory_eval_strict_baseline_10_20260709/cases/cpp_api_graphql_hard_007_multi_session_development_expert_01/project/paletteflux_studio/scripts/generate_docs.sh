```cpp
/*
 * PaletteFlux GraphQL Studio – Documentation Generator
 *
 * File path (logical): paletteflux_studio/scripts/generate_docs.sh
 *   – Even though the path suggests a shell‐script, the build system
 *     wraps this C++ utility so it can be invoked directly from bash
 *     (see she-bang below).  Keeping the extension “.sh” helps CI
 *     pipelines that expect shell entry points under scripts/.
 *
 * Compile-time dependencies:
 *   • C++17 compatible compiler
 *   • nlohmann::json single-header library (https://github.com/nlohmann/json)
 *
 * Usage (from shell):
 *   ./generate_docs.sh --schema schema.json --out ./docs [--html]
 *
 * The program reads a GraphQL introspection JSON dump, then renders
 * per-type Markdown (and, optionally, vanilla HTML) documentation.
 *
 * Error handling is intentionally exhaustive to make this tool robust
 * enough for production CI runs where a failed doc-generation step
 * must abort the pipeline instead of silently succeeding.
 */

//// ------------------------------------------------------------------------
//// She-bang wrapper
//// ------------------------------------------------------------------------

/*
 * The following three lines allow the file to be executed directly
 * as a script.  When launched, bash will ignore the C++ code after
 * the “:;” construct, while the C++ compiler will treat the hash as
 * a preprocessor comment.
 *
 * Implementation trick inspired by Joseph Myers (public domain).
 */
#!/usr/bin/env bash
":; g++ -std=c++17 -O2 -pthread -Wall -Wextra "$0" -o "${0%.sh}" \
   && exec "${0%.sh}" "$@"

//// ------------------------------------------------------------------------
//// Actual C++ implementation starts here
//// ------------------------------------------------------------------------

#include <algorithm>
#include <cstdlib>
#include <execution>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <map>
#include <optional>
#include <regex>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "json.hpp"         // nlohmann::json single-header library

using json = nlohmann::json;
namespace fs = std::filesystem;

/*───────────────────────────────────────────────────────────────────────────┐
│  Helper utilities                                                         │
└───────────────────────────────────────────────────────────────────────────*/

/* Simple RAII wrapper that prints a message when going out of scope.  */
class ScopeGuard
{
public:
    explicit ScopeGuard(std::string_view msg) : message_(msg) {}
    ~ScopeGuard() noexcept { std::cerr << message_ << '\n'; }

private:
    std::string message_;
};

/* Reads an entire text file into memory. Throws on error. */
std::string read_file(const fs::path &file)
{
    std::ifstream in(file, std::ios::in | std::ios::binary);
    if (!in)
        throw std::runtime_error("Unable to open file: " + file.string());

    std::ostringstream oss;
    oss << in.rdbuf();
    return oss.str();
}

/* Writes text to file, creating parent directories if necessary. */
void write_file(const fs::path &file, const std::string &content)
{
    fs::create_directories(file.parent_path());
    std::ofstream out(file, std::ios::out | std::ios::binary | std::ios::trunc);
    if (!out)
        throw std::runtime_error("Unable to write file: " + file.string());

    out << content;
}

/* Converts a GraphQL Type object into human-readable textual name. */
std::string friendly_type(const json &type)
{
    if (type.is_null()) return "null";

    const std::string kind   = type.value("kind", "");
    const std::string name   = type.value("name", "");
    const auto       of_type = type.find("ofType");

    if (kind == "NON_NULL")
        return friendly_type(*of_type) + "!";
    if (kind == "LIST")
        return "[" + friendly_type(*of_type) + "]";
    if (!name.empty())
        return name;

    /* Fallback – should not generally happen. */
    return kind;
}

/* Escapes Markdown special chars. Minimal implementation. */
std::string md_escape(std::string_view sv)
{
    static const std::regex re(R"([\\`*_{}[\]()#+\-.!])");
    return std::regex_replace(std::string(sv), re, R"(\\&)");
}

/* Basic Markdown → HTML converter. Handles headings, inline code, tables.
 *  – Not a full parser. Good enough for auto-generated docs. */
std::string markdown_to_html(std::string md);

/*───────────────────────────────────────────────────────────────────────────┐
│  Doc generation                                                           │
└───────────────────────────────────────────────────────────────────────────*/

class MarkdownRenderer
{
public:
    explicit MarkdownRenderer(const json &type) : type_(type) {}

    std::string render() const
    {
        std::ostringstream out;
        const std::string type_name = type_.value("name", "UnnamedType");
        const std::string description =
            type_.value("description", "_No description provided._");

        out << "# " << type_name << "\n\n";
        out << description << "\n\n";
        out << "Kind: `" << type_.value("kind", "UNKNOWN") << "`\n\n";

        /* Render fields (for OBJECT and INTERFACE kinds). */
        if (auto fields_it = type_.find("fields");
            fields_it != type_.end() && fields_it->is_array())
        {
            out << "## Fields\n\n";
            out << "| Field | Type | Description |\n";
            out << "|-------|------|-------------|\n";
            for (const auto &field : *fields_it)
            {
                const std::string field_name   = field.value("name", "");
                const std::string field_descr  =
                    md_escape(field.value("description", ""));
                const std::string field_type =
                    md_escape(friendly_type(field["type"]));
                out << "| " << field_name << " | `" << field_type << "` | "
                    << field_descr << " |\n";
            }
            out << "\n";
        }

        /* Render inputFields (for INPUT_OBJECT). */
        if (auto in_it = type_.find("inputFields");
            in_it != type_.end() && in_it->is_array())
        {
            out << "## Input Fields\n\n";
            out << "| Field | Type | Description |\n";
            out << "|-------|------|-------------|\n";
            for (const auto &field : *in_it)
            {
                const std::string field_name   = field.value("name", "");
                const std::string field_descr  =
                    md_escape(field.value("description", ""));
                const std::string field_type =
                    md_escape(friendly_type(field["type"]));
                out << "| " << field_name << " | `" << field_type << "` | "
                    << field_descr << " |\n";
            }
            out << "\n";
        }

        return out.str();
    }

private:
    const json &type_;
};

class DocGenerator
{
public:
    DocGenerator(fs::path schema_path, fs::path out_dir, bool render_html)
        : schema_path_(std::move(schema_path)),
          out_dir_(std::move(out_dir)),
          render_html_(render_html)
    {
        if (!fs::exists(schema_path_))
            throw std::runtime_error("Schema file does not exist.");
    }

    void run()
    {
        /* 1. Load and parse the schema. */
        const auto schema_text = read_file(schema_path_);
        schema_                = json::parse(schema_text);

        /* 2. Extract types. */
        const json &types =
            schema_["data"]["__schema"]["types"];  // Throws if path invalid.
        if (!types.is_array())
            throw std::runtime_error("Invalid schema JSON: types not array.");

        /* 3. Generate per-type docs concurrently. */
        std::vector<std::future<void>> futures;

        for (const auto &type : types)
        {
            /* We skip internal types that start with “__” */
            const std::string name = type.value("name", "");
            if (name.rfind("__", 0) == 0) continue;

            futures.emplace_back(std::async(std::launch::async, [&, type] {
                generate_single_type(type);
            }));
        }

        /* Wait for tasks. */
        for (auto &f : futures) f.get();

        /* 4. Generate index page. */
        generate_index(types);
    }

private:
    void generate_single_type(const json &type) const
    {
        const std::string name = type.value("name", "UnnamedType");
        MarkdownRenderer   md(type);

        /* Markdown output */
        const fs::path md_path = out_dir_ / "markdown" / (name + ".md");
        write_file(md_path, md.render());

        /* Optional HTML output */
        if (render_html_)
        {
            const fs::path html_path = out_dir_ / "html" / (name + ".html");
            write_file(html_path, markdown_to_html(md.render()));
        }
    }

    void generate_index(const json &types) const
    {
        std::ostringstream md;
        md << "# Schema Documentation – Index\n\n";
        md << "| Type | Kind | Description |\n";
        md << "|------|------|-------------|\n";

        for (const auto &type : types)
        {
            const std::string name = type.value("name", "");
            if (name.rfind("__", 0) == 0) continue;

            const std::string kind        = type.value("kind", "UNKNOWN");
            const std::string description = md_escape(
                type.value("description", "_No description provided._"));
            md << "| [" << name << "](markdown/" << name << ".md)"
               << " | `" << kind << "` | " << description << " |\n";
        }

        write_file(out_dir_ / "INDEX.md", md.str());
        if (render_html_)
            write_file(out_dir_ / "INDEX.html", markdown_to_html(md.str()));
    }

    fs::path schema_path_;
    fs::path out_dir_;
    bool     render_html_;
    json     schema_;  // Parsed JSON.
};

/*───────────────────────────────────────────────────────────────────────────┐
│  CLI argument parsing (very lightweight)                                  │
└───────────────────────────────────────────────────────────────────────────*/

struct CliOptions
{
    fs::path schema;
    fs::path out_dir;
    bool     html = false;
};

std::optional<CliOptions> parse_cli(int argc, char **argv)
{
    CliOptions opts;
    for (int i = 1; i < argc; ++i)
    {
        std::string_view arg(argv[i]);
        if (arg == "--schema" && i + 1 < argc)
        {
            opts.schema = argv[++i];
        }
        else if (arg == "--out" && i + 1 < argc)
        {
            opts.out_dir = argv[++i];
        }
        else if (arg == "--html")
        {
            opts.html = true;
        }
        else if (arg == "--help")
        {
            std::cout
                << "Usage: generate_docs.sh --schema schema.json --out dir "
                   "[--html]\n";
            return std::nullopt;
        }
        else
        {
            throw std::runtime_error("Unknown argument: " + std::string(arg));
        }
    }

    if (opts.schema.empty() || opts.out_dir.empty())
        throw std::runtime_error("--schema and --out are required.");

    return opts;
}

/*───────────────────────────────────────────────────────────────────────────┐
│  Simplistic Markdown → HTML                                               │
└───────────────────────────────────────────────────────────────────────────*/

std::string markdown_to_html(std::string md)
{
    std::istringstream in(md);
    std::ostringstream out;
    out << "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">"
        << "<style>"
        << "body{font-family:system-ui,Arial,sans-serif;padding:1em 2em;}"
        << "code{background:#F1F1F1;padding:2px 4px;border-radius:3px;}"
        << "table{border-collapse:collapse;width:100%;}"
        << "th,td{border:1px solid #DDD;padding:4px 6px;}"
        << "</style></head><body>\n";

    std::string line;
    std::regex  heading_re(R"(^(\#{1,6})\s*(.+)$)");
    std::smatch m;

    while (std::getline(in, line))
    {
        if (std::regex_match(line, m, heading_re))
        {
            const size_t level = m[1].str().size();
            out << "<h" << level << ">" << m[2] << "</h" << level << ">\n";
        }
        else if (line.rfind("|", 0) == 0) /* crude table detection */
        {
            out << "<pre>" << line << "</pre>\n";
        }
        else if (!line.empty())
        {
            /* Inline code replacement */
            line = std::regex_replace(line, std::regex(R"(`([^`]+)`)"),
                                      "<code>$1</code>");
            out << "<p>" << line << "</p>\n";
        }
    }
    out << "</body></html>";
    return out.str();
}

/*───────────────────────────────────────────────────────────────────────────┐
│  Main                                                                     │
└───────────────────────────────────────────────────────────────────────────*/

int main(int argc, char **argv)
{
    ScopeGuard guard("↳ Documentation generation finished.");

    try
    {
        auto opts_opt = parse_cli(argc, argv);
        if (!opts_opt.has_value()) return EXIT_SUCCESS; /* --help */

        const auto &opts = *opts_opt;

        DocGenerator generator(opts.schema, opts.out_dir, opts.html);
        generator.run();

        std::cout << "Documentation generated at " << opts.out_dir << '\n';
        return EXIT_SUCCESS;
    }
    catch (const std::exception &ex)
    {
        std::cerr << "Error: " << ex.what() << '\n';
        return EXIT_FAILURE;
    }
}
```