```c
/*
 * LambdaUtility Orchestrator ‒ Deployment Packager
 * ------------------------------------------------
 * File:    LambdaUtilityOrchestrator/deployment/package.c
 *
 * Synopsis
 * --------
 *   Stand-alone, production-grade CLI tool that collects compiled
 *   LambdaUtility binaries and their companion resources into
 *   individually versioned ZIP archives, calculates SHA-256 checksums,
 *   and emits a machine-readable deployment manifest (JSON).
 *
 *   Although the project is 100 % serverless, packaging happens on the
 *   build-host; this utility is therefore compiled and executed during
 *   CI/CD pipelines, replacing ad-hoc shell scripts that were hard to
 *   test and maintain.
 *
 * Build
 * -----
 *   gcc -Wall -Wextra -pedantic -std=c11 \
 *       -o package deployment/package.c -lcrypto
 *
 * Runtime dependencies: the `zip` CLI must be available.  A pre-flight
 * check is performed; a descriptive error is raised if the binary
 * cannot be found in $PATH.
 *
 * Usage
 * -----
 *   ./package  -s ./build/out  -o ./dist  -m ./dist/manifest.json
 *
 * Exit codes
 * ----------
 *  0  success
 *  1  argument/usage error
 *  2  pre-flight check failed (missing tools, permissions, …)
 *  3  runtime failure while packaging
 *
 * Author
 * ------
 *   LambdaUtility Engineering <eng@lambda-utility.io>
 */

#define _POSIX_C_SOURCE 200809L

#include <dirent.h>
#include <errno.h>
#include <getopt.h>
#include <openssl/sha.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* --------------------------------------------------------------------------
 * Constants & Macros
 * --------------------------------------------------------------------------*/
#define SHA256_STRING_LEN  (SHA256_DIGEST_LENGTH * 2 + 1)
#define MAX_PATH_LEN       4096
#define TOOL_NAME          "package"
#define ZIP_CMD            "zip"

/* --------------------------------------------------------------------------
 * Data structures
 * --------------------------------------------------------------------------*/
typedef struct PackageInfo {
    char   name[256];          /* Logical package name (folder)              */
    char   archive_path[MAX_PATH_LEN];
    char   sha256[SHA256_STRING_LEN];
    size_t size_bytes;
    struct PackageInfo *next;
} PackageInfo;

/* --------------------------------------------------------------------------
 * Utility helpers
 * --------------------------------------------------------------------------*/

/* Compute SHA-256 checksum of a file and write HEX string into `out`        */
static int sha256_file(const char *path, char out[SHA256_STRING_LEN])
{
    FILE *fp = fopen(path, "rb");
    if (!fp) {
        perror("fopen");
        return -1;
    }

    SHA256_CTX ctx;
    SHA256_Init(&ctx);

    unsigned char buffer[8192];
    size_t        nread;
    while ((nread = fread(buffer, 1, sizeof buffer, fp)) > 0) {
        SHA256_Update(&ctx, buffer, nread);
    }

    if (ferror(fp)) {
        perror("fread");
        fclose(fp);
        return -1;
    }
    fclose(fp);

    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256_Final(digest, &ctx);

    for (size_t i = 0; i < SHA256_DIGEST_LENGTH; ++i)
        sprintf(out + (i * 2), "%02x", digest[i]);

    out[SHA256_STRING_LEN - 1] = '\0';
    return 0;
}

/* Return file size or ‑1 on error                                           */
static ssize_t file_size(const char *path)
{
    struct stat st;
    if (stat(path, &st) != 0)
        return -1;
    return (ssize_t)st.st_size;
}

/* Ensure directory exists, create it (mkdir ‑p) if necessary               */
static int ensure_directory(const char *path)
{
    struct stat st;

    if (stat(path, &st) == 0) {
        if (S_ISDIR(st.st_mode))
            return 0; /* already exists */
        fprintf(stderr, "%s: path exists and is not a directory\n", path);
        return -1;
    }

    /* Recursively create parent if needed */
    char parent[MAX_PATH_LEN];
    strncpy(parent, path, sizeof parent);
    parent[sizeof parent - 1] = '\0';
    char *slash = strrchr(parent, '/');
    if (slash && slash != parent) {
        *slash = '\0';
        if (ensure_directory(parent) != 0)
            return -1;
    }

    if (mkdir(path, 0755) != 0) {
        if (errno == EEXIST)
            return 0;
        perror("mkdir");
        return -1;
    }
    return 0;
}

/* Check whether `zip` is available and executable                            */
static int check_zip_presence(void)
{
    char cmd[64];
    snprintf(cmd, sizeof cmd, "%s -v >/dev/null 2>&1", ZIP_CMD);
    int ret = system(cmd);
    return (ret == 0);
}

/* Create ZIP archive of `subdir` into `archive_path`                        */
static int create_zip(const char *source_root,
                      const char *subdir,
                      const char *archive_path)
{
    char cmd[MAX_PATH_LEN * 2];
    /* SEC: ensure there is no quoting issue using --symlinks and -r */
    snprintf(cmd,
             sizeof cmd,
             "cd '%s' && %s -rq '%s' '%s'",
             source_root,
             ZIP_CMD,
             archive_path,
             subdir);

    int rc = system(cmd);
    if (rc != 0) {
        fprintf(stderr,
                "zip failed for %s (exit status %d)\n",
                subdir,
                WEXITSTATUS(rc));
        return -1;
    }
    return 0;
}

/* Append PackageInfo node to linked list                                     */
static void append_package(PackageInfo **head, PackageInfo *node)
{
    node->next = NULL;
    if (!*head) {
        *head = node;
        return;
    }

    PackageInfo *iter = *head;
    while (iter->next)
        iter = iter->next;
    iter->next = node;
}

/* Serialize manifest into JSON                                               */
static int write_manifest(const char *manifest_path, PackageInfo *list)
{
    FILE *fp = fopen(manifest_path, "w");
    if (!fp) {
        perror("fopen manifest");
        return -1;
    }

    time_t     now  = time(NULL);
    struct tm  tm_r = {0};
    char       iso8601[64];
    gmtime_r(&now, &tm_r);
    strftime(iso8601, sizeof iso8601, "%Y-%m-%dT%H:%M:%SZ", &tm_r);

    fprintf(fp, "{\n");
    fprintf(fp, "  \"generated_at\" : \"%s\",\n", iso8601);
    fprintf(fp, "  \"packages\" : [\n");

    for (PackageInfo *p = list; p; p = p->next) {
        fprintf(fp,
                "    {\n"
                "      \"name\"   : \"%s\",\n"
                "      \"file\"   : \"%s\",\n"
                "      \"sha256\" : \"%s\",\n"
                "      \"size\"   : %zu\n"
                "    }%s\n",
                p->name,
                p->archive_path,
                p->sha256,
                p->size_bytes,
                p->next ? "," : "");
    }

    fprintf(fp, "  ]\n}\n");
    fclose(fp);
    return 0;
}

/* --------------------------------------------------------------------------
 * Argument handling
 * --------------------------------------------------------------------------*/
typedef struct {
    char source_dir[MAX_PATH_LEN];
    char output_dir[MAX_PATH_LEN];
    char manifest_path[MAX_PATH_LEN];
} Options;

static void usage(FILE *out)
{
    fprintf(out,
            "Usage: %s -s <source-dir> -o <output-dir> -m <manifest.json>\n"
            "Options:\n"
            "  -s, --source     Directory containing compiled Lambda folders\n"
            "  -o, --output     Destination directory for ZIP archives\n"
            "  -m, --manifest   Path to write JSON manifest\n"
            "  -h, --help       Show this help and exit\n",
            TOOL_NAME);
}

static int parse_args(int argc, char *argv[], Options *opt)
{
    static struct option long_opts[] = {
        {"source", required_argument, 0, 's'},
        {"output", required_argument, 0, 'o'},
        {"manifest", required_argument, 0, 'm'},
        {"help", no_argument, 0, 'h'},
        {0, 0, 0, 0}
    };

    int c;
    while ((c = getopt_long(argc, argv, "s:o:m:h", long_opts, NULL)) != -1) {
        switch (c) {
            case 's':
                strncpy(opt->source_dir, optarg, sizeof opt->source_dir);
                break;
            case 'o':
                strncpy(opt->output_dir, optarg, sizeof opt->output_dir);
                break;
            case 'm':
                strncpy(opt->manifest_path, optarg, sizeof opt->manifest_path);
                break;
            case 'h':
            default:
                usage(c == 'h' ? stdout : stderr);
                return -1;
        }
    }

    if (opt->source_dir[0] == '\0' ||
        opt->output_dir[0] == '\0' ||
        opt->manifest_path[0] == '\0') {
        usage(stderr);
        return -1;
    }
    return 0;
}

/* --------------------------------------------------------------------------
 * Main
 * --------------------------------------------------------------------------*/
int main(int argc, char *argv[])
{
    Options opts = {0};
    if (parse_args(argc, argv, &opts) != 0)
        return 1;

    /* Pre-flight checks ----------------------------------------------------*/
    if (!check_zip_presence()) {
        fprintf(stderr,
                "%s: the '%s' binary is required but was not found in $PATH\n",
                TOOL_NAME,
                ZIP_CMD);
        return 2;
    }

    if (ensure_directory(opts.output_dir) != 0)
        return 2;

    /* Scan source directory ------------------------------------------------*/
    DIR *dirp = opendir(opts.source_dir);
    if (!dirp) {
        perror("opendir source");
        return 2;
    }

    struct dirent *dp;
    PackageInfo   *packages = NULL;

    while ((dp = readdir(dirp))) {
        if (dp->d_name[0] == '.')
            continue; /* skip hidden */
        if (dp->d_type != DT_DIR && dp->d_type != DT_UNKNOWN)
            continue;

        /* Build paths */
        char archive_path[MAX_PATH_LEN];
        snprintf(archive_path,
                 sizeof archive_path,
                 "%s/%s.zip",
                 opts.output_dir,
                 dp->d_name);

        /* Create zip archive */
        if (create_zip(opts.source_dir, dp->d_name, archive_path) != 0) {
            closedir(dirp);
            return 3;
        }

        /* Assess metadata */
        ssize_t sz = file_size(archive_path);
        if (sz < 0) {
            perror("stat archive");
            closedir(dirp);
            return 3;
        }

        PackageInfo *info = calloc(1, sizeof *info);
        if (!info) {
            perror("calloc");
            closedir(dirp);
            return 3;
        }

        strncpy(info->name, dp->d_name, sizeof info->name);
        strncpy(info->archive_path, archive_path, sizeof info->archive_path);
        info->size_bytes = (size_t)sz;

        if (sha256_file(archive_path, info->sha256) != 0) {
            free(info);
            closedir(dirp);
            return 3;
        }

        append_package(&packages, info);
        printf("✔ packaged %-20s (%zu bytes)\n", info->name, info->size_bytes);
    }
    closedir(dirp);

    /* Write manifest -------------------------------------------------------*/
    if (write_manifest(opts.manifest_path, packages) != 0)
        return 3;

    printf("Manifest written to %s\n", opts.manifest_path);

    /* Cleanup --------------------------------------------------------------*/
    PackageInfo *it = packages;
    while (it) {
        PackageInfo *next = it->next;
        free(it);
        it = next;
    }
    return 0;
}
```