/********************************************************************
 * RetinaGuard Vision Suite - main.c
 *
 * Copyright (c) 2024  RetinaGuard
 *
 * Entry-point for the monolithic RetinaGuard Vision Suite executable.
 * Orchestrates the full computer-vision pipeline, MLOps background
 * tasks, and Observer Pattern event broadcast.
 *
 * Build:  gcc -Wall -Wextra -pedantic -std=c11 main.c -lpthread -o retina_guard
 *******************************************************************/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <pthread.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <dirent.h>
#include <sys/stat.h>
#include <time.h>

/*-------------------------------------------------------------
 *                              Macros
 *------------------------------------------------------------*/
#define RG_VERSION            "1.4.0"
#define RG_MODEL_PATH         "./resources/model.bin"
#define RG_MAX_LISTENERS      8
#define RG_MAX_PATH           1024
#define RETRAIN_INTERVAL_SEC  (60 * 60 * 24)     /* Once a day  */

/*-------------------------------------------------------------
 *                          Event System
 *------------------------------------------------------------*/
typedef enum
{
    EVENT_MODEL_INFERENCE_COMPLETE,
    EVENT_MODEL_RETRAIN_COMPLETE,
    EVENT_SHUTDOWN
} event_type_t;

typedef struct
{
    event_type_t type;
    void        *payload;   /* Event-specific data; free-ownership stays with sender */
} event_t;

typedef void (*event_cb_t)(const event_t *event, void *user_ctx);

static struct
{
    pthread_mutex_t lock;
    event_cb_t      listeners[RG_MAX_LISTENERS];
    void           *contexts[RG_MAX_LISTENERS];
    size_t          count;
} g_event_bus = { .lock = PTHREAD_MUTEX_INITIALIZER };

/* Register listener */
static bool event_register(event_cb_t cb, void *ctx)
{
    if (!cb) return false;
    pthread_mutex_lock(&g_event_bus.lock);
    if (g_event_bus.count >= RG_MAX_LISTENERS)
    {
        pthread_mutex_unlock(&g_event_bus.lock);
        return false;
    }
    g_event_bus.listeners[g_event_bus.count] = cb;
    g_event_bus.contexts[g_event_bus.count]  = ctx;
    g_event_bus.count++;
    pthread_mutex_unlock(&g_event_bus.lock);
    return true;
}

/* Broadcast event to all listeners (fire-and-forget) */
static void event_broadcast(const event_t *evt)
{
    pthread_mutex_lock(&g_event_bus.lock);
    for (size_t i = 0; i < g_event_bus.count; ++i)
    {
        g_event_bus.listeners[i](evt, g_event_bus.contexts[i]);
    }
    pthread_mutex_unlock(&g_event_bus.lock);
}

/*-------------------------------------------------------------
 *                       Data Structures
 *------------------------------------------------------------*/
typedef struct
{
    char  path[RG_MAX_PATH];
    int   width;
    int   height;
    bool  quality_ok;
    /* Raw pixel data, metadata, etc. omitted for brevity */
} image_t;

typedef struct
{
    char  id[64];
    float risk_score;        /* Value 0..1 */
    char  grade[32];         /* e.g., "Mild NPDR" */
    char  visualization_path[RG_MAX_PATH];
} inference_result_t;

/*-------------------------------------------------------------
 *                    Utility / Helper Functions
 *------------------------------------------------------------*/
static void log_ts(const char *level, const char *fmt, ...)
{
    time_t     now = time(NULL);
    struct tm  tm_now;
    localtime_r(&now, &tm_now);

    char ts[32];
    strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", &tm_now);

    fprintf(stdout, "[%s] %s: ", ts, level);

    va_list ap;
    va_start(ap, fmt);
    vfprintf(stdout, fmt, ap);
    va_end(ap);
    fprintf(stdout, "\n");
    fflush(stdout);
}

#define LOG_INFO(...)   log_ts("INFO",  __VA_ARGS__)
#define LOG_WARN(...)   log_ts("WARN",  __VA_ARGS__)
#define LOG_ERR(...)    log_ts("ERROR", __VA_ARGS__)

/*-------------------------------------------------------------
 *                  Pipeline Stage Implementations
 *------------------------------------------------------------*/
