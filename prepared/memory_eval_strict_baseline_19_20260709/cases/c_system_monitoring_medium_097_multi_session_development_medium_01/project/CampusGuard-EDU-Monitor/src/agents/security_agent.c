```c
/**
 * CampusGuard-EDU-Monitor
 * File: src/agents/security_agent.c
 *
 * The Security Agent is a micro-service responsible for receiving
 * security-scan requests from the internal event bus, executing the scan
 * (simulated for the purpose of the educational sandbox) and publishing
 * results / alerts back on the bus.  It demonstrates:
 *
 *   • Observer pattern      –  Subscribes to the message-bus topic
 *   • Event-Driven design   –  Non-blocking queue + worker thread
 *   • Chain of Responsibility–  Delegates alert routing to dispatcher
 *
 * Production-grade considerations:
 *   • Thread safety (pthread mutex / condvar)
 *   • Graceful shutdown via cancel-token
 *   • Defensive error checking and syslog logging
 *   • Configurable parameters via agent.conf (INI)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include <pthread.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <syslog.h>
#include <errno.h>

#include "security_agent.h"      /* Agent public API                      */
#include "message_bus.h"         /* CampusGuard internal event-bus        */
#include "scan_engine.h"         /* Simulated vulnerability scan engine   */
#include "alert_dispatcher.h"    /* Centralized alert router              */
#include "ini_config.h"          /* Tiny wrapper around libinih           */

/*--------------------------------------------------------------------*/
/*                Compile-time configuration defaults                 */
/*--------------------------------------------------------------------*/

#ifndef SECURITY_AGENT_MAX_QUEUE
#define SECURITY_AGENT_MAX_QUEUE        64          /* Pending scans   */
#endif

#ifndef SECURITY_AGENT_HEARTBEAT_SEC
#define SECURITY_AGENT_HEARTBEAT_SEC     30         /* Metrics cadence */
#endif

/*--------------------------------------------------------------------*/
/*                           Data Types                               */
/*--------------------------------------------------------------------*/

/* Internal queue element – security scan request received from bus.  */
typedef struct
{
    char  target_host[256];
    int   depth;
    char  requester[64];
    uuid_t correlation_id;                /* Traceability */
} scan_request_t;

/**
 * Agent instance – encapsulates all mutable state so that multiple
 * agents could theoretically coexist (namespace / container boundary).
 */
typedef struct
{
    pthread_t       worker_th;
    pthread_mutex_t mtx;
    pthread_cond_t  cv;
    scan_request_t  queue[SECURITY_AGENT_MAX_QUEUE];
    size_t          q_front;
    size_t          q_back;
    size_t          q_len;

    atomic_bool     stop_flag;

    bus_subscription_t *sub;      /* Handle to event-bus subscription    */
    agent_cfg_t      cfg;         /* Runtime configuration parameters    */
} security_agent_t;

/*--------------------------------------------------------------------*/
/*              Local function prototypes (static)                    */
/*--------------------------------------------------------------------*/
static void         *worker_main  (void *arg);
static void          enqueue_req  (security_agent_t *sa,
                                   const scan_request_t *req);
static bool          dequeue_req  (security_agent_t *sa,
                                   scan_request_t *out);
static void          on_bus_event (const bus_event_t *ev, void *udata);
static void          publish_heartbeat(security_agent_t *sa);
static int           load_config  (const char *path, agent_cfg_t *out);

/*--------------------------------------------------------------------*/
/*                    Singleton agent handle                          */
/*--------------------------------------------------------------------*/
static security_agent_t g_agent;

/*--------------------------------------------------------------------*/
/*                 Public API implementation                          */
/*--------------------------------------------------------------------*/

int security_agent_init(const char *config_path)
{
    memset(&g_agent, 0, sizeof(g_agent));
    pthread_mutex_init(&g_agent.mtx, NULL);
    pthread_cond_init(&g_agent.cv, NULL);
    atomic_init(&g_agent.stop_flag, false);

    if (load_config(config_path, &g_agent.cfg) != 0)
        return -1;

    openlog("security_agent", LOG_PID | LOG_CONS, LOG_DAEMON);

    /* Subscribe to BUS_TOPIC_SECURITY_SCAN requests                       */
    g_agent.sub = bus_subscribe(BUS_TOPIC_SECURITY_SCAN, on_bus_event,
                                &g_agent);
    if (!g_agent.sub) {
        syslog(LOG_ERR, "Failed to subscribe to event bus: %s",
               bus_last_error());
        return -1;
    }

    /* Start worker thread                                                 */
    if (pthread_create(&g_agent.worker_th, NULL, worker_main, &g_agent) != 0) {
        syslog(LOG_ERR, "Unable to spawn worker thread: %s", strerror(errno));
        bus_unsubscribe(g_agent.sub);
        return -1;
    }

    syslog(LOG_INFO, "Security Agent initialised (queue=%d, heartbeat=%ds)",
           SECURITY_AGENT_MAX_QUEUE, SECURITY_AGENT_HEARTBEAT_SEC);
    return 0;
}

void security_agent_shutdown(void)
{
    atomic_store(&g_agent.stop_flag, true);

    /* Wake worker if blocking                                              */
    pthread_mutex_lock(&g_agent.mtx);
    pthread_cond_broadcast(&g_agent.cv);
    pthread_mutex_unlock(&g_agent.mtx);

    pthread_join(g_agent.worker_th, NULL);

    if (g_agent.sub)
        bus_unsubscribe(g_agent.sub);

    pthread_mutex_destroy(&g_agent.mtx);
    pthread_cond_destroy(&g_agent.cv);
    closelog();

    memset(&g_agent, 0, sizeof(g_agent));
}

/*--------------------------------------------------------------------*/
/*                         Worker Thread                              */
/*--------------------------------------------------------------------*/

static void *worker_main(void *arg)
{
    security_agent_t *sa = arg;
    time_t last_hb = 0;

    while (!atomic_load(&sa->stop_flag)) {
        scan_request_t req;

        /* Dequeue or wait                                                  */
        pthread_mutex_lock(&sa->mtx);
        while (sa->q_len == 0 && !atomic_load(&sa->stop_flag)) {
            pthread_cond_wait(&sa->cv, &sa->mtx);
        }
        bool has_job = dequeue_req(sa, &req);
        pthread_mutex_unlock(&sa->mtx);

        if (atomic_load(&sa->stop_flag))
            break;

        if (has_job) {
            /*----------------------------------------------------------*/
            /* 1. Perform simulated vulnerability scan                  */
            /*----------------------------------------------------------*/
            syslog(LOG_INFO, "Starting scan (target=%s depth=%d req=%s)",
                   req.target_host, req.depth, req.requester);

            scan_result_t result;
            if (scan_engine_run(req.target_host, req.depth, &result) != 0) {
                syslog(LOG_ERR, "Scan engine failed on host %s", req.target_host);
            } else {
                /* 2. Persist result (omitted – storage layer)          */

                /* 3. Publish alert if critical issues found            */
                if (result.critical_count > 0) {
                    alert_t alert = {
                        .sev    = ALERT_SEV_CRITICAL,
                        .source = "SecurityAgent",
                        .title  = "Critical Vulnerabilities Detected",
                        .body   = result.summary,
                    };
                    uuid_copy(alert.correlation_id, req.correlation_id);

                    alert_dispatch(&alert);
                }
            }
        }

        /*----------------------------------------------------------------*/
        /* Periodic heartbeat metric                                       */
        /*----------------------------------------------------------------*/
        time_t now = time(NULL);
        if (difftime(now, last_hb) >= SECURITY_AGENT_HEARTBEAT_SEC) {
            publish_heartbeat(sa);
            last_hb = now;
        }
    }
    syslog(LOG_INFO, "Worker thread exiting");
    return NULL;
}

/*--------------------------------------------------------------------*/
/*                     Bus Event Callback                             */
/*--------------------------------------------------------------------*/

static void on_bus_event(const bus_event_t *ev, void *udata)
{
    security_agent_t *sa = udata;

    if (ev->type != BUS_EVENT_SECURITY_SCAN)
        return;

    const bus_ev_secscan_t *payload = ev->payload;

    scan_request_t req = { 0 };
    strncpy(req.target_host, payload->host, sizeof(req.target_host) - 1);
    req.depth = payload->depth;
    strncpy(req.requester, ev->origin, sizeof(req.requester) - 1);
    uuid_copy(req.correlation_id, ev->correlation_id);

    enqueue_req(sa, &req);
}

/*--------------------------------------------------------------------*/
/*                          Queue Helpers                             */
/*--------------------------------------------------------------------*/

static void enqueue_req(security_agent_t *sa, const scan_request_t *req)
{
    pthread_mutex_lock(&sa->mtx);
    if (sa->q_len == SECURITY_AGENT_MAX_QUEUE) {
        syslog(LOG_WARNING, "Queue full – dropping scan request for %s",
               req->target_host);
    } else {
        sa->queue[sa->q_back] = *req;
        sa->q_back = (sa->q_back + 1) % SECURITY_AGENT_MAX_QUEUE;
        sa->q_len++;
        pthread_cond_signal(&sa->cv);
    }
    pthread_mutex_unlock(&sa->mtx);
}

static bool dequeue_req(security_agent_t *sa, scan_request_t *out)
{
    if (sa->q_len == 0)
        return false;

    *out = sa->queue[sa->q_front];
    sa->q_front = (sa->q_front + 1) % SECURITY_AGENT_MAX_QUEUE;
    sa->q_len--;
    return true;
}

/*--------------------------------------------------------------------*/
/*                          Heartbeat                                 */
/*--------------------------------------------------------------------*/
static void publish_heartbeat(security_agent_t *sa)
{
    bus_ev_heartbeat_t hb = {
        .service_name  = "SecurityAgent",
        .queue_size    = sa->q_len,
        .timestamp     = time(NULL),
    };
    bus_publish(BUS_TOPIC_AGENT_METRICS, BUS_EVENT_HEARTBEAT, &hb,
                sizeof(hb), NULL);
}

/*--------------------------------------------------------------------*/
/*                     Configuration Loader                           */
/*--------------------------------------------------------------------*/

/* Minimal INI section/field names                                      */
#define SEC_SECTION       "security_agent"
#define KEY_MAX_QUEUE     "max_queue"
#define KEY_HEARTBEAT_SEC "heartbeat_sec"

static int load_config(const char *path, agent_cfg_t *out)
{
    /* Default values first                                                */
    out->max_queue      = SECURITY_AGENT_MAX_QUEUE;
    out->heartbeat_sec  = SECURITY_AGENT_HEARTBEAT_SEC;

    if (!path)                        /* Use defaults if no config        */
        return 0;

    ini_cfg_t cfg;
    if (ini_open(&cfg, path) != 0) {
        syslog(LOG_WARNING, "Cannot open %s – using defaults", path);
        return 0;
    }

    int tmp;
    if (ini_get_int(&cfg, SEC_SECTION, KEY_MAX_QUEUE, &tmp) == 0 &&
        tmp > 0 && tmp <= 1024)
        out->max_queue = tmp;

    if (ini_get_int(&cfg, SEC_SECTION, KEY_HEARTBEAT_SEC, &tmp) == 0 &&
        tmp >= 5 && tmp <= 300)
        out->heartbeat_sec = tmp;

    ini_close(&cfg);
    return 0;
}
```
