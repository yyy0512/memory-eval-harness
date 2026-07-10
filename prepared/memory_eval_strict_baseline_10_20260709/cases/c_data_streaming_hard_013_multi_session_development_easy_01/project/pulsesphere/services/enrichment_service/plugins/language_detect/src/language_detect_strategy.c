```c
/**
 * PulseSphere – Language Detection Strategy Plug-in
 *
 * File:  pulsesphere/services/enrichment_service/plugins/language_detect/src/language_detect_strategy.c
 *
 * Description:
 *   Strategy-Pattern plug-in that enriches an incoming PulseSphere
 *   `pulse_event_t` with a detected language code (ISO-639-1).  The algorithm
 *   is a lightweight, in-memory trigram matcher that is fast enough for
 *   real-time enrichment while retaining reasonable accuracy for the most
 *   common Western European languages encountered on social platforms.
 *
 *   The plug-in conforms to the PulseSphere run-time plug-in API:
 *
 *       – init()       : one-time initialization hook
 *       – process()    : per-event enrichment
 *       – destroy()    : cleanup hook
 *
 * Author: PulseSphere Core Team
 * ---------------------------------------------------------------------------
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>

#include "plugin_api.h"          /* PulseSphere plug-in interface            */
#include "pulse_event.h"         /* Immutable social pulse event             */
#include "logger.h"              /* Central asynchronous logger              */

#define LANGUAGE_DETECT_PLUGIN_NAME        "language_detect_strategy"
#define LANGUAGE_DETECT_PLUGIN_VERSION     "1.0.0"
#define MIN_INPUT_FOR_DETECTION            24         /* bytes */
#define MAX_TRIGRAMS_PER_TEXT              2048       /* guard against abuse */

/* ---------------------------------------------------------------------------
 *  Trigram Language Model
 *
 *  For production workloads we would load a high-fidelity language profile
 *  from disk or an embedded resource.  For brevity we embed a minimal set
 *  of high-information trigrams discovered empirically for each language.
 * ---------------------------------------------------------------------------
 */
typedef struct {
    const char *code;        /* ISO-639-1 language code */
    const char *trigrams[64];
    size_t      trigram_count;
} lang_profile_t;

/* English (en) – Top discriminative trigrams */
static const char *EN_TRIGRAMS[] = {
    "the", "and", "ing", "her", "hat", "his", "tha", "ere", "for", "ent",
    "ion", "ter", "was", "you", "ith", "ver", "all", "wit", "thi", "men",
    "res", "one", "our", "eve", "not", "but", "that", "have", "with", "are",
    "this", "from", "they", "will", "which", "would", "more", "say", "who",
    "make", "can", "about", "time", "out", "other", "just", "get", "like",
    "when", "than", "then", "now", "into", "could", "them", "only", "some",
    "see", "him", "your", "its", "did", "been"
};

/* Spanish (es) */
static const char *ES_TRIGRAMS[] = {
    "que", "ent", "los", "del", "con", "las", "para", "est", "una", "era",
    "por", "los", "tra", "res", "ció", "ado", "ado", "era", "est", "com",
    "per", "men", "mos", "aci", "ada", "uci", "ten", "ión", "ant", "nes",
    "sus", "pon", "una", "sta", "ció", "pro", "par", "est", "onc", "que",
    "ndo", "dos", "cio", "una", "que", "era", "ser", "est", "los", "ado",
    "una", "ido", "dad", "era", "nte", "sta", "lue", "der", "ará", "ndo",
    "est", "ndo", "eno", "tas"
};

/* French (fr) */
static const char *FR_TRIGRAMS[] = {
    "ent", "ion", "que", "les", "des", "une", "dan", "qui", "par", "re ",
    "est", "ant", "men", "ion", "lle", "ati", "res", "ess", "ite", "ati",
    "que", "ous", "com", "eur", "our", "ell", "tio", "ill", "ons", "lai",
    "eri", "tes", "que", "nte", "sta", "eme", "ite", "imi", "cha", "les",
    "por", "sur", "pas", "ale", "and", "sea", "que", "une", "ses", "ati",
    "dep", "pro", "min", "que", "apr", "ist", "nou", "tre", "est", "ant",
    "aux", "son", "ait", "ter"
};

/* German (de) */
static const char *DE_TRIGRAMS[] = {
    "der", "die", "und", "ein", "sch", "den", "ich", "nde", "die", "che",
    "eit", "ung", "ter", "dem", "die", "gen", "ent", "ver", "cht", "die",
    "ein", "ine", "ich", "nde", "die", "ach", "ten", "der", "den", "nis",
    "aus", "auf", "sie", "men", "nis", "ber", "cht", "ion", "sch", "her",
    "ung", "hen", "das", "der", "die", "die", "sen", "nde", "uch", "hen",
    "sich", "gla", "lich", "den", "res", "bei", "mit", "gen", "ver", "ter",
    "echt", "nen", "die", "erk"
};

/* Profile registry */
static const lang_profile_t LANGUAGE_PROFILES[] = {
    { "en", EN_TRIGRAMS, sizeof(EN_TRIGRAMS)/sizeof(EN_TRIGRAMS[0]) },
    { "es", ES_TRIGRAMS, sizeof(ES_TRIGRAMS)/sizeof(ES_TRIGRAMS[0]) },
    { "fr", FR_TRIGRAMS, sizeof(FR_TRIGRAMS)/sizeof(FR_TRIGRAMS[0]) },
    { "de", DE_TRIGRAMS, sizeof(DE_TRIGRAMS)/sizeof(DE_TRIGRAMS[0]) }
};
static const size_t NUM_PROFILES = sizeof(LANGUAGE_PROFILES) /
                                   sizeof(LANGUAGE_PROFILES[0]);

/* ---------------------------------------------------------------------------
 *  Helper – Lowercase ASCII string in-place (UTF-8 safe for ASCII subset)
 * ---------------------------------------------------------------------------
 */
static inline void to_lower_ascii(char *buf)
{
    for ( ; *buf; ++buf) {
        *buf = (char)tolower((unsigned char)*buf);
    }
}

/* ---------------------------------------------------------------------------
 *  Helper – Extract trigrams from text into a dynamic array
 *           Resulting array and each trigram string are allocated from
 *           the provided memory arena.  Caller is responsible for free().
 * ---------------------------------------------------------------------------
 */
static size_t
extract_trigrams(const char *text,
                 char      **out_trigrams,
                 size_t      max_trigrams)
{
    size_t len = strlen(text);
    if (len < 3) return 0;

    size_t count = 0;
    for (size_t i = 0; i + 2 < len && count < max_trigrams; ++i) {
        /* Copy 3 consecutive chars */
        char *tri = out_trigrams[count];
        tri[0] = (char)tolower((unsigned char)text[i]);
        tri[1] = (char)tolower((unsigned char)text[i + 1]);
        tri[2] = (char)tolower((unsigned char)text[i + 2]);
        tri[3] = '\0';
        ++count;
    }
    return count;
}

/* ---------------------------------------------------------------------------
 *  Language Detection – Simple trigram voting mechanism
 * ---------------------------------------------------------------------------
 */
static const char *
detect_language(const char *text)
{
    if (text == NULL || *text == '\0') {
        return "und"; /* undefined */
    }

    size_t text_len = strlen(text);
    if (text_len < MIN_INPUT_FOR_DETECTION) {
        return "und";
    }

    /* Pre-allocate buffer for trigram extraction */
    size_t trigram_cap = text_len > 3 ? text_len - 2 : 0;
    if (trigram_cap > MAX_TRIGRAMS_PER_TEXT)
        trigram_cap = MAX_TRIGRAMS_PER_TEXT;

    char (*trigrams)[4] = calloc(trigram_cap, sizeof(*trigrams));
    if (!trigrams) {
        LOG_ERROR("[lang_detect] Out of memory during trigram extraction");
        return "und";
    }

    /* Temporary pointer array required by extract_trigrams() */
    char **ptrs = malloc(trigram_cap * sizeof(char *));
    if (!ptrs) {
        free(trigrams);
        LOG_ERROR("[lang_detect] Out of memory during trigram extraction (ptrs)");
        return "und";
    }
    for (size_t i = 0; i < trigram_cap; ++i) {
        ptrs[i] = trigrams[i];
    }

    size_t num_trigrams = extract_trigrams(text, ptrs, trigram_cap);
    free(ptrs);  /* no longer needed */

    /* Score against every language profile */
    size_t best_score = 0;
    const char *best_lang = "und";

    for (size_t p = 0; p < NUM_PROFILES; ++p) {
        const lang_profile_t *profile = &LANGUAGE_PROFILES[p];
        size_t score = 0;

        for (size_t t = 0; t < num_trigrams; ++t) {
            for (size_t l = 0; l < profile->trigram_count; ++l) {
                if (memcmp(trigrams[t], profile->trigrams[l], 3) == 0) {
                    ++score;
                    break;
                }
            }
        }

        if (score > best_score) {
            best_score = score;
            best_lang  = profile->code;
        }
    }

    free(trigrams);
    return best_lang;
}

/* ===========================================================================
 *  Plug-in Object
 * ===========================================================================
 */
typedef struct {
    plugin_t  base;           /* must be first – plugin API "inheritance" */
    uint64_t  events_processed;
} language_detect_strategy_t;

/* ---------------------------------------------------------------------------
 *  Forward declarations
 * ---------------------------------------------------------------------------
 */
static int  ld_init(plugin_t *self, const plugin_config_t *config);
static int  ld_process(plugin_t *self, pulse_event_t *event);
static void ld_destroy(plugin_t *self);

/* ---------------------------------------------------------------------------
 *  Plug-in factory – Called by PulseSphere plug-in manager
 * ---------------------------------------------------------------------------
 */
PLUGIN_EXPORT
plugin_t *
plugin_create(void)
{
    language_detect_strategy_t *strategy =
        calloc(1, sizeof(language_detect_strategy_t));
    if (!strategy) {
        LOG_ERROR("[lang_detect] plugin_create: %s", strerror(errno));
        return NULL;
    }

    strategy->base.name        = LANGUAGE_DETECT_PLUGIN_NAME;
    strategy->base.version     = LANGUAGE_DETECT_PLUGIN_VERSION;
    strategy->base.type        = PLUGIN_TYPE_ENRICHMENT;
    strategy->base.init        = ld_init;
    strategy->base.process     = ld_process;
    strategy->base.destroy     = ld_destroy;
    strategy->events_processed = 0;

    return (plugin_t *)strategy;
}

/* ---------------------------------------------------------------------------
 *  Plug-in init() – one-time initialization
 * ---------------------------------------------------------------------------
 */
static int
ld_init(plugin_t *self, const plugin_config_t *config)
{
    (void)config; /* This plug-in has no runtime config for now */

    if (!self) return -1;
    LOG_INFO("[lang_detect] Initializing language detection strategy v%s",
             LANGUAGE_DETECT_PLUGIN_VERSION);
    return 0;
}

/* ---------------------------------------------------------------------------
 *  Plug-in process() – called per incoming event
 * ---------------------------------------------------------------------------
 */
static int
ld_process(plugin_t *self, pulse_event_t *event)
{
    if (!self || !event) return -1;

    language_detect_strategy_t *ld = (language_detect_strategy_t *)self;

    const char *text = pulse_event_get_text(event);
    const char *lang_code = detect_language(text);

    if (strcmp(lang_code, "und") != 0) {
        if (pulse_event_set_attribute(event, "lang", lang_code) != 0) {
            LOG_WARN("[lang_detect] Unable to set 'lang' attribute on event "
                     "ID %s", pulse_event_get_id(event));
        }
    }

    ++ld->events_processed;
    return 0;
}

/* ---------------------------------------------------------------------------
 *  Plug-in destroy() – cleanup
 * ---------------------------------------------------------------------------
 */
static void
ld_destroy(plugin_t *self)
{
    if (!self) return;
    language_detect_strategy_t *ld = (language_detect_strategy_t *)self;
    LOG_INFO("[lang_detect] Destroying strategy; processed %" PRIu64 " events",
             ld->events_processed);
    free(ld);
}
```