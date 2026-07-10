```c
/**
 * PulseSphere: Real-Time Social Pulse Streaming Platform
 * ------------------------------------------------------
 * Toxicity Score Strategy Plug-In
 *
 * File:    pulsesphere/services/enrichment_service/plugins/toxicity_score/src/toxicity_score_strategy.c
 * Author:  PulseSphere Core Team
 *
 * Description:
 *   Strategy plug-in that enriches incoming social events with a probabilistic
 *   toxicity score.  The algorithm is intentionally lightweight so it can run
 *   in-process for millions of events per second while remaining pluggable.
 *
 *   1.  During initialisation we load a configurable lexicon that maps terms
 *       to toxicity weights.  The file format is CSV:
 *
 *            word,weight
 *            ...
 *
 *   2.  At runtime we tokenise the event’s free-form text (content) and look
 *       up each token in the lexicon.  The accumulated weight is passed
 *       through a logistic activation to obtain a probability in [0,1].
 *
 *   3.  If the score exceeds the configured threshold the event is flagged as
 *       toxic.  Downstream moderation services can take action accordingly.
 *
 *   Thread-safety:
 *       After initialisation the lexicon is read-only, so we use a rw-lock to
 *       protect it.  Write-locks are only acquired during reload operations.
 *
 *   Build:
 *       gcc -Wall -Wextra -pedantic -fPIC -shared \
 *           -I<project-root>/include -o libtoxicity_score_strategy.so \
 *           toxicity_score_strategy.c -pthread -lm
 */

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* uthash is used for the in-memory lexicon --------------------------------------------------- */
#define UTHASH_NONFATAL_OOM 1
#include "uthash.h"

/* ----------------------------------------------------------------------------
 * Interfaces provided by the enrichment service (simplified excerpt)
 * ------------------------------------------------------------------------- */
#include "enrichment_strategy.h" /* strategy interface */
#include "event_model.h"         /* social_event_t / enriched_event_t */
#include "ps_logger.h"           /* project-wide logging facility      */

/* -------------------------------------------------------------------------
 * Internal structures
 * ---------------------------------------------------------------------- */

/* One row in the toxicity lexicon. */
typedef struct toxicity_lexicon_entry_t {
    char  *token;        /* key */
    double weight;       /* toxicity weight */
    UT_hash_handle hh;   /* makes this struct hashable */
} toxicity_lexicon_entry_t;

/* Strategy private data */
typedef struct toxicity_priv_t {
    toxicity_lexicon_entry_t *lexicon; /* hash map of token → weight */
    double                    threshold;
    pthread_rwlock_t          lock;    /* protects lexicon & threshold */
    char                      *config_path;
} toxicity_priv_t;

/* -------------------------------------------------------------------------
 * Forward declarations
 * ---------------------------------------------------------------------- */
static int  toxicity_init(enrichment_strategy_t *self, const char *config_file);
static int  toxicity_process(enrichment_strategy_t        *self,
                             const social_event_t         *event,
                             enriched_event_t             *out);
static void toxicity_destroy(enrichment_strategy_t *self);

/* Factory exported via dlsym ------------------------------------------------ */
enrichment_strategy_t *toxicity_score_strategy_create(void);

/* -------------------------------------------------------------------------
 * Utility helpers
 * ---------------------------------------------------------------------- */

/* Trim leading/trailing whitespace in-place */
static char *strtrim(char *s)
{
    char *end;
    while (isspace((unsigned char)*s)) s++;
    if (*s == '\0') return s;

    end = s + strlen(s) - 1;
    while (end > s && isspace((unsigned char)*end)) end--;
    end[1] = '\0';
    return s;
}

/* Tokenise a UTF-8 string into lower-case ASCII words.
 * Returns pointer to heap-allocated array of char*, plus count via out_cnt.
 * Caller must free each element and the array itself.
 */
static char **tokenise(const char *text, size_t *out_cnt)
{
    if (!text || !out_cnt) return NULL;

    /* Rough upper bound: worst case every other char is a delimiter. */
    size_t cap = strlen(text) / 2 + 1;
    char **tokens = calloc(cap, sizeof(char *));
    if (!tokens) return NULL;

    size_t cnt = 0;
    const char *start = text;
    const char *p      = text;

    while (1) {
        if (*p == '\0' || !isalpha((unsigned char)*p)) {
            if (p > start) {
                size_t len = (size_t)(p - start);
                char *tok  = strndup(start, len);
                if (!tok) goto oom;

                /* To lower-case */
                for (size_t i = 0; i < len; ++i)
                    tok[i] = (char)tolower((unsigned char)tok[i]);

                if (cnt == cap) { /* grow */
                    cap *= 2;
                    char **tmp = realloc(tokens, cap * sizeof(char *));
                    if (!tmp) {
                        free(tok);
                        goto oom;
                    }
                    tokens = tmp;
                }
                tokens[cnt++] = tok;
            }
            start = p + 1;
        }
        if (*p == '\0')
            break;
        p++;
    }
    *out_cnt = cnt;
    return tokens;

oom:
    for (size_t i = 0; i < cnt; ++i) free(tokens[i]);
    free(tokens);
    *out_cnt = 0;
    return NULL;
}

/* Logistic activation */
static inline double logistic(double x)
{
    /* guard against overflow */
    if (x >  50.0) return 1.0;
    if (x < -50.0) return 0.0;
    return 1.0 / (1.0 + exp(-x));
}

/* -------------------------------------------------------------------------
 * Lexicon loading / reloading
 * ---------------------------------------------------------------------- */

static void lexicon_free(toxicity_lexicon_entry_t **root)
{
    toxicity_lexicon_entry_t *cur, *tmp;
    HASH_ITER(hh, *root, cur, tmp) {
        HASH_DEL(*root, cur);
        free(cur->token);
        free(cur);
    }
    *root = NULL;
}

static int lexicon_load(const char *path, toxicity_lexicon_entry_t **out_root)
{
    FILE *fp = fopen(path, "r");
    if (!fp) {
        PS_LOG_ERROR("toxicity_score", "Failed to open lexicon file '%s': %s",
                     path, strerror(errno));
        return -1;
    }

    char *line   = NULL;
    size_t len   = 0;
    ssize_t read;
    size_t lineno = 0;
    toxicity_lexicon_entry_t *root = NULL;

    while ((read = getline(&line, &len, fp)) != -1) {
        lineno++;
        if (read == 0) continue;

        /* Remove newline */
        if (line[read - 1] == '\n') line[read - 1] = '\0';

        char *token   = strtok(line, ",");
        char *weightS = strtok(NULL, ",");

        if (!token || !weightS) {
            PS_LOG_WARN("toxicity_score",
                        "Malformed line %zu in lexicon file – skipping", lineno);
            continue;
        }

        token   = strtrim(token);
        weightS = strtrim(weightS);

        double weight = strtod(weightS, NULL);

        toxicity_lexicon_entry_t *e = calloc(1, sizeof(*e));
        if (!e) goto oom;
        e->token  = strdup(token);
        e->weight = weight;
        HASH_ADD_KEYPTR(hh, root, e->token, strlen(e->token), e);
    }

    free(line);
    fclose(fp);

    *out_root = root;
    PS_LOG_INFO("toxicity_score", "Loaded %u lexicon entries from '%s'",
                (unsigned int)HASH_COUNT(root), path);
    return 0;

oom:
    free(line);
    fclose(fp);
    lexicon_free(&root);
    PS_LOG_ERROR("toxicity_score", "Out of memory while loading lexicon");
    return -1;
}

/* -------------------------------------------------------------------------
 * Strategy callbacks
 * ---------------------------------------------------------------------- */

static int toxicity_init(enrichment_strategy_t *self, const char *config_file)
{
    if (!self) return -1;

    toxicity_priv_t *priv = calloc(1, sizeof(*priv));
    if (!priv) return -1;

    priv->threshold   = 0.7;                    /* default */
    priv->config_path = strdup(config_file);    /* may be NULL; allowed */

    pthread_rwlock_init(&priv->lock, NULL);

    /* Load lexicon */
    const char *path = config_file ? config_file : "./toxicity_lexicon.csv";
    if (lexicon_load(path, &priv->lexicon) != 0) {
        PS_LOG_ERROR("toxicity_score", "Initial lexicon load failed");
        pthread_rwlock_destroy(&priv->lock);
        free(priv->config_path);
        free(priv);
        return -1;
    }

    self->priv = priv;
    return 0;
}

static int toxicity_process(enrichment_strategy_t        *self,
                            const social_event_t         *event,
                            enriched_event_t             *out)
{
    if (!self || !event || !out) return -1;
    toxicity_priv_t *priv = (toxicity_priv_t *)self->priv;
    if (!priv) return -1;

    /* Tokenise */
    size_t tok_cnt = 0;
    char **tokens  = tokenise(event->content, &tok_cnt);
    if (!tokens && tok_cnt > 0)
        return -1; /* OOM */

    /* Calculate raw score */
    double sum = 0.0;

    pthread_rwlock_rdlock(&priv->lock);
    for (size_t i = 0; i < tok_cnt; ++i) {
        toxicity_lexicon_entry_t *entry = NULL;
        HASH_FIND_STR(priv->lexicon, tokens[i], entry);
        if (entry)
            sum += entry->weight;
    }

    double prob = logistic(sum);
    int    flag = prob >= priv->threshold;
    pthread_rwlock_unlock(&priv->lock);

    /* Populate enrichment result */
    out->toxicity_score = prob;
    out->is_toxic       = flag;

    for (size_t i = 0; i < tok_cnt; ++i) free(tokens[i]);
    free(tokens);
    return 0;
}

static void toxicity_destroy(enrichment_strategy_t *self)
{
    if (!self) return;
    toxicity_priv_t *priv = (toxicity_priv_t *)self->priv;
    if (!priv) return;

    pthread_rwlock_wrlock(&priv->lock);
    lexicon_free(&priv->lexicon);
    pthread_rwlock_unlock(&priv->lock);

    pthread_rwlock_destroy(&priv->lock);
    free(priv->config_path);
    free(priv);
    self->priv = NULL;
}

/* -------------------------------------------------------------------------
 * Factory
 * ---------------------------------------------------------------------- */

enrichment_strategy_t *toxicity_score_strategy_create(void)
{
    enrichment_strategy_t *strategy = calloc(1, sizeof(*strategy));
    if (!strategy)
        return NULL;

    strategy->name    = "toxicity_score";
    strategy->init    = toxicity_init;
    strategy->process = toxicity_process;
    strategy->destroy = toxicity_destroy;
    strategy->priv    = NULL;
    return strategy;
}
```