/* NOTE: Real image handling code removed for brevity. */
static bool ingest_image(const char *path, image_t *out)
{
    if (!path || !out) return false;
    struct stat st;
    if (stat(path, &st) != 0)
    {
        LOG_WARN("Unable to stat image %s (%s)", path, strerror(errno));
        return false;
    }

    /* Fake width/height; real implementation would decode image dimensions */
    strncpy(out->path, path, sizeof(out->path)-1);
    out->width      = 2048;
    out->height     = 1536;
    out->quality_ok = true;                      /* Placeholder QC result */
    return true;
}

static bool preprocess_image(image_t *img)
{
    if (!img) return false;

    /* Simple QC placeholder — simulate random fail */
    if (rand() % 10 == 0)
    {
        img->quality_ok = false;
        LOG_WARN("Image %s failed quality control", img->path);
        return false;
    }
    /* Real code: exposure correction, optic-disc cropping, etc. */
    return true;
}

static bool feature_extract(const image_t *img)
{
    (void)img;
    /* Real code: detect micro-aneurysms, haemorrhages, exudates */
    return true;
}

static bool model_inference(const image_t *img, inference_result_t *out)
{
    if (!img || !out) return false;

    snprintf(out->id, sizeof(out->id), "%lx", (unsigned long)time(NULL));
    out->risk_score = (float)rand() / (float)RAND_MAX;

    /* Simple risk-to-grade mapping */
    if (out->risk_score < 0.2f)
        strncpy(out->grade, "No DR", sizeof(out->grade));
    else if (out->risk_score < 0.4f)
        strncpy(out->grade, "Mild NPDR", sizeof(out->grade));
    else if (out->risk_score < 0.7f)
        strncpy(out->grade, "Moderate NPDR", sizeof(out->grade));
    else
        strncpy(out->grade, "Severe NPDR/PDR", sizeof(out->grade));

    return true;
}

static bool visualize_result(const inference_result_t *res)
{
    if (!res) return false;
    snprintf((char *)res->visualization_path, sizeof(res->visualization_path),
             "./visualizations/%s_overlay.png", res->id);
    /* Real code: heat-map generation */
    return true;
}

static bool emr_feedback(const inference_result_t *res)
{
    if (!res) return false;
    /* Real code: HL7/FHIR push */
    LOG_INFO("EMR updated for image %s with grade %s (%.2f)",
             res->id, res->grade, res->risk_score);
    return true;
}

/*-------------------------------------------------------------
 *                 Observer Implementations
 *------------------------------------------------------------*/
static void model_registry_listener(const event_t *evt, void *ctx)
{
    (void)ctx;
    if (evt->type == EVENT_MODEL_RETRAIN_COMPLETE)
    {
        const char *new_version = evt->payload;
        LOG_INFO("Model Registry updated to version %s", new_version);
    }
}

static void monitoring_dashboard_listener(const event_t *evt, void *ctx)
{
    (void)ctx;
    if (evt->type == EVENT_MODEL_INFERENCE_COMPLETE)
    {
        const inference_result_t *res = evt->payload;
        LOG_INFO("[Dashboard] Image %s graded %s (risk %.2f)",
                 res->id, res->grade, res->risk_score);
    }
}

/*-------------------------------------------------------------
 *                    Model Retraining Thread
 *------------------------------------------------------------*/
typedef struct
{
    pthread_t thread;
    bool      stop_requested;
} retrain_worker_t;

static void *retrain_worker_main(void *arg)
{
    retrain_worker_t *worker = (retrain_worker_t *)arg;
    unsigned int seed = (unsigned int)time(NULL) ^ (unsigned int)pthread_self();
    while (!worker->stop_requested)
    {
        /* Sleep until next retrain window or stop requested */
        for (int i = 0; i < RETRAIN_INTERVAL_SEC; ++i)
        {
            if (worker->stop_requested) pthread_exit(NULL);
            sleep(1);
        }

        /* Fake retraining */
        LOG_INFO("Starting on-device model retraining…");
        sleep(5 + rand_r(&seed)%5);  /* Simulate processing time */

        /* Update model file timestamp to mark retraining */
        FILE *f = fopen(RG_MODEL_PATH, "ab");
        if (f)
        {
            fputc('\n', f);  /* Append newline as dummy change */
            fclose(f);
        }

        /* Broadcast new model version */
        char *new_version = strdup("v" RG_VERSION "-retrained");
        event_t evt = { .type = EVENT_MODEL_RETRAIN_COMPLETE, .payload = new_version };
        event_broadcast(&evt);
        free(new_version);

        LOG_INFO("Model retraining completed");
    }
    pthread_exit(NULL);
    return NULL;
}

