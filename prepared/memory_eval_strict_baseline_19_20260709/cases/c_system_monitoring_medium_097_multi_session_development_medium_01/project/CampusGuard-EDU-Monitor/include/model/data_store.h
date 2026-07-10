```c
/**
 * @file data_store.h
 * @brief Public interface for the CampusGuard EDU Monitor persistent
 *        data-store (SQLite backed).
 *
 * The DataStore is a façade that wraps a single SQLite connection, enforces
 * schema migrations, tracks prepared statements, and (optionally) serialises
 * access for multi-threaded deployments.  All model-layer code should rely on
 * this API rather than speaking SQL directly.
 *
 * Copyright (c) 2024
 *
 * Permission is hereby granted, free of charge, to any student obtaining a
 * copy of this software and associated documentation files (the “Software”),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *    1. The above copyright notice and this permission notice shall be
 *       included in all copies or substantial portions of the Software.
 *    2. This license is for educational purposes only; commercial use
 *       requires written consent from the author(s).
 *
 * THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND.
 */

#ifndef CG_EDU_MONITOR_MODEL_DATA_STORE_H
#define CG_EDU_MONITOR_MODEL_DATA_STORE_H

#ifdef __cplusplus
extern "C" {
#endif

/* ──────────────────────────────────────────────────────────────────────────
 * Standard / 3rd-party Includes
 * ────────────────────────────────────────────────────────────────────────── */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <time.h>
#include <sqlite3.h>

/* ──────────────────────────────────────────────────────────────────────────
 * Versioning
 * ────────────────────────────────────────────────────────────────────────── */
#define CG_DS_VERSION_MAJOR 1
#define CG_DS_VERSION_MINOR 0
#define CG_DS_VERSION_PATCH 0

/* ──────────────────────────────────────────────────────────────────────────
 * Error Handling
 * ────────────────────────────────────────────────────────────────────────── */
typedef enum
{
    CG_DS_OK = 0,
    CG_DS_ERR_PARAM,
    CG_DS_ERR_NOMEM,
    CG_DS_ERR_DB,
    CG_DS_ERR_NOT_OPEN,
    CG_DS_ERR_IO,
    CG_DS_ERR_SCHEMA,
    CG_DS_ERR_MIGRATION,
    CG_DS_ERR_BUSY,
    CG_DS_ERR_INTERNAL = 0xFFFF
} cg_ds_result_t;

/**
 * Returns a static error string for the supplied result code.
 */
const char *cg_ds_strerror(cg_ds_result_t rc);

/* ──────────────────────────────────────────────────────────────────────────
 * Opaque Types
 * ────────────────────────────────────────────────────────────────────────── */
typedef struct cg_datastore cg_datastore_t;

/* ──────────────────────────────────────────────────────────────────────────
 * Life-cycle Management
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Opens (or creates) a CampusGuard DataStore.
 *
 * @param path           Filesystem path to the SQLite database.  URI query
 *                       parameters are supported.
 * @param bootstrap      If true, create or migrate schema automatically.
 * @param[out] out_ds    Pointer that will receive the created object.
 *
 * @return CG_DS_OK on success, otherwise an error code.
 */
cg_ds_result_t
cg_datastore_open(const char     *path,
                  bool            bootstrap,
                  cg_datastore_t **out_ds);

/**
 * Closes the DataStore instance and releases all resources.
 * After calling, *ds is set to NULL for safety.
 */
void cg_datastore_close(cg_datastore_t **ds);

/* ──────────────────────────────────────────────────────────────────────────
 * Configuration
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Enables or disables serialized threading mode on the underlying connection.
 * Must be invoked prior to multi-threaded use.
 */
cg_ds_result_t
cg_datastore_enable_threading(cg_datastore_t *ds, bool enable);

/**
 * Enables WAL journaling (recommended for concurrent readers).
 */
cg_ds_result_t
cg_datastore_set_wal(cg_datastore_t *ds, bool enable);

/* ──────────────────────────────────────────────────────────────────────────
 * Transaction Helpers
 * ────────────────────────────────────────────────────────────────────────── */
cg_ds_result_t cg_ds_tx_begin(cg_datastore_t *ds);
cg_ds_result_t cg_ds_tx_commit(cg_datastore_t *ds);
cg_ds_result_t cg_ds_tx_rollback(cg_datastore_t *ds);

/* ──────────────────────────────────────────────────────────────────────────
 * Generic SQL Helpers
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Executes an arbitrary non-select SQL statement with positional arguments.
 * @param argc/argv  Bind values for '?' parameters (all passed as UTF-8 text).
 */
cg_ds_result_t
cg_ds_exec(cg_datastore_t *ds,
           const char     *sql,
           int             argc,
           const char     *argv[]);

/**
 * Executes a SELECT and streams each row to the supplied callback.
 *
 * @param cb         Callback invoked per row.  Return non-zero to stop early.
 * @param stopped    Optional out-flag set true when iteration stopped early.
 */
typedef int (*cg_ds_row_cb)(void *user,
                            int   col_cnt,
                            const char *col_vals[],
                            const char *col_names[]);

cg_ds_result_t
cg_ds_select(cg_datastore_t *ds,
             const char     *sql,
             int             argc,
             const char     *argv[],
             cg_ds_row_cb    cb,
             void           *user,
             bool           *stopped /* nullable */);

/* ──────────────────────────────────────────────────────────────────────────
 * Log Aggregation API
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Appends a syslog-style log record.
 */
cg_ds_result_t
cg_ds_log_append(cg_datastore_t *ds,
                 int64_t         ts_epoch_ms,
                 const char     *host,
                 int             facility,
                 int             severity,
                 const char     *message);

/**
 * Streams log records according to the supplied filters.  Any filter may be
 * zero/NULL to act as a wildcard.
 */
cg_ds_result_t
cg_ds_log_query(cg_datastore_t *ds,
                int64_t         ts_start_ms,
                int64_t         ts_end_ms,
                const char     *host,
                int             max_rows,
                cg_ds_row_cb    cb,
                void           *user);

/* ──────────────────────────────────────────────────────────────────────────
 * Metrics (Time-series) API
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Upserts a metric sample.
 */
cg_ds_result_t
cg_ds_metric_upsert(cg_datastore_t *ds,
                    const char     *series,
                    const char     *label_json /* can be NULL */,
                    int64_t         ts_epoch_ms,
                    double          value);

/**
 * Fetches metric samples in [start, end).  Callback receives columns:
 *   ts_epoch_ms | value
 */
cg_ds_result_t
cg_ds_metric_fetch(cg_datastore_t *ds,
                   const char     *series,
                   const char     *label_json /* filter; can be NULL */,
                   int64_t         ts_start_ms,
                   int64_t         ts_end_ms,
                   cg_ds_row_cb    cb,
                   void           *user);

/* ──────────────────────────────────────────────────────────────────────────
 * Alerting API
 * ────────────────────────────────────────────────────────────────────────── */
cg_ds_result_t
cg_ds_alert_insert(cg_datastore_t *ds,
                   int64_t         rule_id,
                   int64_t         ts_epoch_ms,
                   const char     *payload_json);

/* ──────────────────────────────────────────────────────────────────────────
 * House-keeping / Maintenance
 * ────────────────────────────────────────────────────────────────────────── */
typedef struct
{
    bool     vacuum_performed;
    uint64_t logs_pruned;
    uint64_t metrics_pruned;
    uint64_t duration_ms;
} cg_ds_maintenance_stats_t;

cg_ds_result_t
cg_ds_perform_maintenance(cg_datastore_t            *ds,
                          uint32_t                   retention_days_logs,
                          uint32_t                   retention_days_metrics,
                          bool                       vacuum,
                          cg_ds_maintenance_stats_t *out_stats);

/* ──────────────────────────────────────────────────────────────────────────
 * Diagnostics
 * ────────────────────────────────────────────────────────────────────────── */
typedef struct
{
    uint64_t page_count;
    uint64_t page_size;
    uint64_t freelist_count;
    uint64_t db_size_bytes;
    uint64_t lookaside_used;
} cg_ds_stats_t;

cg_ds_result_t cg_ds_collect_stats(cg_datastore_t *ds, cg_ds_stats_t *out);

/* ──────────────────────────────────────────────────────────────────────────
 * Internal (exposed for unit tests only)
 * ────────────────────────────────────────────────────────────────────────── */
#ifdef CG_DS_UNIT_TEST
cg_ds_result_t cg_ds__apply_migrations(cg_datastore_t *ds);
#endif

#ifdef __cplusplus
}
#endif

#endif /* CG_EDU_MONITOR_MODEL_DATA_STORE_H */
```