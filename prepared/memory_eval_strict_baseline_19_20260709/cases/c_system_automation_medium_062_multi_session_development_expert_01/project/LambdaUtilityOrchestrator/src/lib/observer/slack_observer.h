/*
 *  LambdaUtility Orchestrator
 *  --------------------------
 *  File:   slack_observer.h
 *  Author: LambdaUtility Core Team
 *
 *  Description:
 *      Concrete Observer that publishes event notifications to Slack
 *      via an Incoming-Webhook.  The observer is designed to be used
 *      inside short-lived, serverless Lambda functions; therefore all
 *      operations are synchronous and self-contained, with robust error
 *      handling and no reliance on global state.
 *
 *  Usage:
 *      #include "observer/slack_observer.h"
 *
 *      Observer *obs = slack_observer_new(
 *              "https://hooks.slack.com/services/T000/B000/XXX",
 *              "#ops-alerts",
 *              "LambdaBot",
 *              true,              // emoji
 *              3,                 // retry limit
 *              2000);             // timeout-ms
 *
 *      obs->notify(obs, "{\"event\":\"deploy\",\"status\":\"ok\"}", OBS_SEV_INFO);
 *      obs->destroy(obs);
 *
 *  Dependencies:
 *      - libcurl (link with -lcurl)
 *
 *  License: MIT
 */

#ifndef LUO_SLACK_OBSERVER_H
#define LUO_SLACK_OBSERVER_H

/* ---- System & third-party includes ------------------------------------- */
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <curl/curl.h>

/* ---- Public Enumerations ---------------------------------------------- */
/* Severity levels used throughout LambdaUtility.                         */
typedef enum {
    OBS_SEV_DEBUG   = 0,
    OBS_SEV_INFO    = 1,
    OBS_SEV_WARN    = 2,
    OBS_SEV_ERROR   = 3,
    OBS_SEV_FATAL   = 4
} obs_severity_t;

/* ---- Forward declaration of Observer interface ------------------------ */
typedef struct Observer Observer;

/* Observer interface (Strategy/Polymorphic in plain C).                  */
struct Observer {
    void  (*notify)(Observer *self,
                    const char *event_json,
                    obs_severity_t sev);

    void  (*destroy)(Observer *self);
};

/* ---- SlackObserver concrete implementation --------------------------- */
typedef struct {
    Observer   iface;          /* Must be first for up-casting           */

    char      *webhook_url;    /* Full Slack Incoming-Webhook URL        */
    char      *channel;        /* Target channel or @username            */
    char      *username;       /* Sender name                            */
    bool       use_emoji;      /* Prepend severity emoji                 */

    uint8_t    retry_limit;    /* # of retry attempts on network error   */
    uint16_t   timeout_ms;     /* CURL timeout in milliseconds           */
} SlackObserver;

/* ---- Public API ------------------------------------------------------- */
/**
 * Allocate and initialise a SlackObserver.
 *
 * All string arguments are defensively duplicated; the caller may free
 * the originals immediately after this function returns.
 *
 * @param webhook_url   Full Slack Incoming-Webhook URL (https://hooks.slack.com/…)
 * @param channel       Slack channel (e.g. "#ops") or user ("@alice") — may be NULL
 * @param username      Display name used in Slack (e.g. "LambdaBot")
 * @param use_emoji     Prepend a severity-specific emoji to the message
 * @param retry_limit   Number of retry attempts for transient failures
 * @param timeout_ms    CURL transfer timeout in milliseconds
 *
 * @return Pointer to Observer interface (NULL on allocation failure)
 */
static inline Observer *
slack_observer_new(const char *webhook_url,
                   const char *channel,
                   const char *username,
                   bool        use_emoji,
                   uint8_t     retry_limit,
                   uint16_t    timeout_ms);

/* ---- Internal helpers (not meant for direct use) ---------------------- */
static void  _slack_observer_notify(Observer *self,
                                    const char *event_json,
                                    obs_severity_t sev);

static void  _slack_observer_destroy(Observer *self);

static bool  _slack_http_post(const SlackObserver *so,
                              const char          *payload);

/* ---- Implementation --------------------------------------------------- */
#ifdef SLACK_OBSERVER_IMPLEMENTATION

/* Map severity → emoji string ------------------------------------------ */
static const char *_sev_to_emoji(obs_severity_t s)
{
    switch (s) {
        case OBS_SEV_DEBUG: return ":mag:";
        case OBS_SEV_INFO:  return ":information_source:";
        case OBS_SEV_WARN:  return ":warning:";
        case OBS_SEV_ERROR: return ":x:";
        case OBS_SEV_FATAL: return ":bangbang:";
        default:            return "";
    }
}

