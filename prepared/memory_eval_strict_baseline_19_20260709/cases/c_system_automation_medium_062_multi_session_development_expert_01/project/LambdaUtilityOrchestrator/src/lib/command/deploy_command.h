#ifndef LU_DEPLOY_COMMAND_H_
#define LU_DEPLOY_COMMAND_H_
/*
 * LambdaUtility Orchestrator
 * File:  src/lib/command/deploy_command.h
 *
 * Copyright (c) 2023–2024 LambdaUtility
 *
 * Description:
 *   Concrete Command that performs an automated software deployment.  It
 *   implements the Command-Pattern interface (lu_command_t) used throughout
 *   the project to build dynamic chains of actions.  The implementation is
 *   intentionally header-only so that small Lambda build-units can simply
 *   include this file without having to worry about linker ordering.  If
 *   you prefer a traditional split, compile this header once with
 *   LU_DEPLOY_COMMAND_IMPLEMENTATION defined in a single translation unit.
 *
 *   The command is intentionally self-contained, uses only the standard C
 *   library, and relies on well-known user-space tools (curl, sha256sum,
 *   scp/rsync, systemd) that are expected to be available inside the
 *   Lambda’s execution environment.
 */

#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifdef __cplusplus
extern "C" {
#endif

/**********************************************************************
 * Minimal shared infrastructure
 *********************************************************************/
/* Forward declaration of a generic event that the command might use. */
typedef struct lu_event_s {
    const char *id;          /* Unique event identifier  */
    const char *type;        /* e.g. “deploy_request”    */
    const char *payload;     /* Optional JSON payload    */
} lu_event_t;

/* Command v-table */
typedef struct lu_command_vtable_s {
    int  (*execute)(void *self, const lu_event_t *event);
    void (*destroy)(void *self);
} lu_command_vtable_t;

/* Command base type.  All concrete commands must embed this first. */
typedef struct lu_command_s {
    const lu_command_vtable_t *vtable;
} lu_command_t;


/**********************************************************************
 * DeployCommand public interface
 *********************************************************************/
/*
 * A convenience wrapper that hides the actual concrete struct and returns a
 * pointer to the base class, enabling polymorphic treatment.
 *
 * Parameters
 *   artifact_uri      : Remote artifact to download (http/https/s3/…)
 *   target_host       : Host where the artifact will be deployed
 *                       (“localhost” accepted for local deployment)
 *   service_name      : Name of the systemd service that has to be restarted
 *   post_deploy_hook  : Optional shell script to run after successful rollout
 *   verify_checksum   : Whether checksum verification is required
 *   timeout_sec       : Hard execution timeout.  0 = no timeout.
 *
 * Returns
 *   Pointer to lu_command_t on success; NULL on allocation failure.
 */
lu_command_t *
lu_deploy_command_create(const char *artifact_uri,
                         const char *target_host,
                         const char *service_name,
                         const char *post_deploy_hook,
                         bool        verify_checksum,
                         uint32_t    timeout_sec);


/**********************************************************************
 *                     Implementation Section
 *   Define LU_DEPLOY_COMMAND_IMPLEMENTATION in exactly one .c file to
 *   generate the code.  Every other compilation unit will only see the
 *   declarations above, eliminating ODR/multiple-definition problems.
 *********************************************************************/
#ifdef LU_DEPLOY_COMMAND_IMPLEMENTATION

/* ---- PRIVATE DEFINITIONS ---------------------------------------- */
#define LU_DEPLOY_TMP_TEMPLATE  "/tmp/lu-deploy-XXXXXX"

typedef struct deploy_command_s {
    lu_command_t  base;

    /* Immutable deployment parameters */
    char         *artifact_uri;
    char         *target_host;
    char         *service_name;
    char         *post_deploy_hook;
    bool          verify_checksum;
    uint32_t      timeout_sec;

    /* Internal state */
    char         *tmp_file;          /* Downloaded artifact path        */
} deploy_command_t;


/* Forward declarations */
static int  _deploy_execute        (void *self, const lu_event_t *event);
static void _deploy_destroy        (void *self);
static int  _download_artifact     (deploy_command_t *cmd);
static int  _verify_checksum       (deploy_command_t *cmd,
                                    const lu_event_t *event);
static int  _push_and_restart      (deploy_command_t *cmd);
static int  _run_post_deploy_hook  (deploy_command_t *cmd);
static void _activate_timeout_alarm(uint32_t timeout_sec);


/* V-table instance (constexpr) */
static const lu_command_vtable_t _deploy_vtable = {
    .execute = _deploy_execute,
    .destroy = _deploy_destroy
};


/* ---- PUBLIC FACTORY --------------------------------------------- */
lu_command_t *
lu_deploy_command_create(const char *artifact_uri,
                         const char *target_host,
                         const char *service_name,
                         const char *post_deploy_hook,
                         bool        verify_checksum,
                         uint32_t    timeout_sec)
{
    if (!artifact_uri || !*artifact_uri ||
        !target_host   || !*target_host  ||
        !service_name  || !*service_name) {
        fprintf(stderr, "[deploy_command] Invalid constructor argument\n");
        return NULL;
    }

    deploy_command_t *cmd = (deploy_command_t *)calloc(1, sizeof(*cmd));
    if (cmd == NULL) {
        perror("[deploy_command] calloc");
        return NULL;
    }

    /* Duplicate strings so that the caller can free its copies */
    cmd->artifact_uri     = strdup(artifact_uri);
    cmd->target_host      = strdup(target_host);
    cmd->service_name     = strdup(service_name);
    cmd->post_deploy_hook = post_deploy_hook ? strdup(post_deploy_hook) : NULL;
    cmd->verify_checksum  = verify_checksum;
    cmd->timeout_sec      = timeout_sec;
    cmd->base.vtable      = &_deploy_vtable;

    if (!cmd->artifact_uri || !cmd->target_host || !cmd->service_name ||
        (post_deploy_hook && !cmd->post_deploy_hook)) {
        _deploy_destroy(cmd);
        return NULL; /* strdup failed */
    }

    return (lu_command_t *)cmd;
}


/* ---- V-Table Implementation ------------------------------------- */
static int
_deploy_execute(void *self, const lu_event_t *event)
{
    deploy_command_t *cmd = (deploy_command_t *)self;

    /* Apply timeout, if requested */
    _activate_timeout_alarm(cmd->timeout_sec);

    fprintf(stdout,
            "[deploy_command] Starting deployment:\n"
            "  Artifact URI : %s\n"
            "  Target Host  : %s\n"
            "  Service Name : %s\n"
            "  Checksum     : %s\n",
            cmd->artifact_uri,
            cmd->target_host,
            cmd->service_name,
            cmd->verify_checksum ? "enabled" : "disabled");

    int rc;
    if ((rc = _download_artifact(cmd))            != 0) return rc;
    if (cmd->verify_checksum &&
        (rc = _verify_checksum(cmd, event))       != 0) return rc;
    if ((rc = _push_and_restart(cmd))             != 0) return rc;
    if (cmd->post_deploy_hook &&
        (rc = _run_post_deploy_hook(cmd))         != 0) return rc;

    fprintf(stdout, "[deploy_command] Deployment completed successfully\n");
    return 0;
}

static void
_deploy_destroy(void *self)
{
    if (!self) return;
    deploy_command_t *cmd = (deploy_command_t *)self;

    free(cmd->artifact_uri);
    free(cmd->target_host);
    free(cmd->service_name);
    free(cmd->post_deploy_hook);
    if (cmd->tmp_file) {
        unlink(cmd->tmp_file);
        free(cmd->tmp_file);
    }
    memset(cmd, 0, sizeof(*cmd));
    free(cmd);
}


/* ---- HELPER IMPLEMENTATIONS ------------------------------------- */
static int
_download_artifact(deploy_command_t *cmd)
{
    int fd;
    char tmp_path[] = LU_DEPLOY_TMP_TEMPLATE;

    fd = mkstemp(tmp_path);
    if (fd < 0) {
        perror("[deploy_command] mkstemp");
        return -1;
    }
    close(fd); /* We will let curl overwrite the file */

    cmd->tmp_file = strdup(tmp_path);
    if (!cmd->tmp_file) {
        perror("[deploy_command] strdup(tmp_path)");
        unlink(tmp_path);
        return -1;
    }

    char curl_cmd[2048];
    snprintf(curl_cmd, sizeof(curl_cmd),
             "curl -sfL \"%s\" -o \"%s\"",
             cmd->artifact_uri, cmd->tmp_file);

    fprintf(stdout, "[deploy_command] Downloading artifact…\n");
    int rc = system(curl_cmd);
    if (rc != 0) {
        fprintf(stderr,
                "[deploy_command] curl failed with exit status %d\n", rc);
        return -1;
    }
    return 0;
}

/*
 * _verify_checksum()
 *   The expected checksum (hex-encoded SHA-256) can be supplied via
 *   event->payload (JSON) with the following format:
 *     { "sha256": "deadbeef…" }
 *
 *   The function uses /usr/bin/sha256sum for simplicity.  Production code may
 *   prefer a built-in crypto implementation to avoid spawning a process.
 */
static int
_verify_checksum(deploy_command_t *cmd, const lu_event_t *event)
{
    if (!event || !event->payload) {
        fprintf(stderr,
                "[deploy_command] Checksum verification requested but no "
                "checksum provided in the triggering event\n");
        return -1;
    }

    /* Extract the expected checksum from the JSON payload.  A real JSON parser
     * (e.g. cJSON) should be used; to keep the example self-contained we fall
     * back to naive string search. */
    const char *needle = "\"sha256\"";
    const char *p = strstr(event->payload, needle);
    if (!p) {
        fprintf(stderr,
                "[deploy_command] \"sha256\" field not present in payload\n");
        return -1;
    }
    p = strchr(p, ':');
    if (!p) return -1;

    while (*p && (*p == ':' || *p == '"' || *p == ' ')) ++p;

    char expected[65] = {0};
    size_t i = 0;
    while (p[i] && p[i] != '"' && i < sizeof(expected) - 1) {
        expected[i] = p[i];
        ++i;
    }
    expected[i] = 0;

    /* Compute actual checksum */
    char cmd_line[4096];
    snprintf(cmd_line, sizeof(cmd_line),
             "sha256sum \"%s\" | awk '{print $1}'", cmd->tmp_file);

    FILE *fp = popen(cmd_line, "r");
    if (!fp) {
        perror("[deploy_command] popen(sha256sum)");
        return -1;
    }

    char actual[65] = {0};
    if (fgets(actual, sizeof(actual), fp) == NULL) {
        pclose(fp);
        fprintf(stderr, "[deploy_command] Unable to read sha256sum output\n");
        return -1;
    }
    /* Remove trailing newline */
    actual[strcspn(actual, "\n")] = 0;
    pclose(fp);

    if (strcasecmp(expected, actual) != 0) {
        fprintf(stderr,
                "[deploy_command] Checksum mismatch!\n"
                "  expected: %s\n"
                "  actual  : %s\n",
                expected, actual);
        return -1;
    }

    fprintf(stdout, "[deploy_command] Checksum OK\n");
    return 0;
}

/*
 * Push the artifact to the target host and restart the service.
 */
static int
_push_and_restart(deploy_command_t *cmd)
{
    int rc;
    char copy_cmd[4096];

    /* Try rsync first for efficiency; fall back to scp if unavailable. */
    snprintf(copy_cmd, sizeof(copy_cmd),
             "command -v rsync >/dev/null 2>&1 && "
             "rsync -q --checksum \"%s\" \"%s:/tmp/\" || "
             "scp -q \"%s\" \"%s:/tmp/\"",
             cmd->tmp_file, cmd->target_host,
             cmd->tmp_file, cmd->target_host);

    fprintf(stdout, "[deploy_command] Copying artifact to target host…\n");
    rc = system(copy_cmd);
    if (rc != 0) {
        fprintf(stderr, "[deploy_command] Copy command failed (%d)\n", rc);
        return -1;
    }

    /* Move artifact in place and restart the service (systemd). */
    char remote_path_cmd[4096];
    const char *remote_tmp = "/tmp/$(basename \"%s\")";
    snprintf(remote_path_cmd, sizeof(remote_path_cmd), remote_tmp, cmd->tmp_file);

    char ssh_cmd[8192];
    snprintf(ssh_cmd, sizeof(ssh_cmd),
             "ssh -o BatchMode=yes -o StrictHostKeyChecking=no %s "
             "\"sudo install -m 0644 /tmp/$(basename '%s') "
             "/opt/%s/ && "
             "sudo systemctl restart %s\"",
             cmd->target_host,
             cmd->tmp_file,
             cmd->service_name,
             cmd->service_name);

    fprintf(stdout, "[deploy_command] Restarting remote service…\n");
    rc = system(ssh_cmd);
    if (rc != 0) {
        fprintf(stderr, "[deploy_command] Remote restart failed (%d)\n", rc);
        return -1;
    }

    return 0;
}

static int
_run_post_deploy_hook(deploy_command_t *cmd)
{
    fprintf(stdout,
            "[deploy_command] Running post-deploy hook: %s\n",
            cmd->post_deploy_hook);

    int rc = system(cmd->post_deploy_hook);
    if (rc != 0) {
        fprintf(stderr,
                "[deploy_command] Post-deploy hook exited with status %d\n",
                rc);
        return -1;
    }
    return 0;
}

/*
 * Installs an alarm()-based watchdog.  Because Lambda runtimes are generally
 * short-lived the limitation of only one global timer is acceptable.
 */
static void
_handle_sigalrm(int sig)
{
    (void)sig;
    fprintf(stderr, "[deploy_command] Timeout expired, aborting\n");
    _exit(124); /* Similar to GNU timeout exit code */
}

static void
_activate_timeout_alarm(uint32_t timeout_sec)
{
    if (timeout_sec == 0) return;

    struct sigaction sa = {
        .sa_handler = _handle_sigalrm,
        .sa_flags   = SA_RESTART
    };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGALRM, &sa, NULL);
    alarm(timeout_sec);
}

#endif  /* LU_DEPLOY_COMMAND_IMPLEMENTATION */

#ifdef __cplusplus
} /* extern "C" */
#endif
#endif /* LU_DEPLOY_COMMAND_H_ */