static bool retrain_worker_start(retrain_worker_t *worker)
{
    if (!worker) return false;
    worker->stop_requested = false;
    if (pthread_create(&worker->thread, NULL, retrain_worker_main, worker) != 0)
        return false;
    return true;
}

static void retrain_worker_stop(retrain_worker_t *worker)
{
    if (!worker) return;
    worker->stop_requested = true;
    pthread_join(worker->thread, NULL);
}

/*-------------------------------------------------------------
 *                     Graceful Shutdown
 *------------------------------------------------------------*/
static volatile sig_atomic_t g_shutdown_requested = 0;

static void sigint_handler(int sig)
{
    (void)sig;
    g_shutdown_requested = 1;
}

/*-------------------------------------------------------------
 *                     Directory Traversal
 *------------------------------------------------------------*/
static bool is_image_file(const struct dirent *ent)
{
    if (!ent) return false;
    const char *ext = strrchr(ent->d_name, '.');
    if (!ext) return false;
    return (strcasecmp(ext, ".jpg") == 0) ||
           (strcasecmp(ext, ".jpeg") == 0)||
           (strcasecmp(ext, ".png") == 0);
}

static size_t collect_images(const char *dir_path, char list[][RG_MAX_PATH], size_t max)
{
    DIR *dir = opendir(dir_path);
    if (!dir)
    {
        LOG_ERR("Failed to open directory %s: %s", dir_path, strerror(errno));
        return 0;
    }
    struct dirent *ent;
    size_t count = 0;
    while ((ent = readdir(dir)) && count < max)
    {
        if (ent->d_type == DT_REG && is_image_file(ent))
        {
            snprintf(list[count], RG_MAX_PATH, "%s/%s", dir_path, ent->d_name);
            ++count;
        }
    }
    closedir(dir);
    return count;
}

/*-------------------------------------------------------------
 *                       Main Processing Loop
 *------------------------------------------------------------*/
#define MAX_IMAGE_BATCH 1024

static void process_images(const char *dir_path)
{
    char images[MAX_IMAGE_BATCH][RG_MAX_PATH];
    size_t num = collect_images(dir_path, images, MAX_IMAGE_BATCH);
    LOG_INFO("Found %zu images to process in %s", num, dir_path);

    for (size_t i = 0; i < num && !g_shutdown_requested; ++i)
    {
        image_t img;
        if (!ingest_image(images[i], &img)) continue;
        if (!preprocess_image(&img))        continue;
        if (!feature_extract(&img))         continue;

        inference_result_t result;
        if (!model_inference(&img, &result)) continue;
        visualize_result(&result);
        emr_feedback(&result);

        /* Notify observers */
        event_t evt = { .type = EVENT_MODEL_INFERENCE_COMPLETE, .payload = &result };
        event_broadcast(&evt);

        /* Throttle to allow dashboard to update smoothly */
        usleep(100 * 1000);
    }
}

/*-------------------------------------------------------------
 *                              main
 *------------------------------------------------------------*/
int main(int argc, char *argv[])
{
    if (argc < 2)
    {
        fprintf(stderr, "Usage: %s <image-directory>\n", argv[0]);
        return EXIT_FAILURE;
    }

    srand((unsigned int)time(NULL));

    LOG_INFO("RetinaGuard Vision Suite %s starting…", RG_VERSION);

    /* Register SIGINT for graceful termination */
    struct sigaction sa = { .sa_handler = sigint_handler };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    /* Initialize Observer listeners */
    event_register(model_registry_listener,       NULL);
    event_register(monitoring_dashboard_listener, NULL);

    /* Start background retraining thread */
    retrain_worker_t retrain_worker;
    if (!retrain_worker_start(&retrain_worker))
    {
        LOG_ERR("Failed to start retrain worker thread");
        return EXIT_FAILURE;
    }

    /* Main work loop */
    while (!g_shutdown_requested)
    {
        process_images(argv[1]);

        /* Sleep until new images are available or shutdown */
        for (int i = 0; i < 10 && !g_shutdown_requested; ++i)
            sleep(1);
    }

    /* Clean-up */
    LOG_INFO("Shutdown requested — cleaning up…");
    event_t shut_evt = { .type = EVENT_SHUTDOWN, .payload = NULL };
    event_broadcast(&shut_evt);

    retrain_worker_stop(&retrain_worker);

    LOG_INFO("RetinaGuard terminated gracefully");
    return EXIT_SUCCESS;
}