/* Map severity → string tag -------------------------------------------- */
static const char *_sev_to_string(obs_severity_t s)
{
    switch (s) {
        case OBS_SEV_DEBUG: return "DEBUG";
        case OBS_SEV_INFO:  return "INFO";
        case OBS_SEV_WARN:  return "WARN";
        case OBS_SEV_ERROR: return "ERROR";
        case OBS_SEV_FATAL: return "FATAL";
        default:            return "UNKNOWN";
    }
}

static Observer *
slack_observer_new(const char *webhook_url,
                   const char *channel,
                   const char *username,
                   bool        use_emoji,
                   uint8_t     retry_limit,
                   uint16_t    timeout_ms)
{
    if (!webhook_url || !*webhook_url) return NULL;

    SlackObserver *so = calloc(1, sizeof(*so));
    if (!so) return NULL;

    /* Duplicate user-supplied strings */
    so->webhook_url = strdup(webhook_url);
    so->channel     = channel   ? strdup(channel)   : NULL;
    so->username    = username  ? strdup(username)  : NULL;

    if (!so->webhook_url || (channel && !so->channel) ||
        (username && !so->username)) {
        _slack_observer_destroy((Observer *)so);
        return NULL;
    }

    so->use_emoji   = use_emoji;
    so->retry_limit = retry_limit;
    so->timeout_ms  = timeout_ms;

    /* Wire up interface */
    so->iface.notify  = _slack_observer_notify;
    so->iface.destroy = _slack_observer_destroy;

    return (Observer *)so;
}

/* ---------------------------------------------------------------------- */
static void
_slack_observer_notify(Observer *self,
                       const char *event_json,
                       obs_severity_t sev)
{
    if (!self || !event_json) return;

    SlackObserver *so = (SlackObserver *)self;

    /* Build Slack message text */
    const char *emoji   = so->use_emoji ? _sev_to_emoji(sev) : "";
    const char *sev_txt = _sev_to_string(sev);

    /* Estimate buffer length and allocate */
    size_t payload_sz = strlen(event_json) +
                        strlen(emoji) +
                        strlen(sev_txt) + 256;

    char *payload = malloc(payload_sz);
    if (!payload) return;

    /* Build JSON payload in Slack expected format                */
    /* Use Incoming Webhook’s simple text interface for portability */
    snprintf(payload, payload_sz,
        "{"
          "\"username\":\"%s\","
          "\"channel\":\"%s\","
          "\"text\":\"%s [%s] %s\""
        "}",
        so->username ? so->username : "LambdaUtility",
        so->channel  ? so->channel  : "",
        emoji,
        sev_txt,
        event_json);

    /* Attempt HTTP POST with exponential backoff */
    for (uint8_t attempt = 0; attempt <= so->retry_limit; ++attempt) {
        if (_slack_http_post(so, payload)) {
            break;              /* Success */
        }
        /* Simple backoff:  250ms → 500ms → 1000ms … */
        uint32_t backoff_ms = 250u << attempt;
        struct timespec ts = {
            .tv_sec  = backoff_ms / 1000u,
            .tv_nsec = (backoff_ms % 1000u) * 1000000u
        };
        nanosleep(&ts, NULL);
    }

    free(payload);
}

/* ---------------------------------------------------------------------- */
static bool
_slack_http_post(const SlackObserver *so,
                 const char          *payload)
{
    bool ok = false;
    CURL *curl = curl_easy_init();
    if (!curl) return false;

    struct curl_slist *hdrs = NULL;
    hdrs = curl_slist_append(hdrs, "Content-Type: application/json");

    curl_easy_setopt(curl, CURLOPT_URL, so->webhook_url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(payload));
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, so->timeout_ms);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);

    CURLcode res = curl_easy_perform(curl);
    if (res == CURLE_OK) {
        long http_code = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
        ok = (http_code >= 200 && http_code < 300);
    }

    curl_slist_free_all(hdrs);
    curl_easy_cleanup(curl);
    return ok;
}

/* ---------------------------------------------------------------------- */
static void
_slack_observer_destroy(Observer *self)
{
    if (!self) return;

    SlackObserver *so = (SlackObserver *)self;

    free(so->webhook_url);
    free(so->channel);
    free(so->username);
    memset(so, 0, sizeof(*so));   /* Defensive */
    free(so);
}
#endif /* SLACK_OBSERVER_IMPLEMENTATION */

#endif /* LUO_SLACK_OBSERVER_H */
