```c
/*********************************************************************************
 * File: slack_observer.c
 * Project: LambdaUtility Orchestrator (system_automation)
 * Description:
 *   Concrete Observer implementation that posts event notifications to a Slack
 *   channel using an Incoming Web-Hook URL.  The component participates in the
 *   Observer pipeline that the dispatcher fans out to.  It relies on libcurl
 *   for HTTPS POST requests and can be configured either programmatically or
 *   via environment variables.
 *
 *   Environment variables:
 *     LUO_SLACK_WEBHOOK_URL   – mandatory if not supplied via constructor
 *     LUO_SLACK_CHANNEL       – optional  (e.g. "#ops-alerts")
 *     LUO_SLACK_USERNAME      – optional  (e.g. "LambdaUtility-Bot")
 *     LUO_SLACK_ICON_EMOJI    – optional  (e.g. ":robot_face:")
 *
 * Copyright:
 *   © 2024 LambdaUtility.  All rights reserved.
 *********************************************************************************/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <curl/curl.h>

#include "observer.h"       /* Base Observer interface (not implemented here) */
#include "event.h"          /* Domain-specific event object                  */
#include "logger.h"         /* Project-wide logging abstraction             */
#include "slack_observer.h" /* Public header for this module                */

/*----------------------------------------------------------------------------
 * Internal data structure
 *---------------------------------------------------------------------------*/
typedef struct
{
    Observer base;       /* Base “class” – must be first for ‘inheritance’   */
    char *webhook_url;   /* Slack Incoming Web-Hook URL                     */
    char *channel;       /* Optional channel override                       */
    char *username;      /* Optional bot username                           */
    char *icon_emoji;    /* Optional bot emoji                              */
} SlackObserver;

/*----------------------------------------------------------------------------
 * Forward declarations
 *---------------------------------------------------------------------------*/
static void  slack_update(Observer *self, const Event *event);
static void  slack_destroy(Observer *self);
static int   slack_send_payload(const SlackObserver *s, const char *json_body);
static char *slack_format_json(const SlackObserver *s, const Event *event);
static char *slack_string_dup(const char *src);

/*----------------------------------------------------------------------------
 * Utility: safe string duplication (NULL-aware)
 *---------------------------------------------------------------------------*/
static char *slack_string_dup(const char *src)
{
    if (!src)
        return NULL;

    size_t len = strlen(src) + 1;
    char *dst  = malloc(len);
    if (!dst)
    {
        LOG_ERROR("SlackObserver: Out of memory duplicating string");
        return NULL;
    }

    memcpy(dst, src, len);
    return dst;
}

/*----------------------------------------------------------------------------
 * Factory method
 *---------------------------------------------------------------------------*/
Observer *slack_observer_create(const char *webhook_url,
                                const char *channel,
                                const char *username,
                                const char *icon_emoji)
{
    const char *env_webhook = getenv("LUO_SLACK_WEBHOOK_URL");
    if (!webhook_url || webhook_url[0] == '\0')
        webhook_url = env_webhook; /* Prefer parameter over environment */

    if (!webhook_url || webhook_url[0] == '\0')
    {
        LOG_ERROR("SlackObserver: Missing Slack web-hook URL; "
                  "set LUO_SLACK_WEBHOOK_URL or pass via constructor");
        return NULL;
    }

    SlackObserver *s = calloc(1, sizeof(*s));
    if (!s)
    {
        LOG_ERROR("SlackObserver: Allocation failure");
        return NULL;
    }

    s->webhook_url = slack_string_dup(webhook_url);
    s->channel     = slack_string_dup(channel     ? channel     : getenv("LUO_SLACK_CHANNEL"));
    s->username    = slack_string_dup(username    ? username    : getenv("LUO_SLACK_USERNAME"));
    s->icon_emoji  = slack_string_dup(icon_emoji  ? icon_emoji  : getenv("LUO_SLACK_ICON_EMOJI"));

    /* Initialize base v-table */
    s->base.update  = slack_update;
    s->base.destroy = slack_destroy;

    LOG_INFO("SlackObserver: Initialized (channel=%s, username=%s)",
             s->channel ? s->channel : "default",
             s->username ? s->username : "default");

    return (Observer *)s;
}

/*----------------------------------------------------------------------------
 * Destructor
 *---------------------------------------------------------------------------*/
static void slack_destroy(Observer *observer)
{
    if (!observer)
        return;

    SlackObserver *s = (SlackObserver *)observer;

    free(s->webhook_url);
    free(s->channel);
    free(s->username);
    free(s->icon_emoji);
    free(s);

    LOG_DEBUG("SlackObserver: Destroyed");
}

/*----------------------------------------------------------------------------
 * Observer.update() – main entry point from dispatcher
 *---------------------------------------------------------------------------*/
static void slack_update(Observer *observer, const Event *event)
{
    if (!observer || !event)
        return;

    SlackObserver *s = (SlackObserver *)observer;

    char *json_body = slack_format_json(s, event);
    if (!json_body)
    {
        LOG_ERROR("SlackObserver: Failed to format JSON payload");
        return;
    }

    if (slack_send_payload(s, json_body) != 0)
    {
        LOG_ERROR("SlackObserver: Failed to send Slack notification");
    }

    free(json_body);
}

/*----------------------------------------------------------------------------
 * Build JSON payload expected by Slack Web-Hook API.
 * We construct manually instead of pulling a full JSON library to keep the
 * Lambda cold-start footprint tiny.
 *---------------------------------------------------------------------------*/
static char *slack_format_json(const SlackObserver *s, const Event *event)
{
    /* Slack message text: "[SEVERITY] <event_type> – <message>" */
    char text[1024];
    snprintf(text, sizeof(text),
             "[%s] %s – %s",
             event_severity_to_string(event->severity),
             event->type,
             event->message);

    /* Pre-compute JSON size (escape minimal characters) */
    const char *template_base =
        "{"
          "\"text\":\"%s\"%s%s%s%s%s%s"
        "}";

    /* Additional optional fields */
    const char *channel_entry  = s->channel  ? ",\"channel\":\"%s\""  : "";
    const char *username_entry = s->username ? ",\"username\":\"%s\"" : "";
    const char *icon_entry     = s->icon_emoji ? ",\"icon_emoji\":\"%s\"" : "";

    /* Estimate length */
    size_t len = strlen(template_base) +
                 strlen(text) +
                 (s->channel     ? strlen(s->channel)     : 0) +
                 (s->username    ? strlen(s->username)    : 0) +
                 (s->icon_emoji  ? strlen(s->icon_emoji)  : 0) + 32;

    char *json = malloc(len);
    if (!json)
    {
        LOG_ERROR("SlackObserver: Out of memory building JSON body");
        return NULL;
    }

    /* Build payload */
    snprintf(json,
             len,
             "{"
               "\"text\":\"%s\""
               "%s%s"
               "%s%s"
               "%s%s"
             "}",
             text,
             s->channel     ? ",\"channel\":\""  : "", s->channel     ? s->channel     : "",
             s->username    ? ",\"username\":\"" : "", s->username    ? s->username    : "",
             s->icon_emoji  ? ",\"icon_emoji\":\"" : "", s->icon_emoji  ? s->icon_emoji  : "");

    return json;
}

/*----------------------------------------------------------------------------
 * Send HTTP POST to Slack via libcurl
 *---------------------------------------------------------------------------*/
static int slack_send_payload(const SlackObserver *s, const char *json_body)
{
    CURLcode        res;
    CURL           *curl   = NULL;
    struct curl_slist *hdr = NULL;
    int             rc     = -1;

    curl = curl_easy_init();
    if (!curl)
    {
        LOG_ERROR("SlackObserver: curl_easy_init() failed");
        return -1;
    }

    hdr = curl_slist_append(hdr, "Content-Type: application/json");

    curl_easy_setopt(curl, CURLOPT_URL, s->webhook_url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdr);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, json_body);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(json_body));
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "LambdaUtility-Orchestrator/1.0");

#ifdef DEBUG
    curl_easy_setopt(curl, CURLOPT_VERBOSE, 1L);
#endif

    res = curl_easy_perform(curl);
    if (res != CURLE_OK)
    {
        LOG_ERROR("SlackObserver: curl_easy_perform() failed: %s",
                  curl_easy_strerror(res));
        goto cleanup;
    }

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    if (http_code != 200)
    {
        LOG_ERROR("SlackObserver: Non-200 response from Slack (%ld)", http_code);
        goto cleanup;
    }

    rc = 0; /* success */

cleanup:
    if (hdr)
        curl_slist_free_all(hdr);
    if (curl)
        curl_easy_cleanup(curl);

    return rc;
}
```